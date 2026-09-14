package linkmeta

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/safehttp"
)

const (
	// maxBodyBytes caps the HTML we read. The <head> is all that matters and
	// it is near the top; anything past this is padding.
	maxBodyBytes = 1 << 20 // 1 MiB
	// maxRedirects is below Go's default of 10. A legitimate page does not
	// need five hops.
	maxRedirects = 5
	fetchTimeout = 10 * time.Second
)

// Resolver fetches and parses link metadata.
//
// Transport is a seam for tests ONLY: httptest listens on 127.0.0.1, which
// the safe dialer refuses by design, so parsing tests must supply the test
// server's transport. Production code leaves it nil and gets safehttp's.
type Resolver struct {
	Transport http.RoundTripper
}

func (rs *Resolver) client() *http.Client {
	tr := rs.Transport
	if tr == nil {
		tr = safehttp.Transport()
	}
	return &http.Client{
		Transport: tr,
		// No Jar: a link fetch carries no credentials, ever.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("too many redirects (>%d)", maxRedirects)
			}
			// The dialer sees IPs and ports, never schemes, so the scheme
			// check has nowhere else to live. Each hop is re-validated.
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return fmt.Errorf("refusing redirect to scheme %q", req.URL.Scheme)
			}
			if req.URL.Hostname() == "" {
				return fmt.Errorf("refusing redirect with no host")
			}
			return nil
		},
	}
}

// Resolve fetches rawURL and returns what it could learn. It never returns an
// error: a page that cannot be resolved is still a link, and the failure is
// recorded in Meta.ResolveError for display.
func (rs *Resolver) Resolve(ctx context.Context, rawURL string) Meta {
	now := time.Now().UTC().Format(time.RFC3339)
	fail := func(err error) Meta {
		// Embeddable stays false: an unresolved page must never be offered to
		// an iframe on the strength of a guess.
		return Meta{ResolvedAt: now, ResolveError: err.Error()}
	}

	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fail(err)
	}
	req.Header.Set("User-Agent", "worktree-link-preview/1.0")

	resp, err := rs.client().Do(req)
	if err != nil {
		return fail(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fail(fmt.Errorf("status %d", resp.StatusCode))
	}

	final := resp.Request.URL // after redirects
	embeddable := Embeddable(resp.Header)

	if !strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/html") {
		// A PDF or an image has no <head>; name it by its last path segment.
		return Meta{
			Title:      path.Base(final.Path),
			SiteName:   final.Hostname(),
			Favicon:    final.ResolveReference(&url.URL{Path: "/favicon.ico"}).String(),
			Embeddable: embeddable,
			ResolvedAt: now,
		}
	}

	m := ParseHead(io.LimitReader(resp.Body, maxBodyBytes), final)
	m.Embeddable = embeddable
	m.ResolvedAt = now
	return m
}
