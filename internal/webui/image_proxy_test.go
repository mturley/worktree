package webui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

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
