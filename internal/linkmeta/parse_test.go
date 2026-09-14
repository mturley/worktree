package linkmeta

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func parse(t *testing.T, baseStr, html string) Meta {
	t.Helper()
	base, err := url.Parse(baseStr)
	if err != nil {
		t.Fatal(err)
	}
	return ParseHead(strings.NewReader(html), base)
}

func TestParseHeadPrefersOpenGraph(t *testing.T) {
	m := parse(t, "https://ex.com/a", `<html><head>
		<title>HTML title</title>
		<meta property="og:title" content="OG title">
		<meta name="description" content="html desc">
		<meta property="og:description" content="og desc">
		<meta property="og:site_name" content="Example">
		<meta property="og:image" content="/img/hero.png">
	</head></html>`)
	if m.Title != "OG title" || m.Description != "og desc" || m.SiteName != "Example" {
		t.Fatalf("%+v", m)
	}
	// Relative og:image is resolved against the page URL.
	if m.Image != "https://ex.com/img/hero.png" {
		t.Fatalf("image = %q", m.Image)
	}
}

func TestParseHeadFallsBackToTitleAndMetaDescription(t *testing.T) {
	m := parse(t, "https://ex.com/a", `<html><head>
		<title>  HTML title  </title>
		<meta name="description" content="html desc">
	</head></html>`)
	if m.Title != "HTML title" || m.Description != "html desc" {
		t.Fatalf("%+v", m)
	}
}

func TestParseHeadFaviconPreference(t *testing.T) {
	m := parse(t, "https://ex.com/a/b", `<html><head>
		<link rel="apple-touch-icon" href="/apple.png">
		<link rel="icon" href="favicon.png">
	</head></html>`)
	// rel="icon" wins over apple-touch-icon, and a relative href resolves
	// against the page URL, not the origin.
	if m.Favicon != "https://ex.com/a/favicon.png" {
		t.Fatalf("favicon = %q", m.Favicon)
	}
}

func TestParseHeadFaviconDefaultsToOriginRoot(t *testing.T) {
	m := parse(t, "https://ex.com/deep/page", `<html><head><title>t</title></head></html>`)
	if m.Favicon != "https://ex.com/favicon.ico" {
		t.Fatalf("favicon = %q", m.Favicon)
	}
}

func TestParseHeadHandlesNoHeadAtAll(t *testing.T) {
	m := parse(t, "https://ex.com/a", `<html><body>hi</body></html>`)
	if m.Title != "" || m.Description != "" {
		t.Fatalf("%+v", m)
	}
}

func TestParseHeadHandlesTruncatedDocument(t *testing.T) {
	// A body cut at the read cap can end mid-tag. Whatever was complete is
	// kept; the truncation is not an error.
	m := parse(t, "https://ex.com/a", `<html><head><title>Kept</title><meta property="og:desc`)
	if m.Title != "Kept" {
		t.Fatalf("title = %q", m.Title)
	}
}

func TestEmbeddable(t *testing.T) {
	cases := []struct {
		name  string
		h     http.Header
		want  bool
	}{
		{"no headers", http.Header{}, true},
		{"xfo deny", http.Header{"X-Frame-Options": {"DENY"}}, false},
		{"xfo sameorigin lowercase", http.Header{"X-Frame-Options": {"sameorigin"}}, false},
		{"csp frame-ancestors none", http.Header{"Content-Security-Policy": {"default-src 'self'; frame-ancestors 'none'"}}, false},
		{"csp frame-ancestors self", http.Header{"Content-Security-Policy": {"frame-ancestors 'self'"}}, false},
		{"csp frame-ancestors wildcard", http.Header{"Content-Security-Policy": {"frame-ancestors *"}}, true},
		{"csp without frame-ancestors", http.Header{"Content-Security-Policy": {"default-src 'self'"}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Embeddable(tc.h); got != tc.want {
				t.Fatalf("Embeddable() = %v, want %v", got, tc.want)
			}
		})
	}
}
