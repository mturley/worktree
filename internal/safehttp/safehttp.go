// Package safehttp provides an SSRF-safe dialer and transport for making
// HTTP requests to arbitrary, user-supplied hosts.
package safehttp

import (
	"context"
	"fmt"
	"net"
	"net/http"
)

// IsDisallowedIP reports whether ip is one an open-host proxy must refuse to
// connect to: loopback, private (RFC1918 / ULA), link-local (incl. the
// 169.254.169.254 cloud-metadata endpoint), unspecified, and CGNAT
// (100.64.0.0/10). These are the ranges an SSRF attacker would target to
// reach internal services or a cloud metadata service.
func IsDisallowedIP(ip net.IP) bool {
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

// DialContext returns a DialContext that resolves the target host, rejects
// it if ANY resolved IP is disallowed, and dials one of the validated IPs
// directly (pinning it). Pinning the already-validated IP for the actual
// connection closes the DNS-rebinding TOCTOU window: net/http never re-resolves
// the name, so a hostname cannot pass the check and then resolve to an internal
// address at connect time.
func DialContext(base *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		// If the host is already a literal IP, validate it directly.
		if ip := net.ParseIP(host); ip != nil {
			if IsDisallowedIP(ip) {
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
			if IsDisallowedIP(ip) {
				return nil, fmt.Errorf("blocked address %s for host %s", ip, host)
			}
		}
		// Dial the first (validated) IP, pinned.
		return base.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
	}
}

// Transport returns a clone of http.DefaultTransport with the SSRF-safe
// dialer installed. A clone, never a mutation: http.DefaultTransport is
// process-global and shared with every other caller in the binary.
func Transport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DialContext = DialContext(&net.Dialer{})
	return t
}
