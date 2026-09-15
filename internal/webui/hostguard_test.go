package webui

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestHostAllowed(t *testing.T) {
	extra := []string{"mturley-mac.local", "192.168.86.21"}
	cases := []struct {
		host string
		want bool
	}{
		{"localhost", true},
		{"localhost:8475", true},
		{"LOCALHOST:5175", true}, // the Vite dev proxy forwards its own port
		{"127.0.0.1", true},
		{"127.0.0.1:8476", true},
		{"[::1]", true},
		{"[::1]:8476", true},
		{"::1", true},
		{"mturley-mac.local:8476", true},
		{"MTurley-Mac.local", true},
		{"mturley-mac.local.", true}, // a fully-qualified name with its trailing dot
		{"192.168.86.21:8476", true},
		{"mturley-mac.local:9999", true}, // the port is deliberately ignored
		{"evil.example", false},
		{"evil.example:8475", false},
		{"127.0.0.1.evil.example", false},
		{"192.168.86.22", false},
		{"", false},
		{"[::1", false},               // unbalanced bracket must not be stripped into a bare "::1"
		{"::1]", false},               // ditto, trailing bracket only
		{"mturley-mac.local]", false}, // an allowed name with a stray bracket must still fail
		{"[mturley-mac.local", false},
	}
	for _, tc := range cases {
		if got := hostAllowed(tc.host, extra); got != tc.want {
			t.Errorf("hostAllowed(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

func TestHostGuardRefusesBeforeRouting(t *testing.T) {
	// A route that succeeds for an allowed Host, so a 400 can only have come
	// from the guard and not from the route. (Static assets need no session,
	// so this keeps passing once Task 7 adds one.)
	srv := &Server{
		WebFS:    fstest.MapFS{"index.html": {Data: []byte("<!doctype html>")}},
		Security: &Security{Password: "pw", AllowedHosts: []string{"mturley-mac.local"}},
	}
	h := srv.Handler()

	ok := httptest.NewRequest("GET", "/", nil)
	ok.Host = "mturley-mac.local:8476"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, ok)
	if rec.Code != http.StatusOK {
		t.Fatalf("allowed Host: status %d, want 200", rec.Code)
	}

	bad := httptest.NewRequest("GET", "/", nil)
	bad.Host = "rebound.evil.example"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, bad)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unlisted Host: status %d, want 400", rec.Code)
	}
}

func TestHostGuardIsOffWithoutSecurity(t *testing.T) {
	// In-process tests build a bare Server; httptest's default Host is
	// example.com. Start and Serve refuse a nil Security.
	srv := &Server{WebFS: fstest.MapFS{"index.html": {Data: []byte("x")}}}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, want 200", rec.Code)
	}
}
