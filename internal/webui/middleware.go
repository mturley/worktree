package webui

import (
	"mime"
	"net/http"
	"net/url"
	"strings"
)

// guardMutations blocks requests that a page other than our own could have
// CAUSED. It answers a different question from authentication ("who may make
// this call") and is not superseded by it.
//
// Two checks:
//
//  1. A request with a body must declare application/json. A cross-origin
//     caller cannot set that header without triggering a CORS preflight, and
//     this server answers no preflight — so the request never leaves the
//     browser. Without it, a simple-content-type request sails through:
//     unreadable to the attacker, but its side effect still happens.
//  2. Sec-Fetch-Site must not be cross-site, with an Origin comparison as a
//     fallback for clients that do not send it.
//
// GET and HEAD are untouched: they carry no body and must not mutate.
func guardMutations(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			h.ServeHTTP(w, r)
			return
		}
		switch strings.ToLower(r.Header.Get("Sec-Fetch-Site")) {
		case "cross-site", "same-site":
			// same-site is refused too: SameSite cookies ignore the port, so
			// another service on this host is "same-site" but is not us.
			http.Error(w, "cross-site request refused", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !sameOrigin(origin, r) {
			http.Error(w, "cross-origin request refused", http.StatusForbidden)
			return
		}
		ct := r.Header.Get("Content-Type")
		if mt, _, err := mime.ParseMediaType(ct); err != nil || mt != "application/json" {
			http.Error(w, "expected Content-Type: application/json", http.StatusUnsupportedMediaType)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// sameOrigin compares an Origin header against the request's own host.
// Origin includes the port, which is exactly why it is checked alongside
// Sec-Fetch-Site.
func sameOrigin(origin string, r *http.Request) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return u.Host == r.Host
}
