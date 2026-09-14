package linkmeta

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/safehttp"
)

// A resolver whose transport trusts the test server. Parsing tests need this
// because httptest listens on 127.0.0.1, which the real dialer refuses — by
// design. Security tests below deliberately use the REAL transport.
func testResolver(ts *httptest.Server) *Resolver {
	return &Resolver{Transport: ts.Client().Transport}
}

func TestResolveReadsMetadata(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<html><head><title>A page</title></head></html>`)
	}))
	defer ts.Close()
	m := testResolver(ts).Resolve(context.Background(), ts.URL)
	if m.Title != "A page" || m.ResolveError != "" || !m.Embeddable {
		t.Fatalf("%+v", m)
	}
	if m.ResolvedAt == "" {
		t.Fatal("ResolvedAt must be stamped")
	}
}

func TestResolveRecordsNonEmbeddable(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<html><head><title>t</title></head></html>`)
	}))
	defer ts.Close()
	if testResolver(ts).Resolve(context.Background(), ts.URL).Embeddable {
		t.Fatal("X-Frame-Options: DENY must mark the page non-embeddable")
	}
}

func TestResolveResolvesRelativeAgainstFinalURL(t *testing.T) {
	var final *httptest.Server
	final = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<html><head><link rel="icon" href="/i.png"></head></html>`)
	}))
	defer final.Close()
	start := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL, http.StatusFound)
	}))
	defer start.Close()
	m := (&Resolver{Transport: start.Client().Transport}).Resolve(context.Background(), start.URL)
	if m.Favicon != final.URL+"/i.png" {
		t.Fatalf("favicon = %q, want it resolved against the FINAL url", m.Favicon)
	}
}

func TestResolveNonHTMLUsesLastPathSegment(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		io.WriteString(w, "%PDF-1.4")
	}))
	defer ts.Close()
	m := testResolver(ts).Resolve(context.Background(), ts.URL+"/docs/spec.pdf")
	if m.Title != "spec.pdf" {
		t.Fatalf("title = %q", m.Title)
	}
}

func TestResolveTruncatesAnOversizedBody(t *testing.T) {
	// The <title> is first on the wire, so ParseHead would find "Kept" with
	// or without the io.LimitReader — deleting maxBodyBytes entirely would
	// not fail a test that merely writes a big body and checks the title.
	// Instead, prove the CAP is what ends the read: write the head, flush it
	// to the client, then block forever. With the cap in place, the reader
	// hits EOF (from the limit) promptly; without it, the read would only
	// ever end via the unrelated 10s fetchTimeout.
	block := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<html><head><title>Kept</title>`)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		io.WriteString(w, strings.Repeat("<p>padding</p>", (maxBodyBytes/len("<p>padding</p>"))+10))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-block // hang so the read only ends via the LimitReader's cap
	}))

	start := time.Now()
	m := testResolver(ts).Resolve(context.Background(), ts.URL)
	elapsed := time.Since(start)

	// Unblock the handler goroutine and let httptest.Server tear the
	// connection down BEFORE calling ts.Close(), which otherwise blocks
	// waiting for that still-active connection to finish — a deadlock if the
	// channel were closed via `defer` (LIFO order would run ts.Close() first).
	close(block)
	ts.Close()

	if m.Title != "Kept" {
		t.Fatalf("title = %q; a capped read must still yield what was complete", m.Title)
	}
	// The cap must end the read almost immediately. If it took anywhere near
	// fetchTimeout, the LimitReader wasn't what stopped it.
	if elapsed > 3*time.Second {
		t.Fatalf("took %s; the body cap should end the read almost instantly, not via fetchTimeout", elapsed)
	}
}

func TestResolveFailureIsNotAnError(t *testing.T) {
	m := (&Resolver{}).Resolve(context.Background(), "https://no-such-host.invalid/x")
	if m.ResolveError == "" {
		t.Fatal("a failure must be recorded")
	}
	if m.Embeddable {
		t.Fatal("an unresolvable page must not be reported as embeddable")
	}
}

// --- security ---

func TestResolveRefusesLoopbackTarget(t *testing.T) {
	// The REAL transport: no override, so the safe dialer applies.
	//
	// Assert on the safe dialer's OWN error text ("blocked address"), not
	// just "some error": nothing listens on 127.0.0.1:9, so with the safe
	// dialer removed entirely the dial still fails (ECONNREFUSED) and
	// ResolveError is still non-empty — a bare non-empty check would pass
	// either way.
	m := (&Resolver{}).Resolve(context.Background(), "http://127.0.0.1:9/x")
	if !strings.Contains(m.ResolveError, "blocked address") {
		t.Fatalf("ResolveError = %q, want it to contain %q", m.ResolveError, "blocked address")
	}
}

// Allows the loopback test server, but sends every other address through the
// REAL safe dialer — so hop 1 reaches httptest and hop 2 hits the genuine
// block. Without this an httptest server (always 127.0.0.1) is refused at
// hop 1 and the test passes for the wrong reason.
func loopbackPlusSafeTransport() *http.Transport {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	safe := safehttp.DialContext(&net.Dialer{})
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if host == "127.0.0.1" || host == "::1" || host == "localhost" {
			return (&net.Dialer{}).DialContext(ctx, network, addr)
		}
		return safe(ctx, network, addr)
	}
	return tr
}

func TestResolveRefusesRedirectToBlockedAddress(t *testing.T) {
	// The bypass this exists to stop: a permitted host that redirects inward.
	for _, target := range []string{"http://10.0.0.1/x", "http://169.254.169.254/latest/meta-data/"} {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target, http.StatusFound)
		}))
		// Transport is overridden to reach the test server, but the redirect
		// hop dials through the real safe dialer too and must still be refused.
		//
		// Assert on the safe dialer's OWN error text ("blocked address"), not
		// just "some error": a fully permissive transport (no safe dialer)
		// also produces a non-empty ResolveError here in this sandboxed test
		// environment, because 10.0.0.1 / 169.254.169.254 are simply
		// unreachable and the call times out (~20s, "context deadline
		// exceeded") — that would satisfy a bare non-empty check without the
		// per-hop block ever running. The real guard fails fast (~0s) with
		// "blocked address ...".
		m := (&Resolver{Transport: loopbackPlusSafeTransport()}).Resolve(context.Background(), ts.URL)
		if !strings.Contains(m.ResolveError, "blocked address") {
			t.Fatalf("ResolveError = %q, want it to contain %q", m.ResolveError, "blocked address")
		}
		ts.Close()
	}
}

func TestResolveRefusesRedirectToForeignScheme(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", "file:///etc/passwd")
		w.WriteHeader(http.StatusFound)
	}))
	defer ts.Close()
	// Assert on OUR guard's own error text, not just "some error" — stdlib's
	// net/http also refuses to dispatch a "file" scheme on its own, which
	// would satisfy a bare non-empty check even with our guard removed.
	m := (&Resolver{Transport: ts.Client().Transport}).Resolve(context.Background(), ts.URL)
	if !strings.Contains(m.ResolveError, "refusing redirect to scheme") {
		t.Fatalf("ResolveError = %q, want it to contain %q", m.ResolveError, "refusing redirect to scheme")
	}
}

func TestResolveCapsRedirectChain(t *testing.T) {
	var ts *httptest.Server
	ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, ts.URL+"/next", http.StatusFound)
	}))
	defer ts.Close()
	start := time.Now()
	m := (&Resolver{Transport: ts.Client().Transport}).Resolve(context.Background(), ts.URL)
	elapsed := time.Since(start)
	// Assert on OUR maxRedirects error text, not just "some error" — an
	// unbounded redirect loop would otherwise still fail (eventually) via the
	// unrelated 10s fetchTimeout, which proves nothing about the cap.
	if !strings.Contains(m.ResolveError, "too many redirects") {
		t.Fatalf("ResolveError = %q, want it to contain %q", m.ResolveError, "too many redirects")
	}
	// The cap must trip almost immediately. If it took anywhere near
	// fetchTimeout, the guard wasn't what stopped it.
	if elapsed > 3*time.Second {
		t.Fatalf("took %s to fail; the redirect cap should trip almost instantly, not via fetchTimeout", elapsed)
	}
}

func TestResolveSendsNoCredentials(t *testing.T) {
	var mu sync.Mutex
	var gotCookie, gotAuth string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotCookie, gotAuth = r.Header.Get("Cookie"), r.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Set-Cookie", "session=abc; Path=/")
		http.Redirect(w, r, "/second", http.StatusFound)
	}))
	testResolver(ts).Resolve(context.Background(), ts.URL)
	ts.Close() // ensures the handler goroutine(s) are done before we read below
	mu.Lock()
	defer mu.Unlock()
	if gotCookie != "" || gotAuth != "" {
		t.Fatalf("credentials leaked: cookie=%q auth=%q", gotCookie, gotAuth)
	}
}
