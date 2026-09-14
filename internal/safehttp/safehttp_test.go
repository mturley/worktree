package safehttp

import (
	"context"
	"net"
	"strings"
	"testing"
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
