package webui

import (
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func testServer(t *testing.T, webFS fs.FS) *Server {
	t.Helper()
	return &Server{WebFS: webFS}
}

func TestServesIndexFallbackForSPARoutes(t *testing.T) {
	webFS := fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><title>worktree</title>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	srv := testServer(t, webFS)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// A client-side route with no matching file -> index.html
	resp, err := http.Get(ts.URL + "/worktrees/some-branch")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("SPA route: got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct == "" || ct[:9] != "text/html" {
		t.Fatalf("SPA route content-type: %q", ct)
	}

	// A real asset -> served directly
	resp2, err := http.Get(ts.URL + "/assets/app.js")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("asset: got %d", resp2.StatusCode)
	}
	body2, err := io.ReadAll(resp2.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body2) != "console.log(1)" {
		t.Fatalf("asset: expected seeded content, got %q", string(body2))
	}
	if ct := resp2.Header.Get("Content-Type"); len(ct) >= 9 && ct[:9] == "text/html" {
		t.Fatalf("asset: unexpected text/html content-type (fell back to index): %q", ct)
	}
}

func TestServesIndexFallbackForDirectoryPath(t *testing.T) {
	// A real subdirectory in the embedded FS with no index.html of its own
	// must NOT fall through to Go's default directory listing; it should
	// fall back to the SPA index.html, same as any other unknown route.
	webFS := fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><title>worktree</title>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	srv := testServer(t, webFS)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/assets/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("dir path: got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct == "" || ct[:9] != "text/html" {
		t.Fatalf("dir path content-type: %q", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "<!doctype html><title>worktree</title>" {
		t.Fatalf("dir path: expected index.html body, got %q (looks like a directory listing?)", string(body))
	}
}
