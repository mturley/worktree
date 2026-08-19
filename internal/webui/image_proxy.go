package webui

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// maxProxiedImageBytes caps how much an open-host image proxy will stream
// back. Unfurl favicons/previews are small; this bounds memory/bandwidth and
// limits how much an internal response could ever be relayed even if the SSRF
// IP filter were somehow bypassed.
const maxProxiedImageBytes = 8 << 20 // 8 MiB

// isDisallowedIP reports whether ip is one an open-host proxy must refuse to
// connect to: loopback, private (RFC1918 / ULA), link-local (incl. the
// 169.254.169.254 cloud-metadata endpoint), unspecified, and CGNAT
// (100.64.0.0/10). These are the ranges an SSRF attacker would target to
// reach internal services or a cloud metadata service.
func isDisallowedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	// CGNAT 100.64.0.0/10 — not covered by IsPrivate(), but effectively
	// internal for our purposes.
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return true
	}
	return false
}

// safeDialContext returns a DialContext that resolves the target host, rejects
// it if ANY resolved IP is disallowed, and dials one of the validated IPs
// directly (pinning it). Pinning the already-validated IP for the actual
// connection closes the DNS-rebinding TOCTOU window: net/http never re-resolves
// the name, so a hostname cannot pass the check and then resolve to an internal
// address at connect time.
func safeDialContext(base *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		// If the host is already a literal IP, validate it directly.
		if ip := net.ParseIP(host); ip != nil {
			if isDisallowedIP(ip) {
				return nil, fmt.Errorf("blocked address %s", ip)
			}
			return base.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		}
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("no addresses for %s", host)
		}
		// Reject if ANY resolved IP is disallowed — refuse rather than
		// cherry-pick a public one, since a dual-homed name is suspicious.
		for _, ip := range ips {
			if isDisallowedIP(ip) {
				return nil, fmt.Errorf("blocked address %s for host %s", ip, host)
			}
		}
		// Dial the first (validated) IP, pinned.
		return base.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
	}
}

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
		// Clone the default transport and swap in the SSRF-safe dialer. We do
		// NOT mutate http.DefaultTransport in place (it is process-global).
		base := http.DefaultTransport.(*http.Transport).Clone()
		base.DialContext = safeDialContext(&net.Dialer{})
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
