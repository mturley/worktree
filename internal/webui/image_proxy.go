package webui

import (
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/mturley/worktree/internal/safehttp"
)

// maxProxiedImageBytes caps how much an open-host image proxy will stream
// back. Unfurl favicons/previews are small; this bounds memory/bandwidth and
// limits how much an internal response could ever be relayed even if the SSRF
// IP filter were somehow bypassed.
const maxProxiedImageBytes = 8 << 20 // 8 MiB

// handleImage is an OPEN-HOST image proxy for third-party unfurl images
// (preview/thumbnail, service favicon, footer icon) that come from arbitrary
// external sites, so the exact-host pinning used by the Slack-CDN proxies
// (handleImageProxy) does not apply. SSRF is contained by: https-only; a
// dialer that resolves + rejects loopback/private/link-local/metadata/CGNAT
// IPs and pins the validated IP (anti-rebinding); no redirect following
// (noFollowRedirects); a response size cap; and no cookie forwarding (these
// are public third-party images). Only image/* responses are passed through.
func (s *Server) handleImage(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	if raw == "" {
		http.Error(w, "url required", http.StatusBadRequest)
		return
	}
	u, err := url.Parse(raw)
	if err != nil {
		http.Error(w, "invalid url", http.StatusBadRequest)
		return
	}
	if u.Scheme != "https" {
		http.Error(w, "url scheme not allowed", http.StatusBadRequest)
		return
	}
	if u.Hostname() == "" {
		http.Error(w, "url host required", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	transport := s.imageProxyTransport
	if transport == nil {
		base := safehttp.Transport()
		transport = base
	}
	client := &http.Client{Transport: transport, CheckRedirect: noFollowRedirects}
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Only relay actual images; refuse anything else (e.g. an HTML error page
	// or an internal response that slipped an unusual content type).
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(strings.ToLower(ct), "image/") {
		http.Error(w, "not an image", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, io.LimitReader(resp.Body, maxProxiedImageBytes)); err != nil && s.Logger != nil {
		s.Logger.Printf("image proxy: copying response body for %s: %v", u.String(), err)
	}
}
