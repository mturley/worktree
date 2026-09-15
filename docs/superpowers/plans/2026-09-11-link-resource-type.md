# Link Resource Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow any non-GitHub/Jira/Slack URL as a `link` resource, resolving its title, favicon and OpenGraph metadata once on add, and rendering the page in an iframe where the activity feed would be.

**Architecture:** A new leaf package `internal/linkmeta` fetches and parses a URL's `<head>`, using an SSRF-safe HTTP client extracted from the existing image proxy into `internal/safehttp`. Resolved metadata is stored in the existing `watcher_resource_state` cache keyed by `("link", id)`, so the read path is one new `case` in `enrichResourceDTO`. Nothing polls a link: `pollAll` dispatches per type by name, so a type it never names is never polled.

**Tech Stack:** Go 1.22 (stdlib `net/http`, `golang.org/x/net/html`, `database/sql`), React 19 + Mantine 7 + TanStack Query 5, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-10-link-resource-type-design.md`

## Global Constraints

- **The ID of a link is its normalized URL**: scheme and host lowercased, a default port for the scheme removed, fragment stripped, path and query preserved exactly including a trailing slash. No query-parameter sorting or stripping.
- **`resourceurl.Infer` must not change behaviour.** The link fallback lives in a new `InferAny`. Existing callers keep rejecting unrecognised input.
- **A link is never polled and never produces an event.** Do not add `"link"` to `pollAll`, and do not emit `watch_started` or any other event for one.
- **The address blocklist is the only SSRF containment.** Never reimplement, copy, or weaken `isDisallowedIP`/`safeDialContext`; never replace the per-hop dialer check with a pre-flight lookup of the originally requested host.
- **Redirect chains are capped at 5 hops**, and every hop's scheme is re-validated as `http` or `https`.
- **No credentials on outbound fetches**: no cookie jar, no `Authorization`, no forwarded request headers.
- **Exact user-facing copy:** the open button reads `Open in new tab`; the non-embeddable panel's heading reads `Can't embed page`.
- **iframe attributes are exactly** `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"` and `referrerpolicy="no-referrer"`. `allow-top-navigation` and `allow-downloads` are deliberately absent.
- **A link whose origin equals the UI's own origin never renders an iframe**, regardless of `embeddable`. This is the rule that makes `allow-same-origin` safe.
- Commit with `--signoff`. Add files by name; never `git add -A` or `git add .`.
- Go tests: `go test ./...` from the repo root. Frontend tests: `npx vitest run` from `ui/`.

---

## File Structure

**Created:**
- `internal/safehttp/safehttp.go` — the SSRF-safe dialer and address predicate, moved verbatim from `internal/webui/image_proxy.go`. One implementation, shared by the image proxy and link resolution.
- `internal/safehttp/safehttp_test.go` — the moved tests.
- `internal/linkmeta/linkmeta.go` — `Resolve`: fetch with redirect policy, then parse.
- `internal/linkmeta/parse.go` — pure `<head>` parsing and framing-header interpretation.
- `internal/linkmeta/linkmeta_test.go`, `internal/linkmeta/parse_test.go`
- `internal/webui/link_api.go` — `POST /api/resource-resolve`, `GET /api/resource-type`.
- `internal/webui/middleware.go` — content-type and cross-site request guards.
- `ui/src/components/LinkPane.tsx` — the detail body for a link.
- `ui/src/lib/linkEmbed.ts` — `canEmbed(url, embeddable, currentOrigin)`, the same-origin guard.

**Modified:**
- `internal/resourceurl/resourceurl.go` — add `NormalizeLinkURL` and `InferAny`.
- `internal/webui/image_proxy.go` — delegate to `internal/safehttp`.
- `internal/webui/resources_api.go` — `resourceDTO` link fields; `enrichResourceDTO` link case.
- `internal/webui/resource_mutate_api.go` — `handleAddResource` uses `InferAny`, resolves links inline, and does not `pollOne` a link.
- `internal/webui/server.go` — register the two new routes; wrap mutating routes in the middlewares.
- `ui/src/api/types.ts`, `ui/src/api/client.ts` — DTO fields and the two new calls.
- `ui/src/lib/resourceRef.ts` — `link` returns the domain.
- `ui/src/components/ResourceActions.tsx` — `serviceName`/`openLabel` for `link`.
- `ui/src/components/ResourceCard.tsx` — `LinkCardBody`.
- `ui/src/components/ResourceDetailPane.tsx` — render `LinkPane` for a link.
- `ui/src/components/EditResourceDetailsModal.tsx` — `link` supports a custom name.
- `ui/src/components/AddResourceModal.tsx` — classify via the API; delete `isSlackUrl`.
- `docs/web-ui-architecture.md`, `.claude/CLAUDE.md` — document the new packages and routes.

---

## Task 1: Extract the SSRF-safe dialer into `internal/safehttp`

`internal/linkmeta` cannot use `safeDialContext` while it is unexported in package `webui`, and copying SSRF code is how the two copies drift. Move it; change no behaviour.

**Files:**
- Create: `internal/safehttp/safehttp.go`, `internal/safehttp/safehttp_test.go`
- Modify: `internal/webui/image_proxy.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `safehttp.IsDisallowedIP(ip net.IP) bool`, `safehttp.DialContext(base *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error)`, and `safehttp.Transport() *http.Transport` returning a clone of `http.DefaultTransport` with the safe dialer installed.

- [ ] **Step 1: Create the package by moving the code**

`git mv` is not usable here (part of a file). Copy `isDisallowedIP` and `safeDialContext` from `internal/webui/image_proxy.go` into `internal/safehttp/safehttp.go` **verbatim**, renaming them to `IsDisallowedIP` and `DialContext` and keeping every comment. Add:

```go
// Transport returns a clone of http.DefaultTransport with the SSRF-safe
// dialer installed. A clone, never a mutation: http.DefaultTransport is
// process-global and shared with every other caller in the binary.
func Transport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DialContext = DialContext(&net.Dialer{})
	return t
}
```

- [ ] **Step 2: Move the existing tests**

Move every test in `internal/webui/image_proxy_test.go` that exercises `isDisallowedIP` or `safeDialContext` into `internal/safehttp/safehttp_test.go`, renaming the calls. Leave the handler-level tests where they are.

- [ ] **Step 3: Delete the originals and delegate**

In `internal/webui/image_proxy.go`, delete both functions and replace their uses:

```go
base := safehttp.Transport()
transport = base
```

- [ ] **Step 4: Add a test that the predicate rejects a public-looking name resolving to a private IP**

```go
func TestDialContextRejectsPrivateResolution(t *testing.T) {
	d := DialContext(&net.Dialer{})
	// 127.0.0.1 as a literal takes the literal branch; assert it is refused.
	_, err := d(context.Background(), "tcp", "127.0.0.1:80")
	if err == nil {
		t.Fatal("expected loopback to be refused")
	}
}
```

- [ ] **Step 5: Run the full Go suite**

Run: `go test ./...`
Expected: PASS. The image-proxy handler tests must still pass unchanged — that is the check that the move was behaviour-preserving.

- [ ] **Step 6: Commit**

```bash
git add internal/safehttp/safehttp.go internal/safehttp/safehttp_test.go internal/webui/image_proxy.go internal/webui/image_proxy_test.go
git commit --signoff -m "refactor: share the SSRF-safe dialer as internal/safehttp"
```

---

## Task 2: URL normalization and `InferAny`

**Files:**
- Modify: `internal/resourceurl/resourceurl.go`
- Test: `internal/resourceurl/resourceurl_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `resourceurl.NormalizeLinkURL(raw string) (string, bool)` and `resourceurl.InferAny(raw string) (resType, id string, ok bool)`.

- [ ] **Step 1: Write the failing tests**

```go
func TestNormalizeLinkURL(t *testing.T) {
	cases := []struct{ in, want string; ok bool }{
		{"https://Example.COM/Path?q=1", "https://example.com/Path?q=1", true},
		{"https://example.com:443/x", "https://example.com/x", true},
		{"http://example.com:80/x", "http://example.com/x", true},
		{"https://example.com/x#frag", "https://example.com/x", true},
		{"https://example.com/dir/", "https://example.com/dir/", true},
		{"https://example.com:8443/x", "https://example.com:8443/x", true},
		{"ftp://example.com/x", "", false},
		{"/just/a/path", "", false},
		{"", "", false},
		{"https://", "", false},
	}
	for _, tc := range cases {
		got, ok := NormalizeLinkURL(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Fatalf("NormalizeLinkURL(%q) = (%q,%v), want (%q,%v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestInferAnyFallsBackToLink(t *testing.T) {
	typ, id, ok := InferAny("https://Example.com/docs#x")
	if !ok || typ != "link" || id != "https://example.com/docs" {
		t.Fatalf("got (%q,%q,%v)", typ, id, ok)
	}
}

func TestInferAnyPrefersKnownTypes(t *testing.T) {
	typ, id, _ := InferAny("https://github.com/o/r/pull/42")
	if typ != "pr" || id != "o/r#42" {
		t.Fatalf("got (%q,%q)", typ, id)
	}
}

func TestInferAnyRejectsNonURLs(t *testing.T) {
	for _, in := range []string{"./some/path", "file:///etc/passwd", "", "not a url"} {
		if _, _, ok := InferAny(in); ok {
			t.Fatalf("InferAny(%q) should be rejected", in)
		}
	}
}

func TestInferUnchangedByLinkSupport(t *testing.T) {
	// The strict detector must keep rejecting unknown URLs, so that
	// `worktree add ./typo` still errors instead of following a page.
	if _, _, ok := Infer("https://example.com/nope"); ok {
		t.Fatal("Infer must not gain the link fallback")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/resourceurl/`
Expected: FAIL, `undefined: NormalizeLinkURL`.

- [ ] **Step 3: Implement**

```go
// NormalizeLinkURL canonicalises a URL for use as a link resource's ID, so
// that following the same page twice reuses one resource.
//
// Deliberately conservative: it lowercases the scheme and host, drops a
// default port, and strips the fragment (which never reaches the server, so
// two URLs differing only by fragment are the same page). It does NOT touch
// the query — `?id=2` is a different page, and there is no way to know which
// parameters are tracking noise.
func NormalizeLinkURL(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	if u.Hostname() == "" {
		return "", false
	}
	u.Scheme = scheme
	u.Host = strings.ToLower(u.Host)
	if (scheme == "http" && u.Port() == "80") || (scheme == "https" && u.Port() == "443") {
		u.Host = u.Hostname()
	}
	u.Fragment = ""
	u.RawFragment = ""
	return u.String(), true
}

// InferAny is Infer with a fallback: any remaining absolute http(s) URL is a
// `link` resource, identified by its normalized form.
//
// Separate from Infer on purpose. Infer's callers rely on it REJECTING what
// it does not recognise — `worktree add ./typo-path` must stay an error, not
// become a followed page — so the fallback is opt-in per caller.
func InferAny(raw string) (resType, id string, ok bool) {
	if t, i, ok := Infer(raw); ok {
		return t, i, true
	}
	if norm, ok := NormalizeLinkURL(raw); ok {
		return "link", norm, true
	}
	return "", "", false
}
```

- [ ] **Step 4: Run to verify passing**

Run: `go test ./internal/resourceurl/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/resourceurl/resourceurl.go internal/resourceurl/resourceurl_test.go
git commit --signoff -m "feat(resourceurl): identify any other http(s) URL as a link"
```

---

## Task 3: Parse a page's `<head>` and its framing headers

Pure functions, no network. Split from the fetch so the parsing rules are testable without a server and the fetch rules are testable without HTML.

**Files:**
- Create: `internal/linkmeta/parse.go`, `internal/linkmeta/parse_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Meta struct { Title, Description, Image, SiteName, Favicon string; Embeddable bool; ResolveError string }`
  - `linkmeta.ParseHead(r io.Reader, base *url.URL) Meta`
  - `linkmeta.Embeddable(h http.Header) bool`

- [ ] **Step 1: Add the dependency**

```bash
go get golang.org/x/net@latest && go mod tidy
```

- [ ] **Step 2: Write the failing tests**

```go
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
```

- [ ] **Step 3: Run to verify failure**

Run: `go test ./internal/linkmeta/`
Expected: FAIL, `undefined: ParseHead`.

- [ ] **Step 4: Implement `parse.go`**

```go
// Package linkmeta resolves the display metadata for a followed web page:
// its title, description, favicon, preview image, and whether it permits
// being rendered in an iframe.
package linkmeta

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
	for _, csp := range h.Values("Content-Security-Policy") {
		for _, directive := range strings.Split(csp, ";") {
			fields := strings.Fields(strings.TrimSpace(directive))
			if len(fields) == 0 || !strings.EqualFold(fields[0], "frame-ancestors") {
				continue
			}
			// A bare wildcard permits any embedder. Anything else — 'none',
			// 'self', or a host list we are certainly not on — does not.
			for _, src := range fields[1:] {
				if src == "*" {
					return true
				}
			}
			return false
		}
	}
	return true
}
```

- [ ] **Step 5: Run to verify passing**

Run: `go test ./internal/linkmeta/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/linkmeta/parse.go internal/linkmeta/parse_test.go
git commit --signoff -m "feat(linkmeta): parse OpenGraph, title, favicon and framing headers"
```

---

## Task 4: Fetch a URL safely and resolve its metadata

The security-critical task. Every control here is new work: the image proxy refuses redirects outright (`noFollowRedirects`), so none of this path is inherited.

**Files:**
- Create: `internal/linkmeta/linkmeta.go`, `internal/linkmeta/linkmeta_test.go`

**Interfaces:**
- Consumes: `safehttp.Transport()` (Task 1); `ParseHead`, `Embeddable`, `Meta` (Task 3).
- Produces: `linkmeta.Resolver{Transport http.RoundTripper}` and `(*Resolver).Resolve(ctx context.Context, rawURL string) Meta`.

- [ ] **Step 1: Write the failing tests**

```go
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
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<html><head><title>Kept</title>`)
		io.WriteString(w, strings.Repeat("<p>padding</p>", 200000))
	}))
	defer ts.Close()
	m := testResolver(ts).Resolve(context.Background(), ts.URL)
	if m.Title != "Kept" {
		t.Fatalf("title = %q; a capped read must still yield what was complete", m.Title)
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
	m := (&Resolver{}).Resolve(context.Background(), "http://127.0.0.1:9/x")
	if m.ResolveError == "" {
		t.Fatal("loopback must be refused")
	}
}

func TestResolveRefusesRedirectToBlockedAddress(t *testing.T) {
	// The bypass this exists to stop: a permitted host that redirects inward.
	for _, target := range []string{"http://127.0.0.1:9/x", "http://10.0.0.1/x", "http://169.254.169.254/latest/meta-data/"} {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target, http.StatusFound)
		}))
		// Transport is overridden to reach the test server, but the redirect
		// hop dials through it too and must still be refused.
		m := (&Resolver{Transport: safehttp.Transport()}).Resolve(context.Background(), ts.URL)
		if m.ResolveError == "" {
			t.Fatalf("redirect to %s must be refused", target)
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
	if (&Resolver{Transport: ts.Client().Transport}).Resolve(context.Background(), ts.URL).ResolveError == "" {
		t.Fatal("a non-http(s) redirect must be refused")
	}
}

func TestResolveCapsRedirectChain(t *testing.T) {
	var ts *httptest.Server
	ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, ts.URL+"/next", http.StatusFound)
	}))
	defer ts.Close()
	if (&Resolver{Transport: ts.Client().Transport}).Resolve(context.Background(), ts.URL).ResolveError == "" {
		t.Fatal("an endless redirect chain must be refused")
	}
}

func TestResolveSendsNoCredentials(t *testing.T) {
	var gotCookie, gotAuth string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCookie, gotAuth = r.Header.Get("Cookie"), r.Header.Get("Authorization")
		w.Header().Set("Set-Cookie", "session=abc; Path=/")
		http.Redirect(w, r, "/second", http.StatusFound)
	}))
	defer ts.Close()
	testResolver(ts).Resolve(context.Background(), ts.URL)
	if gotCookie != "" || gotAuth != "" {
		t.Fatalf("credentials leaked: cookie=%q auth=%q", gotCookie, gotAuth)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/linkmeta/`
Expected: FAIL, `undefined: Resolver`.

- [ ] **Step 3: Implement `linkmeta.go`**

```go
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
```

- [ ] **Step 4: Run to verify passing**

Run: `go test ./internal/linkmeta/ -v`
Expected: PASS, including every `TestResolveRefuses*`.

- [ ] **Step 5: Prove the redirect guard actually guards**

Temporarily change `CheckRedirect` to `return nil` and re-run. `TestResolveRefusesRedirectToForeignScheme` and `TestResolveCapsRedirectChain` must FAIL. Restore the guard and confirm they pass again. A security test that cannot fail is not a test.

- [ ] **Step 6: Commit**

```bash
git add internal/linkmeta/linkmeta.go internal/linkmeta/linkmeta_test.go
git commit --signoff -m "feat(linkmeta): resolve a URL's metadata behind the SSRF-safe dialer"
```

---

## Task 5: Store and read link metadata through `watcher_resource_state`

**Files:**
- Modify: `internal/webui/resources_api.go`, `ui/src/api/types.ts`
- Create: `internal/webui/link_state.go`
- Test: `internal/webui/link_state_test.go`

**Interfaces:**
- Consumes: `linkmeta.Meta` (Task 3).
- Produces: `(*Server).saveLinkMeta(id string, m linkmeta.Meta) error`; `resourceDTO` gains `Description`, `Image`, `SiteName`, `Favicon`, `Embeddable`, `ResolveError`.

- [ ] **Step 1: Write the failing test**

```go
func TestEnrichLinkDTO(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	srv := &Server{DB: conn}

	if err := srv.saveLinkMeta("https://ex.com/a", linkmeta.Meta{
		Title: "A page", Description: "d", SiteName: "ex.com",
		Favicon: "https://ex.com/favicon.ico", Embeddable: true,
		ResolvedAt: "2026-09-11T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}

	dto := resourceDTO{Type: "link", ID: "https://ex.com/a", URL: "https://ex.com/a"}
	srv.enrichResourceDTO(&dto)
	if dto.Title != "A page" || dto.SiteName != "ex.com" || !dto.Embeddable {
		t.Fatalf("%+v", dto)
	}
}

func TestEnrichLinkDTOSurvivesMalformedState(t *testing.T) {
	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	watcherdb.UpsertResourceState(conn, "link", "x", "{not json", "", "")
	srv := &Server{DB: conn}
	dto := resourceDTO{Type: "link", ID: "x"}
	srv.enrichResourceDTO(&dto) // must not panic
	if dto.Title != "" {
		t.Fatalf("expected empty enrichment, got %+v", dto)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/webui/ -run TestEnrichLink`
Expected: FAIL, `srv.saveLinkMeta undefined`.

- [ ] **Step 3: Implement `link_state.go`**

```go
// saveLinkMeta caches a link's resolved metadata in watcher_resource_state.
//
// worktree writes this row itself rather than a poller writing it, because a
// link has no poller — nothing in pollAll ever names the "link" type. The
// table is a generic (type, id) -> json cache with no per-type schema, so
// this needs no watcher library release. It is the one place worktree writes
// a watcher_* row for a type the library does not know about.
func (s *Server) saveLinkMeta(id string, m linkmeta.Meta) error {
	blob, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return watcherdb.UpsertResourceState(s.DB, "link", id, string(blob), m.ResolvedAt, m.ResolvedAt)
}
```

- [ ] **Step 4: Add the DTO fields and the enrichment case**

In `resources_api.go`, add to `resourceDTO`:

```go
	// link: resolved page metadata (see internal/linkmeta)
	Description  string `json:"description,omitempty"`
	Image        string `json:"image,omitempty"`
	SiteName     string `json:"site_name,omitempty"`
	Favicon      string `json:"favicon,omitempty"`
	Embeddable   bool   `json:"embeddable,omitempty"`
	ResolveError string `json:"resolve_error,omitempty"`
```

and a case in `enrichResourceDTO`'s switch:

```go
	case "link":
		if v, ok := m["title"].(string); ok {
			dto.Title = v
		}
		if v, ok := m["description"].(string); ok {
			dto.Description = v
		}
		if v, ok := m["image"].(string); ok {
			dto.Image = v
		}
		if v, ok := m["site_name"].(string); ok {
			dto.SiteName = v
		}
		if v, ok := m["favicon"].(string); ok {
			dto.Favicon = v
		}
		if v, ok := m["embeddable"].(bool); ok {
			dto.Embeddable = v
		}
		if v, ok := m["resolve_error"].(string); ok {
			dto.ResolveError = v
		}
```

- [ ] **Step 5: Mirror the fields in `ui/src/api/types.ts`**

Add inside `ResourceDTO`:

```ts
  /** link: resolved page metadata. */
  description?: string
  image?: string
  site_name?: string
  favicon?: string
  /** link: whether the page's headers permit rendering it in an iframe. */
  embeddable?: boolean
  resolve_error?: string
```

- [ ] **Step 6: Run to verify passing**

Run: `go test ./internal/webui/ && cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/webui/link_state.go internal/webui/link_state_test.go internal/webui/resources_api.go ui/src/api/types.ts
git commit --signoff -m "feat(webui): cache and expose a link's resolved metadata"
```

---

## Task 6: Add, resolve and re-resolve link resources

**Files:**
- Modify: `internal/webui/resource_mutate_api.go`, `internal/webui/server.go`
- Create: `internal/webui/link_api.go`, `internal/webui/link_api_test.go`

**Interfaces:**
- Consumes: `resourceurl.InferAny` (Task 2), `Resolver.Resolve` (Task 4), `saveLinkMeta` (Task 5).
- Produces: routes `POST /api/resource-resolve` and `GET /api/resource-type`; `Server.LinkResolver *linkmeta.Resolver` (nil means a default).

- [ ] **Step 1: Write the failing tests**

```go
func TestAddResourceFollowsAPlainURL(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<html><head><title>A page</title></head></html>`)
	}))
	defer ts.Close()

	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	wtPath := testgit.Worktree(t)
	srv := &Server{DB: conn, LinkResolver: &linkmeta.Resolver{Transport: ts.Client().Transport}}

	body, _ := json.Marshal(map[string]any{"path": wtPath, "url": ts.URL + "/x#frag"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/worktree-resources/add", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var dto resourceDTO
	json.Unmarshal(rec.Body.Bytes(), &dto)
	if dto.Type != "link" {
		t.Fatalf("type = %q", dto.Type)
	}
	if strings.Contains(dto.ID, "#") {
		t.Fatalf("id must be normalized, got %q", dto.ID)
	}
	// Resolution happens inline, so the card is populated on arrival.
	if dto.Title != "A page" {
		t.Fatalf("title = %q", dto.Title)
	}
}

func TestAddResourceDoesNotPollALink(t *testing.T) {
	// A link has no poller. If one is ever added to pollAll, or pollOne is
	// called for a link, this fails.
	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	wtPath := testgit.Worktree(t)
	srv := &Server{DB: conn, LinkResolver: &linkmeta.Resolver{}}
	resources.Add(conn, wtPath, resources.Resource{Type: "link", ID: "https://ex.com/a", URL: "https://ex.com/a"})

	if err := srv.pollAll(); err != nil {
		t.Fatal(err)
	}
	evs, _ := watcherdb.EventsForResource(conn, "link", "https://ex.com/a")
	if len(evs) != 0 {
		t.Fatalf("a link must produce no events, got %d", len(evs))
	}
}

func TestResourceTypeEndpointClassifies(t *testing.T) {
	srv := &Server{}
	for _, tc := range []struct{ url, want string }{
		{"https://github.com/o/r/pull/42", "pr"},
		{"https://x.atlassian.net/browse/AB-1", "jira"},
		{"https://example.com/docs", "link"},
		{"./nope", ""},
	} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/resource-type?url="+url.QueryEscape(tc.url), nil))
		var got struct{ Type string `json:"type"` }
		json.Unmarshal(rec.Body.Bytes(), &got)
		if got.Type != tc.want {
			t.Fatalf("%s -> %q, want %q", tc.url, got.Type, tc.want)
		}
	}
}

func TestResourceResolveRefusesNonLinkTypes(t *testing.T) {
	conn, _ := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	defer conn.Close()
	srv := &Server{DB: conn}
	body, _ := json.Marshal(map[string]string{"type": "pr", "id": "o/r#1"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/resource-resolve", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", rec.Code)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/webui/ -run 'TestAddResourceFollows|TestResourceType|TestResourceResolve'`
Expected: FAIL.

- [ ] **Step 3: Implement `link_api.go`**

```go
// linkResolver returns the configured resolver, or a default one. A seam for
// tests, mirroring imageProxyTransport.
func (s *Server) linkResolver() *linkmeta.Resolver {
	if s.LinkResolver != nil {
		return s.LinkResolver
	}
	return &linkmeta.Resolver{}
}

// resolveAndStoreLink fetches a link's metadata and caches it. Best effort:
// a resolution failure is recorded in the cached blob, never returned as an
// API error, because an unreachable page is still a resource worth following.
func (s *Server) resolveAndStoreLink(ctx context.Context, id string) {
	m := s.linkResolver().Resolve(ctx, id)
	if err := s.saveLinkMeta(id, m); err != nil && s.Logger != nil {
		s.Logger.Printf("saveLinkMeta(%s): %v", id, err)
	}
}

type resolveRequest struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// handleResourceResolve re-resolves a link on demand. This is the whole
// refresh story for links: they are never polled, so the only way metadata
// becomes current again is someone asking.
func (s *Server) handleResourceResolve(w http.ResponseWriter, r *http.Request) {
	var req resolveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Type != "link" {
		writeError(w, http.StatusBadRequest, "only link resources can be resolved")
		return
	}
	if req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing id")
		return
	}
	s.resolveAndStoreLink(r.Context(), req.ID)
	dto := resourceDTO{Type: "link", ID: req.ID, URL: req.ID}
	s.enrichResourceDTO(&dto)
	writeJSON(w, http.StatusOK, dto)
}

// handleResourceType classifies a URL. It exists so the add-resource modal
// can ask the one detector what a URL is, instead of re-implementing the
// patterns in TypeScript — which is the duplication internal/resourceurl was
// created to end. Read-only: no DB write, no outbound request.
func (s *Server) handleResourceType(w http.ResponseWriter, r *http.Request) {
	resType, id, ok := resourceurl.InferAny(r.URL.Query().Get("url"))
	if !ok {
		writeJSON(w, http.StatusOK, map[string]string{"type": "", "id": ""})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"type": resType, "id": id})
}
```

- [ ] **Step 4: Update `handleAddResource`**

Replace the `Infer` call and the unconditional `pollOne`:

```go
	resType, id, ok := resourceurl.InferAny(req.URL)
	if !ok {
		writeError(w, http.StatusBadRequest, "unrecognized resource URL")
		return
	}
	// The stored URL is the normalized ID for a link, so the row and its
	// cache key cannot disagree.
	storedURL := req.URL
	if resType == "link" {
		storedURL = id
	}
	if err := resources.Add(s.DB, req.Path, resources.Resource{Type: resType, ID: id, URL: storedURL, Related: req.Related}); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, resources.ErrNotAWorktree) {
			status = http.StatusBadRequest
		}
		writeError(w, status, err.Error())
		return
	}
	if resType == "link" {
		// Links are never polled; resolving inline is the only way the card
		// is populated when it appears.
		s.resolveAndStoreLink(r.Context(), id)
	} else {
		s.pollOne(watcher.Resource{Type: resType, ID: id, URL: storedURL})
	}

	dto := resourceDTO{Type: resType, ID: id, URL: storedURL, Primary: !req.Related}
```

- [ ] **Step 5: Register the routes and the Server field**

In `server.go`, add to the `Server` struct:

```go
	// LinkResolver is a seam for tests; nil means a default resolver.
	LinkResolver *linkmeta.Resolver
```

and in `registerAPI`:

```go
	mux.HandleFunc("POST /api/resource-resolve", s.handleResourceResolve)
	mux.HandleFunc("GET /api/resource-type", s.handleResourceType)
	// The same open-host image proxy handler as /api/slack-image, under a
	// name that is honest about who is calling it. A link's favicon and
	// preview image are third-party URLs from arbitrary sites, which is
	// exactly what handleImage was built for.
	mux.HandleFunc("GET /api/link-image", s.handleImage)
```

- [ ] **Step 6: Run to verify passing**

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/webui/link_api.go internal/webui/link_api_test.go internal/webui/resource_mutate_api.go internal/webui/server.go
git commit --signoff -m "feat(webui): follow, resolve and classify link resources"
```

---

## Task 7: Request-forgery middlewares

**Files:**
- Create: `internal/webui/middleware.go`, `internal/webui/middleware_test.go`
- Modify: `internal/webui/server.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `guardMutations(h http.Handler) http.Handler`, wrapping the mux in `Handler()`.

- [ ] **Step 1: Write the failing tests**

```go
func TestRejectsBodiedRequestWithoutJSONContentType(t *testing.T) {
	// The drive-by shape: a cross-origin fetch with a simple content type
	// needs no CORS preflight, so the side effect would otherwise land.
	srv := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/worktree-resources/add", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "text/plain")
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status %d, want 415", rec.Code)
	}
}

func TestRejectsCrossSiteRequest(t *testing.T) {
	srv := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/worktree-resources/add", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

func TestRejectsForeignOriginWhenSecFetchSiteAbsent(t *testing.T) {
	srv := &Server{Port: 8475}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/worktree-resources/add", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403", rec.Code)
	}
}

func TestAllowsSameOriginJSONRequest(t *testing.T) {
	srv := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/resource-resolve", strings.NewReader(`{"type":"pr","id":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	srv.Handler().ServeHTTP(rec, req)
	// Reaches the handler, which rejects the type — 400, not 403/415.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want the handler's own 400", rec.Code)
	}
}

func TestGETIsUnaffected(t *testing.T) {
	srv := &Server{}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/resource-type?url=x", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/webui/ -run 'TestRejects|TestAllowsSame|TestGETIsUnaffected'`
Expected: FAIL — requests currently succeed.

- [ ] **Step 3: Implement `middleware.go`**

```go
// guardMutations blocks requests that a page other than our own could have
// CAUSED. It answers a different question from authentication ("who may make
// this call") and is not superseded by it.
//
// Two checks:
//
//  1. A request with a body must declare application/json. A cross-origin
//     caller cannot set that header without triggering a CORS preflight, and
//     this server answers no preflight — so the request never leaves the
//     browser. Without it, a simple-content-type request sails through:
//     unreadable to the attacker, but its side effect still happens.
//  2. Sec-Fetch-Site must not be cross-site, with an Origin comparison as a
//     fallback for clients that do not send it.
//
// GET and HEAD are untouched: they carry no body and must not mutate.
func guardMutations(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			h.ServeHTTP(w, r)
			return
		}
		switch strings.ToLower(r.Header.Get("Sec-Fetch-Site")) {
		case "cross-site", "same-site":
			// same-site is refused too: SameSite cookies ignore the port, so
			// another service on this host is "same-site" but is not us.
			http.Error(w, "cross-site request refused", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !sameOrigin(origin, r) {
			http.Error(w, "cross-origin request refused", http.StatusForbidden)
			return
		}
		ct := r.Header.Get("Content-Type")
		if mt, _, err := mime.ParseMediaType(ct); err != nil || mt != "application/json" {
			http.Error(w, "expected Content-Type: application/json", http.StatusUnsupportedMediaType)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// sameOrigin compares an Origin header against the request's own host.
// Origin includes the port, which is exactly why it is checked alongside
// Sec-Fetch-Site.
func sameOrigin(origin string, r *http.Request) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return u.Host == r.Host
}
```

In `server.go`'s `Handler()`:

```go
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	s.registerAPI(mux)
	if !s.DevMode && s.WebFS != nil {
		mux.HandleFunc("/", s.serveStatic)
	}
	return guardMutations(mux)
}
```

- [ ] **Step 4: Run the whole suite**

Run: `go test ./...`
Expected: PASS. Existing webui tests that POST must now set `Content-Type: application/json` — update any that fail. That churn is the point: it is the same header a browser must send.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/middleware.go internal/webui/middleware_test.go internal/webui/server.go internal/webui/*_test.go
git commit --signoff -m "feat(webui): refuse cross-site and non-JSON mutating requests"
```

---

## Task 8: Frontend — the link's identity on cards

**Files:**
- Modify: `ui/src/lib/resourceRef.ts`, `ui/src/components/ResourceActions.tsx`, `ui/src/components/ResourceCard.tsx`, `ui/src/components/EditResourceDetailsModal.tsx`, `ui/src/api/client.ts`
- Test: `ui/src/lib/resourceRef.test.ts` (create), `ui/src/components/ResourceCard.test.tsx`

**Interfaces:**
- Consumes: the DTO fields from Task 5.
- Produces: `api.resolveResource({type,id})`, `api.resourceType(url)`; `LinkCardBody`.

- [ ] **Step 1: Write the failing tests**

```ts
// ui/src/lib/resourceRef.test.ts
import { describe, it, expect } from "vitest"
import { shortResourceRef } from "./resourceRef"

describe("shortResourceRef for links", () => {
  it("shows the domain where a PR shows its number", () => {
    expect(shortResourceRef("link", "https://developer.mozilla.org/en-US/docs/Web")).toBe("developer.mozilla.org")
  })
  it("drops a leading www.", () => {
    expect(shortResourceRef("link", "https://www.example.com/x")).toBe("example.com")
  })
  it("degrades to empty on an unparseable id rather than throwing", () => {
    expect(shortResourceRef("link", "not a url")).toBe("")
  })
})
```

```tsx
// in ui/src/components/ResourceCard.test.tsx
it("names a link by its domain and title", () => {
  render(<ResourceCard r={{ type: "link", id: "https://ex.com/a", url: "https://ex.com/a",
    primary: true, title: "A page", site_name: "ex.com" } as ResourceDTO} path="/wt" variant="list" />)
  expect(screen.getByText("A page")).toBeInTheDocument()
  expect(screen.getByText("ex.com")).toBeInTheDocument()
})

it("shows a link's favicon through the image proxy, never directly", () => {
  // Direct <img src> to an arbitrary site would make every card a request to
  // that site from our page; the proxy also refuses internal addresses.
  render(<ResourceCard r={{ type: "link", id: "https://ex.com/a", url: "https://ex.com/a",
    primary: true, favicon: "https://ex.com/favicon.ico" } as ResourceDTO} path="/wt" variant="list" />)
  const img = document.querySelector("img") as HTMLImageElement
  expect(img.getAttribute("src")).toBe("/api/link-image?url=" + encodeURIComponent("https://ex.com/favicon.ico"))
})

it("falls back to a glyph when a link has no favicon", () => {
  render(<ResourceCard r={{ type: "link", id: "https://ex.com/a", url: "https://ex.com/a",
    primary: true } as ResourceDTO} path="/wt" variant="list" />)
  expect(screen.getByLabelText("link")).toBeInTheDocument()
  expect(document.querySelector("img")).toBeNull()
})

it("offers 'Open in new tab' for a link", () => {
  render(<ResourceCard r={{ type: "link", id: "https://ex.com/a", url: "https://ex.com/a",
    primary: true } as ResourceDTO} path="/wt" variant="detail" />)
  expect(screen.getByRole("link", { name: "Open in new tab" })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify failure**

Run (from `ui/`): `npx vitest run src/lib/resourceRef.test.ts src/components/ResourceCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`resourceRef.ts` — extend the existing function, keeping its comment accurate:

```ts
  if (type === "jira") return id
  if (type === "link") {
    // A link's id IS its URL, so the readable part is the host. www. carries
    // no information and costs four characters in a narrow column.
    try {
      return new URL(id).hostname.replace(/^www\./, "")
    } catch {
      return ""
    }
  }
  return ""
```

`ResourceActions.tsx` — `serviceName` gains no case (a link has no service), but `openLabel` does:

```ts
export function openLabel(type: string): string {
  // A link goes to an arbitrary page, so there is no service to name — and
  // "Open" alone did not say that it leaves the app.
  if (type === "link") return "Open in new tab"
  const name = serviceName(type)
  if (!name) return "Open"
  return type === "slack" ? `Open in ${name}` : `Open on ${name}`
}
```

`ResourceStatusIcon.tsx` — a link's favicon takes the slot other types give a status glyph, since a link has no status:

```ts
/**
 * A link's favicon is a third-party URL from an arbitrary site, so it goes
 * through the open-host image proxy rather than being loaded directly — the
 * browser then talks only to us, and the proxy refuses internal addresses.
 */
export function linkImageProxy(url: string): string {
  return `/api/link-image?url=${encodeURIComponent(url)}`
}
```

and in `ResourceStatusIcon`, before the other type branches:

```tsx
  if (r.type === "link") {
    // No status to show — a link is never polled, so it has no state. The
    // favicon identifies it instead. A site with no reachable favicon falls
    // back to a neutral glyph rather than a broken image.
    if (r.favicon && !faviconFailed) {
      return (
        <img
          src={linkImageProxy(r.favicon)}
          alt=""
          width={16}
          height={16}
          onError={() => setFaviconFailed(true)}
          style={{ borderRadius: 2, flexShrink: 0 }}
        />
      )
    }
    return <IconWorld size={16} aria-label="link" style={{ flexShrink: 0 }} />
  }
```

Import `IconWorld` from `@tabler/icons-react`, and add `const [faviconFailed, setFaviconFailed] = useState(false)` alongside the existing `useState` in that component.

`ResourceCard.tsx` — add the body and its switch case:

```tsx
function LinkCardBody({ r, variant }: { r: ResourceDTO; variant: ResourceCardVariant }) {
  const label = r.custom_name || r.title || r.id
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="wrap">
        <Badge size="xs" variant="light" color="teal">Link</Badge>
        {/* The domain sits where a PR puts its number and Jira its key. */}
        <Text size="xs" c="dimmed">{shortResourceRef("link", r.id)}</Text>
      </Group>
      <ResourceTitle r={r} label={label} showUnread={false} {...titleProps(variant)} />
      <CustomDescription r={r} />
      {variant === "detail" && r.description && (
        <Text size="xs" c="dimmed" lineClamp={3}>{r.description}</Text>
      )}
    </Stack>
  )
}
```

In the body switch, before the `MinimalRow` default:

```tsx
  ) : r.type === "link" ? (
    <LinkCardBody r={r} variant={variant} />
```

`EditResourceDetailsModal.tsx`:

```ts
  // A PR or Jira issue has a title from its source; a Slack thread has none,
  // and a link's fetched title is often a site's boilerplate — both are worth
  // renaming.
  const supportsCustomName = r.type === "slack" || r.type === "link"
```

`client.ts`:

```ts
  resolveResource: (args: { type: string; id: string }) =>
    fetchJSON<ResourceDTO>("/api/resource-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  resourceType: (url: string) =>
    fetchJSON<{ type: string; id: string }>(`/api/resource-type?url=${encodeURIComponent(url)}`),
```

- [ ] **Step 4: Run to verify passing**

Run (from `ui/`): `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/resourceRef.ts ui/src/lib/resourceRef.test.ts ui/src/components/ResourceActions.tsx ui/src/components/ResourceCard.tsx ui/src/components/ResourceCard.test.tsx ui/src/components/ResourceStatusIcon.tsx ui/src/components/EditResourceDetailsModal.tsx ui/src/api/client.ts
git commit --signoff -m "feat(ui): show a link by its domain, title and Open in new tab"
```

---

## Task 9: Frontend — the embed pane

**Files:**
- Create: `ui/src/lib/linkEmbed.ts`, `ui/src/lib/linkEmbed.test.ts`, `ui/src/components/LinkPane.tsx`, `ui/src/components/LinkPane.test.tsx`
- Modify: `ui/src/components/ResourceDetailPane.tsx`

**Interfaces:**
- Consumes: `ResourceDTO.embeddable`, `api.resolveResource` (Task 8).
- Produces: `canEmbed(url: string, embeddable: boolean | undefined, currentOrigin: string): boolean`; `<LinkPane resource path onRemoved onResourceChanged />`.

- [ ] **Step 1: Write the failing tests**

```ts
// ui/src/lib/linkEmbed.test.ts
import { describe, it, expect } from "vitest"
import { canEmbed } from "./linkEmbed"

describe("canEmbed", () => {
  it("embeds a page whose headers permit it", () => {
    expect(canEmbed("https://ex.com/a", true, "http://127.0.0.1:8475")).toBe(true)
  })
  it("refuses a page whose headers forbid it", () => {
    expect(canEmbed("https://ex.com/a", false, "http://127.0.0.1:8475")).toBe(false)
  })
  it("refuses when embeddability is unknown", () => {
    expect(canEmbed("https://ex.com/a", undefined, "http://127.0.0.1:8475")).toBe(false)
  })
  it("REFUSES OUR OWN ORIGIN even when embeddable says yes", () => {
    // This is the rule that makes sandbox allow-same-origin safe: that flag
    // only permits a sandbox escape when the frame is same-origin with its
    // embedder, and this is what guarantees it never is.
    expect(canEmbed("http://127.0.0.1:8475/worktree/x", true, "http://127.0.0.1:8475")).toBe(false)
  })
  it("refuses an unparseable url", () => {
    expect(canEmbed("not a url", true, "http://127.0.0.1:8475")).toBe(false)
  })
})
```

```tsx
// ui/src/components/LinkPane.test.tsx — key cases
it("frames an embeddable page with the exact sandbox we intend", () => {
  const { container } = wrap(<LinkPane resource={link({ embeddable: true })} path="/wt" />)
  const frame = container.querySelector("iframe") as HTMLIFrameElement
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms allow-popups")
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer")
  // Withheld on purpose: the framed page must not navigate us away or download.
  expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation")
  expect(frame.getAttribute("sandbox")).not.toContain("allow-downloads")
})

it("explains a page that refuses framing instead of showing a blank box", () => {
  wrap(<LinkPane resource={link({ embeddable: false })} path="/wt" />)
  expect(screen.getByText("Can't embed page")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "Open in new tab" })).toBeInTheDocument()
})

it("renders no iframe at all for a page that refuses framing", () => {
  const { container } = wrap(<LinkPane resource={link({ embeddable: false })} path="/wt" />)
  expect(container.querySelector("iframe")).toBeNull()
})

it("shows no activity feed and no unread affordances", () => {
  wrap(<LinkPane resource={link({ embeddable: true })} path="/wt" />)
  expect(screen.queryByText("Activity")).toBeNull()
  expect(screen.queryByRole("button", { name: /mark .* as read/i })).toBeNull()
  expect(screen.queryByRole("button", { name: "Refresh watchers" })).toBeNull()
})

it("offers a refresh that re-resolves the page", async () => {
  resolveResource.mockResolvedValue({})
  wrap(<LinkPane resource={link({ embeddable: true })} path="/wt" />)
  await userEvent.click(screen.getByRole("button", { name: "Refresh page details" }))
  expect(resolveResource).toHaveBeenCalledWith({ type: "link", id: "https://ex.com/a" })
})
```

- [ ] **Step 2: Run to verify failure**

Run (from `ui/`): `npx vitest run src/lib/linkEmbed.test.ts src/components/LinkPane.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `linkEmbed.ts`**

```ts
/**
 * Whether a link may be rendered in an iframe.
 *
 * Two independent reasons to refuse, and the second is a security rule:
 *
 * 1. The page's own headers forbid framing (X-Frame-Options or CSP
 *    frame-ancestors), as recorded server-side at resolution time. A blocked
 *    iframe cannot be detected from JavaScript, so this is the only way to
 *    know. Unknown counts as refused — never frame on a guess.
 * 2. The page is on OUR OWN ORIGIN. The iframe carries
 *    `allow-scripts allow-same-origin`, and that pair lets a framed document
 *    reach `parent` and delete its own sandbox — but only when it is
 *    same-origin with its embedder. This check is what guarantees it never
 *    is, and it is deliberately independent of `embeddable` so that it
 *    cannot be undone by a change to how resolution failures are recorded.
 */
export function canEmbed(url: string, embeddable: boolean | undefined, currentOrigin: string): boolean {
  if (!embeddable) return false
  try {
    return new URL(url).origin !== new URL(currentOrigin).origin
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Implement `LinkPane.tsx`**

```tsx
export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups"

/**
 * The body of a selected link resource: its card, then the page itself.
 *
 * Where a PR or Jira issue shows a filtered activity feed, a link shows the
 * page — it has no events, is never polled, and has no unread state, so there
 * is nothing for a feed to contain.
 */
export function LinkPane({ resource, path, onRemoved, onResourceChanged }: {
  resource: ResourceDTO
  path: string
  onRemoved?: () => void
  onResourceChanged?: () => void
}) {
  const qc = useQueryClient()
  const refresh = useMutation({
    mutationFn: () => api.resolveResource({ type: resource.type, id: resource.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["resources", path] })
      void qc.invalidateQueries({ queryKey: ["worktrees"] })
    },
  })
  const embed = canEmbed(resource.url, resource.embeddable, window.location.origin)

  return (
    <>
      <ResourceCard r={resource} path={path} onRemoved={onRemoved}
        onMetaChanged={onResourceChanged} variant="detail" />
      <Group gap={6} justify="flex-end">
        {/* A link is never polled, so this button is the ONLY way its
            metadata becomes current again. */}
        <Button size="compact-sm" variant="subtle" loading={refresh.isPending}
          onClick={() => refresh.mutate()}>
          Refresh page details
        </Button>
      </Group>
      {embed ? (
        <Box style={{ flex: 1, minHeight: 480, display: "flex" }}>
          <iframe
            src={resource.url}
            title={resource.custom_name || resource.title || resource.url}
            sandbox={EMBED_SANDBOX}
            referrerPolicy="no-referrer"
            style={{ flex: 1, border: "1px solid var(--mantine-color-default-border)",
                     borderRadius: "var(--mantine-radius-sm)", background: "var(--mantine-color-body)" }}
          />
        </Box>
      ) : (
        <Alert color="gray" variant="light" title="Can't embed page">
          <Stack gap="sm" align="flex-start">
            <Text size="sm">
              {shortResourceRef("link", resource.id) || "This site"} does not allow its pages to be
              displayed inside another site.
            </Text>
            <Button component="a" href={resource.url} target="_blank" rel="noreferrer" size="xs">
              Open in new tab
            </Button>
          </Stack>
        </Alert>
      )}
    </>
  )
}
```

- [ ] **Step 5: Render it from `ResourceDetailPane`**

Replace the two-branch ternary at `ResourceDetailPane.tsx:182` with three branches:

```tsx
      {resource.type === "slack" ? (
        <SlackThreadPane ... />
      ) : resource.type === "link" ? (
        <LinkPane
          resource={resource}
          path={path}
          onRemoved={onRemoved}
          onResourceChanged={onResourceChanged}
        />
      ) : (
        <TimelineBody ... />
      )}
```

- [ ] **Step 6: Run to verify passing**

Run (from `ui/`): `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Prove the same-origin guard guards**

Temporarily change `canEmbed` to `return !!embeddable`. The test named "REFUSES OUR OWN ORIGIN" must FAIL. Restore it.

- [ ] **Step 8: Commit**

```bash
git add ui/src/lib/linkEmbed.ts ui/src/lib/linkEmbed.test.ts ui/src/components/LinkPane.tsx ui/src/components/LinkPane.test.tsx ui/src/components/ResourceDetailPane.tsx
git commit --signoff -m "feat(ui): render a followed page, or explain why it cannot be framed"
```

---

## Task 10: Frontend — the Follow resource modal

**Files:**
- Modify: `ui/src/components/AddResourceModal.tsx`
- Test: `ui/src/components/AddResourceModal.test.tsx`

**Interfaces:**
- Consumes: `api.resourceType` (Task 8).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

```tsx
it("offers a custom name for a link, as it does for a Slack thread", async () => {
  resourceType.mockResolvedValue({ type: "link", id: "https://ex.com/a" })
  wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
  await userEvent.type(screen.getByLabelText("URL"), "https://ex.com/a")
  expect(await screen.findByLabelText("Custom Name (optional)")).toBeInTheDocument()
})

it("offers no custom name for a PR, which has a title from its source", async () => {
  resourceType.mockResolvedValue({ type: "pr", id: "o/r#1" })
  wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
  await userEvent.type(screen.getByLabelText("URL"), "https://github.com/o/r/pull/1")
  await screen.findByText(/GitHub/)
  expect(screen.queryByLabelText("Custom Name (optional)")).toBeNull()
})

it("names what it detected, so a mistyped URL is visible before Follow", async () => {
  resourceType.mockResolvedValue({ type: "link", id: "https://ex.com/a" })
  wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
  await userEvent.type(screen.getByLabelText("URL"), "https://ex.com/a")
  expect(await screen.findByText("Link — ex.com")).toBeInTheDocument()
})

it("no longer says which three services are allowed", () => {
  wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
  expect(screen.getByPlaceholderText("Paste any URL")).toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify failure**

Run (from `ui/`): `npx vitest run src/components/AddResourceModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Delete `isSlackUrl` entirely and classify through the API instead:

```tsx
/*
 * What kind of resource the pasted URL is, answered by the server.
 *
 * Deliberately not a frontend regex: recognising a link means recognising
 * what is NOT a PR or Jira URL, and copying those patterns here is the exact
 * duplication internal/resourceurl exists to prevent (webui once hand-copied
 * cmd/root.go's PR regex under a comment promising to keep them in sync).
 * One detector, asked over HTTP.
 */
const [detected, setDetected] = useState<{ type: string; id: string } | null>(null)
useEffect(() => {
  const trimmed = url.trim()
  if (!trimmed) {
    setDetected(null)
    return
  }
  let cancelled = false
  const t = setTimeout(() => {
    api.resourceType(trimmed)
      .then((d) => { if (!cancelled) setDetected(d) })
      .catch(() => { if (!cancelled) setDetected(null) })
  }, 300)
  return () => { cancelled = true; clearTimeout(t) }
}, [url])

const supportsCustomName = detected?.type === "slack" || detected?.type === "link"
```

A readable label for the confirmation line:

```tsx
const DETECTED_LABEL: Record<string, string> = {
  pr: "GitHub PR", jira: "Jira issue", slack: "Slack thread", link: "Link",
}

function detectedSummary(d: { type: string; id: string } | null): string {
  if (!d || !d.type) return ""
  const name = DETECTED_LABEL[d.type] ?? d.type
  const ref = shortResourceRef(d.type, d.id)
  return ref ? `${name} — ${ref}` : name
}
```

Placeholder and the summary line:

```tsx
<TextInput
  label="URL"
  placeholder="Paste any URL"
  ...
/>
{detected?.type && <Text size="xs" c="dimmed">{detectedSummary(detected)}</Text>}
```

Replace `{slack && (` with `{supportsCustomName && (`.

- [ ] **Step 4: Run to verify passing**

Run (from `ui/`): `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Assert the duplication is gone**

Run: `grep -rn "slack.com" ui/src --include=*.tsx --include=*.ts | grep -v test`
Expected: no URL-classification match. The point of the endpoint is that the frontend no longer knows what a Slack URL looks like.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/AddResourceModal.tsx ui/src/components/AddResourceModal.test.tsx
git commit --signoff -m "feat(ui): classify a pasted URL server-side in the follow modal"
```

---

## Task 11: Documentation

**Files:**
- Modify: `docs/web-ui-architecture.md`, `.claude/CLAUDE.md`

- [ ] **Step 1: Document the packages in `.claude/CLAUDE.md`**

Add to the `internal/` package list, in the established style:

```
  - `safehttp` — the SSRF-safe dialer and address predicate, shared by the
    image proxy and link resolution. Resolves a host, refuses it if ANY
    resolved IP is disallowed, and dials the validated IP directly (pinning
    it, which closes the DNS-rebinding window). This is the ONLY containment
    for outbound fetches — there is no network segmentation behind it. Never
    copy it, never weaken it, and never replace the per-hop dialer check with
    a pre-flight lookup of the requested host.
  - `linkmeta` — resolves a followed page's title, description, favicon,
    preview image and whether it permits being framed. Used only at add time
    and on explicit refresh: link resources are NEVER polled.
```

- [ ] **Step 2: Document the routes and the type in `docs/web-ui-architecture.md`**

Add `POST /api/resource-resolve`, `GET /api/resource-type` to the route list, and a "Link resources" subsection recording: the ID is the normalized URL; metadata lives in `watcher_resource_state` written by worktree rather than a poller; there is no polling, no events and no unread state; and the iframe's same-origin guard is what makes `allow-same-origin` safe.

- [ ] **Step 3: Run the full suites one final time**

Run: `go test ./... && cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/web-ui-architecture.md .claude/CLAUDE.md
git commit --signoff -m "docs: record the link resource type and the shared safe-http package"
```

---

## Manual verification (after Task 11)

The unit suites cannot see geometry, iframe behaviour, or a real site's headers. Before calling this done, with `NONINTERACTIVE=1 make install` run:

1. Follow `https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers` — expect a title, a favicon, the domain on the selector card, and the page rendered in the frame.
2. Follow `https://github.com/mturley/worktree` — GitHub sends `X-Frame-Options: deny`, so expect the **"Can't embed page"** panel, not a blank rectangle. This is the case the whole `embeddable` mechanism exists for.
3. Confirm the favicon appears on the selector card and comes from
   `/api/link-image`, not from the site directly (check the network tab).
4. Follow a URL that 301s (e.g. `http://` to `https://`) and confirm the favicon resolves against the final host.
5. Confirm a link shows no Activity heading, no unread dot, and no mark-read button anywhere — selector card, detail pane, and both timelines.
6. Confirm a followed link never appears as an event in the home page or worktree Activity feed.
