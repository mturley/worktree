package safehttp

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

func TestIsDisallowedIP(t *testing.T) {
	cases := []struct {
		ip      string
		blocked bool
	}{
		{"127.0.0.1", true},        // loopback
		{"::1", true},              // loopback v6
		{"10.0.0.5", true},         // RFC1918
		{"192.168.1.1", true},      // RFC1918
		{"172.16.0.1", true},       // RFC1918
		{"169.254.169.254", true},  // link-local / cloud metadata
		{"0.0.0.0", true},          // unspecified
		{"fc00::1", true},          // ULA (private v6)
		{"fe80::1", true},          // link-local v6
		{"100.64.0.1", true},       // CGNAT
		{"100.127.255.255", true},  // CGNAT upper
		{"8.8.8.8", false},         // public
		{"1.1.1.1", false},         // public
		{"140.82.112.3", false},    // public (github-ish)
		{"2606:4700::1111", false}, // public v6
		{"100.128.0.1", false},     // just above CGNAT — public
		// IPv4-mapped: the stdlib predicates already see the IPv4 address.
		{"::ffff:127.0.0.1", true},
		{"::ffff:10.0.0.1", true},
		{"::ffff:100.64.0.1", true},
		{"::ffff:8.8.8.8", false},
		// NAT64 well-known prefix: the low 32 bits are the IPv4 address.
		{"64:ff9b::7f00:1", true},   // 127.0.0.1
		{"64:ff9b::a00:1", true},    // 10.0.0.1
		{"64:ff9b::6440:1", true},   // 100.64.0.1 (CGNAT)
		{"64:ff9b::808:808", false}, // 8.8.8.8
		// NAT64 local-use prefix: refused outright.
		{"64:ff9b:1::1", true},
		// 6to4: bits 16-47 are the IPv4 address.
		{"2002:0a00:0001::", true},  // 10.0.0.1
		{"2002:7f00:0001::", true},  // 127.0.0.1
		{"2002:0808:0808::", false}, // 8.8.8.8
		// IPv4-compatible (deprecated, still parsed).
		{"::127.0.0.1", true},
		{"::10.0.0.1", true},
		{"::8.8.8.8", false},
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if ip == nil {
			t.Fatalf("bad test IP %q", c.ip)
		}
		if got := IsDisallowedIP(ip); got != c.blocked {
			t.Errorf("IsDisallowedIP(%s) = %v, want %v", c.ip, got, c.blocked)
		}
	}
	if !IsDisallowedIP(nil) {
		t.Errorf("IsDisallowedIP(nil) = false, want true")
	}
}

func TestSafeDialContext_BlocksLiteralPrivateIP(t *testing.T) {
	dial := DialContext(&net.Dialer{})
	_, err := dial(context.Background(), "tcp", "169.254.169.254:443")
	if err == nil {
		t.Fatal("expected dial to a metadata IP to be blocked, got nil error")
	}
	if !strings.Contains(err.Error(), "blocked") {
		t.Errorf("expected a 'blocked' error, got %v", err)
	}
}

func TestDialContextRejectsPrivateResolution(t *testing.T) {
	d := DialContext(&net.Dialer{})
	// 127.0.0.1 as a literal takes the literal branch; assert it is refused.
	_, err := d(context.Background(), "tcp", "127.0.0.1:80")
	if err == nil {
		t.Fatal("expected loopback to be refused")
	}
	if !strings.Contains(err.Error(), "blocked address") {
		t.Errorf("expected error to mention 'blocked address', got %v", err)
	}
}

func TestDialContextRejectsHostnameThatResolvesToPrivate(t *testing.T) {
	d := DialContext(&net.Dialer{})
	// "localhost" goes through the hostname lookup branch and resolves to
	// loopback addresses. The ANY-resolved-IP rejection loop must catch it.
	_, err := d(context.Background(), "tcp", "localhost:80")
	if err == nil {
		t.Fatal("expected localhost to be refused")
	}
	if !strings.Contains(err.Error(), "blocked address") {
		t.Errorf("expected error to mention 'blocked address', got %v", err)
	}
	if !strings.Contains(err.Error(), "localhost") {
		t.Errorf("expected error to mention host name 'localhost', got %v", err)
	}
}

// TestTransportDisablesProxy guards against the blocklist being silently
// bypassed by an HTTP(S)_PROXY environment variable: with Proxy left as
// http.ProxyFromEnvironment, the dialer would validate the PROXY's address
// (which passes) while the proxy itself resolves and connects to the
// attacker-chosen host, never touching our blocklist.
func TestTransportDisablesProxy(t *testing.T) {
	tr := Transport()
	if tr.Proxy != nil {
		t.Fatal("Transport().Proxy must be nil: a configured proxy would resolve the target outside the SSRF blocklist")
	}
}

func TestAlternativeIPv4LiteralsAreNotParsedAsIPs(t *testing.T) {
	// These never take DialContext's literal-IP branch. They are resolved
	// as hostnames, and what they resolve to is validated like any other
	// name. On macOS, 0177.0.0.1 resolves to 177.0.0.1 (a public address,
	// not 127.0.0.1), so it is pinned here and not dialed.
	for _, s := range []string{"0177.0.0.1", "2130706433", "0x7f.0.0.1"} {
		if ip := net.ParseIP(s); ip != nil {
			t.Errorf("net.ParseIP(%q) = %v, want nil", s, ip)
		}
	}
}

func TestDialContextRefusesLoopbackSpelledAsDecimalOrHex(t *testing.T) {
	d := DialContext(&net.Dialer{Timeout: 2 * time.Second})
	for _, host := range []string{"2130706433", "0x7f.0.0.1"} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		conn, err := d(ctx, "tcp", net.JoinHostPort(host, "80"))
		cancel()
		if err == nil {
			conn.Close()
			t.Fatalf("dial %s: connected, want refusal", host)
		}
		// Two acceptable outcomes. Either the resolver reads the literal as
		// 127.0.0.1 (macOS does) and the blocklist refuses it, or the
		// resolver treats it as an unknown name. A connection-refused error
		// is NOT acceptable: that would mean we dialed loopback.
		var dnsErr *net.DNSError
		if !strings.Contains(err.Error(), "blocked address") && !errors.As(err, &dnsErr) {
			t.Fatalf("dial %s: %v, want a blocked-address or DNS error", host, err)
		}
	}
}
