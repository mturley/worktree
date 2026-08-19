package webui

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestIsDisallowedIP(t *testing.T) {
	cases := []struct {
		ip      string
		blocked bool
	}{
		{"127.0.0.1", true},       // loopback
		{"::1", true},             // loopback v6
		{"10.0.0.5", true},        // RFC1918
		{"192.168.1.1", true},     // RFC1918
		{"172.16.0.1", true},      // RFC1918
		{"169.254.169.254", true}, // link-local / cloud metadata
		{"0.0.0.0", true},         // unspecified
		{"fc00::1", true},         // ULA (private v6)
		{"fe80::1", true},         // link-local v6
		{"100.64.0.1", true},      // CGNAT
		{"100.127.255.255", true}, // CGNAT upper
		{"8.8.8.8", false},        // public
		{"1.1.1.1", false},        // public
		{"140.82.112.3", false},   // public (github-ish)
		{"2606:4700::1111", false}, // public v6
		{"100.128.0.1", false},    // just above CGNAT — public
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if ip == nil {
			t.Fatalf("bad test IP %q", c.ip)
		}
		if got := isDisallowedIP(ip); got != c.blocked {
			t.Errorf("isDisallowedIP(%s) = %v, want %v", c.ip, got, c.blocked)
		}
	}
	if !isDisallowedIP(nil) {
		t.Errorf("isDisallowedIP(nil) = false, want true")
	}
}

func TestSafeDialContext_BlocksLiteralPrivateIP(t *testing.T) {
	dial := safeDialContext(&net.Dialer{})
	_, err := dial(context.Background(), "tcp", "169.254.169.254:443")
	if err == nil {
		t.Fatal("expected dial to a metadata IP to be blocked, got nil error")
	}
	if !strings.Contains(err.Error(), "blocked") {
		t.Errorf("expected a 'blocked' error, got %v", err)
	}
}

func TestHandleImage_RejectsBadScheme(t *testing.T) {
	srv := &Server{}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, raw := range []string{
		"http://example.com/favicon.ico", // not https
		"ftp://example.com/x.png",        // not https
	} {
		resp, err := http.Get(ts.URL + "/api/slack-image?url=" + url.QueryEscape(raw))
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("url=%s: got %d, want 400", raw, resp.StatusCode)
		}
	}
}

func TestHandleImage_RejectsMissingURL(t *testing.T) {
	srv := &Server{}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/slack-image")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("missing url: got %d, want 400", resp.StatusCode)
	}
}

// stubRoundTripper lets us test the handler's response handling
// (content-type gating, streaming) without a real network dial.
type stubRoundTripper struct {
	resp *http.Response
	err  error
}

func (s stubRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return s.resp, s.err
}

func TestHandleImage_PassesThroughImage(t *testing.T) {
	body := "\x89PNG\r\n\x1a\n fake png bytes"
	srv := &Server{imageProxyTransport: stubRoundTripper{resp: &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": {"image/png"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}}}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/slack-image?url=" + url.QueryEscape("https://cdn.example.com/favicon.png"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("got %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Errorf("content-type = %q, want image/png", ct)
	}
	got, _ := io.ReadAll(resp.Body)
	if string(got) != body {
		t.Errorf("body mismatch: got %q", got)
	}
}

func TestHandleImage_RejectsNonImage(t *testing.T) {
	srv := &Server{imageProxyTransport: stubRoundTripper{resp: &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": {"text/html"}},
		Body:       io.NopCloser(strings.NewReader("<html>nope</html>")),
	}}}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/slack-image?url=" + url.QueryEscape("https://evil.example.com/internal"))
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("non-image: got %d, want 502", resp.StatusCode)
	}
}
