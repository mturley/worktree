// Package netdetect finds the addresses another device on the LAN would use
// to reach this machine, so setup can offer them rather than asking.
package netdetect

import (
	"net"
	"os/exec"
	"runtime"
	"strings"
)

// Seams for tests.
var (
	goos      = runtime.GOOS
	runScutil = func() (string, error) {
		out, err := exec.Command("scutil", "--get", "LocalHostName").Output()
		return string(out), err
	}
	// Dialing UDP picks a route and a local address without sending a
	// packet. 192.0.2.1 is TEST-NET-1 (RFC 5737), which nothing answers.
	dialUDP = func() (net.Addr, error) {
		c, err := net.Dial("udp4", "192.0.2.1:9")
		if err != nil {
			return nil, err
		}
		defer c.Close()
		return c.LocalAddr(), nil
	}
)

// LocalName returns this Mac's mDNS name, e.g. "mturley-mac.local". It reads
// LocalHostName rather than os.Hostname(): the plain hostname can be handed
// out by the network and drift from the name mDNS advertises. macOS only.
func LocalName() (string, bool) {
	if goos != "darwin" {
		return "", false
	}
	out, err := runScutil()
	if err != nil {
		return "", false
	}
	name := strings.TrimSpace(out)
	if name == "" {
		return "", false
	}
	return name + ".local", true
}

// LANIP returns the IPv4 address of the interface that routes outbound.
func LANIP() (net.IP, bool) {
	addr, err := dialUDP()
	if err != nil {
		return nil, false
	}
	u, ok := addr.(*net.UDPAddr)
	if !ok || u.IP == nil {
		return nil, false
	}
	v4 := u.IP.To4()
	if v4 == nil || v4.IsLoopback() || v4.IsUnspecified() {
		return nil, false
	}
	return v4, true
}

// Candidates returns the detected addresses, the .local name first: it
// survives the router handing out a different IP.
func Candidates() []string {
	var out []string
	if name, ok := LocalName(); ok {
		out = append(out, name)
	}
	if ip, ok := LANIP(); ok {
		out = append(out, ip.String())
	}
	return out
}
