package webui

import (
	"log"
	"net"
	"net/http"
	"strings"
)

// loopbackHosts are always accepted in the Host header.
var loopbackHosts = []string{"localhost", "127.0.0.1", "::1"}

// hostAllowed reports whether a Host header names this server. DNS
// rebinding serves an attacker's page under the attacker's hostname, so the
// hostname is what must match. The port is ignored on purpose: it varies
// legitimately between the two listeners and the Vite dev proxy.
func hostAllowed(hostHeader string, extra []string) bool {
	name := hostHeader
	if h, _, err := net.SplitHostPort(hostHeader); err == nil {
		name = h
	}
	name = strings.TrimSuffix(strings.TrimPrefix(name, "["), "]")
	name = strings.TrimSuffix(name, ".")
	if name == "" {
		return false
	}
	for _, list := range [][]string{loopbackHosts, extra} {
		for _, allowed := range list {
			if sameHost(name, allowed) {
				return true
			}
		}
	}
	return false
}

func sameHost(a, b string) bool {
	if strings.EqualFold(a, b) {
		return true
	}
	ia, ib := net.ParseIP(a), net.ParseIP(b)
	return ia != nil && ib != nil && ia.Equal(ib)
}

// hostGuard refuses a request whose Host is not allowed, before anything
// else sees it.
func hostGuard(extra []string, logger *log.Logger, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostAllowed(r.Host, extra) {
			if logger != nil {
				logger.Printf("refused a request for Host %q; if that name is yours, add it to ui.allowed_hosts in the worktree config", r.Host)
			}
			http.Error(w, "unrecognized Host header", http.StatusBadRequest)
			return
		}
		h.ServeHTTP(w, r)
	})
}
