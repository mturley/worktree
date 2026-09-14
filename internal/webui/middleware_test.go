package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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

func TestRejectsBodylessRequestWithoutContentType(t *testing.T) {
	// The check is unconditional, not "only when there is a body": a
	// bodyless cross-site POST needs no CORS preflight either, so exempting
	// bodyless requests would leave exactly those endpoints reachable.
	srv := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/worktrees/poll", nil)
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

func TestSetsXFrameOptions(t *testing.T) {
	// Every response sets X-Frame-Options: DENY to prevent a followed page
	// from redirecting into our own origin and escaping the iframe sandbox.
	srv := &Server{}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/resource-type?url=x", nil))
	if got := rec.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("X-Frame-Options = %q, want DENY", got)
	}
}
