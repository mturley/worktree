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
// 169.254.169.254 cloud-metadata endpoint), unspecified, multicast, and CGNAT
// (100.64.0.0/10). An IPv6 address that carries an IPv4 address (NAT64,
// 6to4, IPv4-compatible) is judged by the IPv4 address it carries.
func IsDisallowedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return true
	}
	// CGNAT 100.64.0.0/10: not covered by IsPrivate(), but effectively
	// internal for our purposes.
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return true
	}
	// Local-use NAT64 (RFC 8215) is by definition an operator's own
	// translation space. Where the IPv4 address sits inside it depends on
	// the operator's prefix length, so it is refused rather than decoded.
	if nat64LocalUse.Contains(ip) {
		return true
	}
	if v4 := embeddedIPv4(ip); v4 != nil {
		return IsDisallowedIP(v4)
	}
	return false
}

var (
	nat64WellKnown = mustCIDR("64:ff9b::/96")
	nat64LocalUse  = mustCIDR("64:ff9b:1::/48")
	sixToFour      = mustCIDR("2002::/16")
)

func mustCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}

// embeddedIPv4 returns the IPv4 address an IPv6 address carries, or nil if
// it carries none. Plain IPv4 and IPv4-mapped addresses return nil: the
// stdlib predicates already see their IPv4 form through To4().
func embeddedIPv4(ip net.IP) net.IP {
	if ip.To4() != nil {
		return nil
	}
	v6 := ip.To16()
	if v6 == nil {
		return nil
	}
	switch {
	case nat64WellKnown.Contains(v6):
		return net.IPv4(v6[12], v6[13], v6[14], v6[15])
	case sixToFour.Contains(v6):
		return net.IPv4(v6[2], v6[3], v6[4], v6[5])
	case isIPv4Compatible(v6):
		return net.IPv4(v6[12], v6[13], v6[14], v6[15])
	}
	return nil
}

// isIPv4Compatible reports whether v6 has the deprecated ::a.b.c.d form.
// :: and ::1 share the all-zero prefix but are the unspecified and loopback
// addresses, which the stdlib predicates classify already.
func isIPv4Compatible(v6 net.IP) bool {
	for _, b := range v6[:12] {
		if b != 0 {
			return false
		}
	}
	return !(v6[12] == 0 && v6[13] == 0 && v6[14] == 0 && v6[15] <= 1)
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
	// http.DefaultTransport carries Proxy: http.ProxyFromEnvironment. With
	// that left in place, an HTTP(S)_PROXY environment variable would send
	// every dial to the proxy's own address — which passes our blocklist
	// check — and let the PROXY resolve and connect to the attacker-chosen
	// host on our behalf, entirely outside the blocklist. This is the only
	// SSRF containment in this product, so a proxy env var would silently
	// void it. Disable proxying altogether.
	t.Proxy = nil
	return t
}
