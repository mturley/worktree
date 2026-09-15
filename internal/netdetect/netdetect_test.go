package netdetect

import (
	"errors"
	"net"
	"strings"
	"testing"
)

// stub replaces the package's seams for one test.
func stub(t *testing.T, os string, scutil func() (string, error), udp func() (net.Addr, error)) {
	t.Helper()
	oldOS, oldScutil, oldUDP := goos, runScutil, dialUDP
	goos, runScutil, dialUDP = os, scutil, udp
	t.Cleanup(func() { goos, runScutil, dialUDP = oldOS, oldScutil, oldUDP })
}

func udpAddr(ip string) func() (net.Addr, error) {
	return func() (net.Addr, error) { return &net.UDPAddr{IP: net.ParseIP(ip), Port: 50000}, nil }
}

func TestCandidatesOnMac(t *testing.T) {
	stub(t, "darwin", func() (string, error) { return "mturley-mac\n", nil }, udpAddr("192.168.86.21"))
	if got := strings.Join(Candidates(), ","); got != "mturley-mac.local,192.168.86.21" {
		t.Fatalf("Candidates = %q", got)
	}
}

func TestNoLocalNameOffMac(t *testing.T) {
	called := false
	stub(t, "linux", func() (string, error) { called = true; return "box", nil }, udpAddr("10.0.0.7"))
	if name, ok := LocalName(); ok || name != "" {
		t.Fatalf("LocalName = %q, %v; want none off macOS", name, ok)
	}
	if called {
		t.Fatal("scutil was run off macOS")
	}
	if got := strings.Join(Candidates(), ","); got != "10.0.0.7" {
		t.Fatalf("Candidates = %q", got)
	}
}

func TestScutilFailureIsNotAnError(t *testing.T) {
	stub(t, "darwin", func() (string, error) { return "", errors.New("exit status 1") }, udpAddr("10.0.0.7"))
	if _, ok := LocalName(); ok {
		t.Fatal("LocalName reported a name after scutil failed")
	}
	stub(t, "darwin", func() (string, error) { return "  \n", nil }, udpAddr("10.0.0.7"))
	if _, ok := LocalName(); ok {
		t.Fatal("LocalName reported a name for blank scutil output")
	}
}

func TestLANIPRejectsUnusableAddresses(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "0.0.0.0", "fe80::1"} {
		stub(t, "darwin", func() (string, error) { return "", errors.New("x") }, udpAddr(ip))
		if got, ok := LANIP(); ok {
			t.Errorf("LANIP with local address %s = %v, want none", ip, got)
		}
	}
	stub(t, "darwin", func() (string, error) { return "", errors.New("x") },
		func() (net.Addr, error) { return nil, errors.New("network is unreachable") })
	if _, ok := LANIP(); ok {
		t.Error("LANIP reported an address with no route")
	}
	if got := Candidates(); len(got) != 0 {
		t.Errorf("Candidates = %v, want none", got)
	}
}
