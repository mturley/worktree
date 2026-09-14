// Package linkmeta resolves the display metadata for a followed web page:
// its title, description, favicon, preview image, and whether it permits
// being rendered in an iframe.
package linkmeta

import (
	"io"
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

// Meta is what a link resource shows. Every field is best-effort: a page that
// cannot be fetched or parsed still becomes a resource, with ResolveError set
// and the URL standing in for the title.
type Meta struct {
	Title        string `json:"title,omitempty"`
	Description  string `json:"description,omitempty"`
	Image        string `json:"image,omitempty"`
	SiteName     string `json:"site_name,omitempty"`
	Favicon      string `json:"favicon,omitempty"`
	Embeddable   bool   `json:"embeddable"`
	ResolvedAt   string `json:"resolved_at,omitempty"`
	ResolveError string `json:"resolve_error,omitempty"`
}

// ParseHead extracts Meta from an HTML document. base is the FINAL response
// URL — relative hrefs must resolve against where the document actually came
// from, not where the request was aimed, or a cross-origin redirect yields
// broken icon paths.
//
// Embeddable is not set here; it comes from response headers (see Embeddable).
func ParseHead(r io.Reader, base *url.URL) Meta {
	var m Meta
	var ogTitle, htmlTitle, ogDesc, metaDesc, iconHref, appleHref string

	z := html.NewTokenizer(r)
	for {
		switch z.Next() {
		case html.ErrorToken:
			// io.EOF or a truncated document alike: keep what we have.
			return assemble(m, base, ogTitle, htmlTitle, ogDesc, metaDesc, iconHref, appleHref)
		case html.StartTagToken, html.SelfClosingTagToken:
			t := z.Token()
			switch t.Data {
			case "title":
				if z.Next() == html.TextToken {
					htmlTitle = strings.TrimSpace(z.Token().Data)
				}
			case "meta":
				prop, name, content := attr(t, "property"), attr(t, "name"), attr(t, "content")
				switch {
				case prop == "og:title":
					ogTitle = content
				case prop == "og:description":
					ogDesc = content
				case prop == "og:image":
					m.Image = content
				case prop == "og:site_name":
					m.SiteName = content
				case strings.EqualFold(name, "description"):
					metaDesc = content
				}
			case "link":
				rel := strings.ToLower(attr(t, "rel"))
				switch rel {
				case "icon", "shortcut icon":
					if iconHref == "" {
						iconHref = attr(t, "href")
					}
				case "apple-touch-icon":
					if appleHref == "" {
						appleHref = attr(t, "href")
					}
				}
			}
		case html.EndTagToken:
			if z.Token().Data == "head" {
				return assemble(m, base, ogTitle, htmlTitle, ogDesc, metaDesc, iconHref, appleHref)
			}
		}
	}
}

func assemble(m Meta, base *url.URL, ogTitle, htmlTitle, ogDesc, metaDesc, iconHref, appleHref string) Meta {
	m.Title = firstNonEmpty(ogTitle, htmlTitle)
	m.Description = firstNonEmpty(ogDesc, metaDesc)
	if m.SiteName == "" {
		m.SiteName = base.Hostname()
	}
	m.Image = absolute(base, m.Image)
	// rel="icon" beats apple-touch-icon; /favicon.ico on the origin is the
	// last resort, and is what browsers themselves fall back to.
	icon := firstNonEmpty(iconHref, appleHref)
	if icon == "" {
		m.Favicon = base.ResolveReference(&url.URL{Path: "/favicon.ico"}).String()
	} else {
		m.Favicon = absolute(base, icon)
	}
	return m
}

func absolute(base *url.URL, ref string) string {
	if ref == "" {
		return ""
	}
	u, err := url.Parse(ref)
	if err != nil {
		return ""
	}
	return base.ResolveReference(u).String()
}

func attr(t html.Token, key string) string {
	for _, a := range t.Attr {
		if strings.EqualFold(a.Key, key) {
			return strings.TrimSpace(a.Val)
		}
	}
	return ""
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// Embeddable reports whether a response's headers permit rendering it in an
// iframe on another origin.
//
// This is read server-side because a BLOCKED IFRAME CANNOT BE DETECTED FROM
// JAVASCRIPT: the load event fires either way and the frame's document is
// cross-origin and unreadable. Without this the UI could only show a blank
// rectangle; with it, it can say why.
func Embeddable(h http.Header) bool {
	switch strings.ToLower(strings.TrimSpace(h.Get("X-Frame-Options"))) {
	case "deny", "sameorigin":
		return false
	}
	// Browsers intersect all CSP headers: if ANY of them forbids framing, the
	// page is not embeddable. We must check every header, not just the first.
	for _, csp := range h.Values("Content-Security-Policy") {
		for _, directive := range strings.Split(csp, ";") {
			fields := strings.Fields(strings.TrimSpace(directive))
			if len(fields) == 0 || !strings.EqualFold(fields[0], "frame-ancestors") {
				continue
			}
			// A bare wildcard permits any embedder. Anything else — 'none',
			// 'self', or a host list we are certainly not on — does not.
			hasWildcard := false
			for _, src := range fields[1:] {
				if src == "*" {
					hasWildcard = true
					break
				}
			}
			if !hasWildcard {
				return false
			}
		}
	}
	return true
}
