package webui

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/uisession"
)

const testPassword = "correct horse battery staple"

type testClock struct{ t time.Time }

func (c *testClock) now() time.Time { return c.t }

func securedServer(t *testing.T) (*Server, *uisession.Store, *testClock) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	clock := &testClock{t: time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)}
	store := &uisession.Store{DB: conn, Now: clock.now}
	old := loginFailDelay
	loginFailDelay = 0
	t.Cleanup(func() { loginFailDelay = old })
	return &Server{DB: conn, Security: &Security{Password: testPassword, Sessions: store}}, store, clock
}

// apiRequest builds a request the Host and forgery guards accept, so a test
// observes only the session check.
func apiRequest(method, path, body string, cookies ...*http.Cookie) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = "127.0.0.1:8475"
	if method != http.MethodGet {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	return req
}

func serve(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func sessionCookieFrom(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			return c
		}
	}
	t.Fatalf("no %s cookie in response (status %d)", sessionCookieName, rec.Code)
	return nil
}

func login(t *testing.T, h http.Handler) *http.Cookie {
	t.Helper()
	rec := serve(h, apiRequest("POST", "/api/login", `{"password":"`+testPassword+`"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("login: status %d %s", rec.Code, rec.Body)
	}
	return sessionCookieFrom(t, rec)
}

func TestEveryAPIRouteRequiresASession(t *testing.T) {
	srv, store, _ := securedServer(t)
	token, _, err := store.Create("test")
	if err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: sessionCookieName, Value: token}

	// Stub handlers for the real route table, behind the real guard chain.
	// This proves the chain over every registered route without running
	// handlers that need Slack, cmux or git.
	stub := http.NewServeMux()
	routes := srv.routes()
	if len(routes) == 0 {
		t.Fatal("route table is empty")
	}
	for _, rt := range routes {
		stub.HandleFunc(rt.pattern, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	}
	h := srv.wrap(stub)

	for _, rt := range routes {
		method, path, ok := strings.Cut(rt.pattern, " ")
		if !ok {
			t.Fatalf("route %q declares no method", rt.pattern)
		}
		if strings.Contains(path, "{") {
			t.Fatalf("route %q has a wildcard; teach this test to fill it in", rt.pattern)
		}
		rec := serve(h, apiRequest(method, path, "{}"))
		if rt.pattern == "POST /api/login" {
			if rec.Code != http.StatusNoContent {
				t.Errorf("%s without a session: status %d, want it reachable", rt.pattern, rec.Code)
			}
		} else if rec.Code != http.StatusUnauthorized || rec.Header().Get(loginRequiredHeader) != "1" {
			t.Errorf("%s without a session: status %d, header %q; want 401 with %s: 1",
				rt.pattern, rec.Code, rec.Header().Get(loginRequiredHeader), loginRequiredHeader)
		}
		if rec := serve(h, apiRequest(method, path, "{}", cookie)); rec.Code != http.StatusNoContent {
			t.Errorf("%s with a session: status %d, want 204", rt.pattern, rec.Code)
		}
	}
}

func TestUnregisteredAPIPathStillRequiresASession(t *testing.T) {
	srv, _, _ := securedServer(t)
	rec := serve(srv.Handler(), apiRequest("GET", "/api/not-a-route", ""))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401: the check is on the /api/ prefix, not the route list", rec.Code)
	}
}

func TestStaticAssetsNeedNoSession(t *testing.T) {
	srv, _, _ := securedServer(t)
	srv.WebFS = fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html>")},
		"assets/app.js": {Data: []byte("1")},
	}
	h := srv.Handler()
	for _, path := range []string{"/", "/assets/app.js", "/worktree/some/path"} {
		if rec := serve(h, apiRequest("GET", path, "")); rec.Code != http.StatusOK {
			t.Errorf("GET %s: status %d, want 200 (the login page must load)", path, rec.Code)
		}
	}
}

func TestLoginWithWrongPasswordSetsNoCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	for _, pw := range []string{"wrong", "", testPassword + "x"} {
		body, _ := json.Marshal(map[string]string{"password": pw})
		rec := serve(srv.Handler(), apiRequest("POST", "/api/login", string(body)))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("password %q: status %d, want 401", pw, rec.Code)
		}
		if len(rec.Result().Cookies()) != 0 {
			t.Errorf("password %q: set a cookie", pw)
		}
	}
}

func TestLoginSetsASessionCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	req := apiRequest("POST", "/api/login", `{"password":"`+testPassword+`"}`)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")
	rec := serve(h, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	c := sessionCookieFrom(t, rec)
	if !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.MaxAge != 30*24*60*60 {
		t.Errorf("cookie = %+v, want HttpOnly, SameSite=Lax, Path=/, Max-Age=2592000", c)
	}
	if c.Secure {
		t.Error("Secure set on a login over plain HTTP: the browser would discard the cookie")
	}
	if strings.Contains(rec.Body.String(), c.Value) {
		t.Error("login response body contains the session token")
	}

	rec = serve(h, apiRequest("GET", "/api/session", "", c))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/session with the new cookie: status %d", rec.Code)
	}
	var dto sessionDTO
	if err := json.Unmarshal(rec.Body.Bytes(), &dto); err != nil {
		t.Fatal(err)
	}
	if !dto.Current || dto.Label != "Android — Chrome" || dto.Handle != uisession.HandleFor(c.Value) {
		t.Errorf("session = %+v", dto)
	}
}

func TestLoginOverTLSSetsASecureCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	req := apiRequest("POST", "/api/login", `{"password":"`+testPassword+`"}`)
	req.TLS = &tls.ConnectionState{}
	c := sessionCookieFrom(t, serve(srv.Handler(), req))
	if !c.Secure {
		t.Fatal("Secure not set on a login that arrived over TLS")
	}
}

func TestLoginIsRefusedCrossSite(t *testing.T) {
	srv, _, _ := securedServer(t)
	req := apiRequest("POST", "/api/login", `{"password":"`+testPassword+`"}`)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := serve(srv.Handler(), req)
	if rec.Code != http.StatusForbidden || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("status %d, cookies %v; want 403 and no cookie", rec.Code, rec.Result().Cookies())
	}
}

func TestHostGuardRunsBeforeTheSessionCheck(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	req := apiRequest("GET", "/api/session", "")
	req.Host = "rebound.evil.example"
	rec := serve(h, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("no session, unlisted Host: status %d, want 400", rec.Code)
	}
	if rec.Header().Get(loginRequiredHeader) != "" {
		t.Fatalf("unlisted Host response carries %s; the Host guard must reject before the session check runs", loginRequiredHeader)
	}
}

func TestForgeryGuardRunsBeforeTheSessionCheck(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	req := apiRequest("POST", "/api/logout", "")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := serve(h, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("no session, cross-site: status %d, want 403", rec.Code)
	}
	if rec.Header().Get(loginRequiredHeader) != "" {
		t.Fatalf("cross-site response carries %s; the forgery guard must reject before the session check runs", loginRequiredHeader)
	}
}

func TestRevokedSessionIsRefusedOnItsNextRequest(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	phone, laptop := login(t, h), login(t, h)

	rec := serve(h, apiRequest("GET", "/api/sessions", "", laptop))
	var list []sessionDTO
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	var current int
	for _, s := range list {
		if s.Current {
			current++
		}
	}
	if len(list) != 2 || current != 1 {
		t.Fatalf("sessions = %+v, want two with exactly one current", list)
	}

	body, _ := json.Marshal(map[string]string{"handle": uisession.HandleFor(phone.Value)})
	if rec := serve(h, apiRequest("POST", "/api/sessions/revoke", string(body), laptop)); rec.Code != http.StatusOK {
		t.Fatalf("revoke: status %d %s", rec.Code, rec.Body)
	}
	if rec := serve(h, apiRequest("GET", "/api/session", "", phone)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked phone: status %d, want 401", rec.Code)
	}
	if rec := serve(h, apiRequest("GET", "/api/session", "", laptop)); rec.Code != http.StatusOK {
		t.Fatalf("laptop after revoking phone: status %d, want 200", rec.Code)
	}
	if rec := serve(h, apiRequest("POST", "/api/sessions/revoke", string(body), laptop)); rec.Code != http.StatusNotFound {
		t.Fatalf("revoking an unknown handle: status %d, want 404", rec.Code)
	}
}

func TestSessionsNeverExposeTokens(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	a, b := login(t, h), login(t, h)
	rec := serve(h, apiRequest("GET", "/api/sessions", "", a))
	for _, c := range []*http.Cookie{a, b} {
		if strings.Contains(rec.Body.String(), c.Value) {
			t.Fatal("GET /api/sessions returned a session token")
		}
	}
}

func TestRevokingTheCurrentSessionClearsTheCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	c := login(t, h)
	body, _ := json.Marshal(map[string]string{"handle": uisession.HandleFor(c.Value)})
	rec := serve(h, apiRequest("POST", "/api/sessions/revoke", string(body), c))
	if rec.Code != http.StatusOK || sessionCookieFrom(t, rec).MaxAge >= 0 {
		t.Fatalf("status %d; want 200 and the cookie cleared", rec.Code)
	}
}

func TestExpiredSessionIsRefused(t *testing.T) {
	srv, _, clock := securedServer(t)
	h := srv.Handler()
	c := login(t, h)
	clock.t = clock.t.Add(uisession.Lifetime)
	if rec := serve(h, apiRequest("GET", "/api/session", "", c)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401 for an expired session", rec.Code)
	}
}

func TestLastSeenIsNotWrittenOnEveryRequest(t *testing.T) {
	srv, store, clock := securedServer(t)
	h := srv.Handler()
	c := login(t, h)
	lastSeen := func() time.Time {
		sess, ok, err := store.Lookup(c.Value)
		if err != nil || !ok {
			t.Fatalf("Lookup = %v, %v", ok, err)
		}
		return sess.LastSeenAt
	}

	clock.t = clock.t.Add(6 * time.Minute)
	serve(h, apiRequest("GET", "/api/session", "", c))
	first := lastSeen()
	if !first.Equal(clock.t) {
		t.Fatalf("last_seen_at = %v after a request past the interval, want %v", first, clock.t)
	}

	clock.t = clock.t.Add(time.Minute)
	serve(h, apiRequest("GET", "/api/session", "", c))
	if got := lastSeen(); !got.Equal(first) {
		t.Fatalf("last_seen_at rewritten to %v inside the throttle window, want %v", got, first)
	}
}

func TestLogoutRevokesAndClearsTheCookie(t *testing.T) {
	srv, _, _ := securedServer(t)
	h := srv.Handler()
	c := login(t, h)
	rec := serve(h, apiRequest("POST", "/api/logout", "", c))
	if rec.Code != http.StatusOK || sessionCookieFrom(t, rec).MaxAge >= 0 {
		t.Fatalf("logout: status %d; want 200 and the cookie cleared", rec.Code)
	}
	if rec := serve(h, apiRequest("GET", "/api/session", "", c)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("after logout: status %d, want 401", rec.Code)
	}
}

func TestPasswordMatches(t *testing.T) {
	for _, tc := range []struct {
		got, want string
		ok        bool
	}{
		{"pw", "pw", true},
		{"pw", "PW", false},
		{"p", "pw", false},
		{"", "", false}, // an unset password never matches
	} {
		if passwordMatches(tc.got, tc.want) != tc.ok {
			t.Errorf("passwordMatches(%q, %q) = %v", tc.got, tc.want, !tc.ok)
		}
	}
}
