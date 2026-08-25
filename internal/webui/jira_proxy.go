package webui

import (
	"net/http"
	"net/url"

	wconfig "github.com/mturley/watcher/config"
)

// handleJiraIcon proxies an issue-type icon from the configured Jira host.
//
// Note: /rest/api/2/universal_avatar/... turned out to be readable WITHOUT
// auth on the instance this was built against — verified directly, byte
// identical to the proxied response. So the usual justification (agent-handler
// abandoned real icons because icon URLs 401 in a browser <img>) does not hold
// universally, and a plain <img src=iconUrl> would work there today.
//
// The proxy is kept anyway, for reasons that survive that finding:
//   - Other deployments are not so permissive. Jira Server/Data Center and
//     the older /secure/viewavatar and /images/icons/issuetypes/ URL shapes
//     do require auth; attaching Basic auth costs nothing where it is not
//     needed and is the difference between icons and broken images where it
//     is.
//   - A direct <img> makes every resource card a request to the Jira host
//     carrying the user ambient cookies, from the app page. Proxying keeps
//     the browser talking only to us.
//
// The allowed host is derived from the configured Jira host rather than being
// a constant: it is deployment-specific, and pinning to it means a state row
// carrying some other host's URL cannot make us fetch it.
func (s *Server) handleJiraIcon(w http.ResponseWriter, r *http.Request) {
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		http.Error(w, "jira not configured", http.StatusServiceUnavailable)
		return
	}
	jc, err := cfg.Jira()
	if err != nil {
		http.Error(w, "jira not configured", http.StatusServiceUnavailable)
		return
	}
	base, err := url.Parse(jc.Host)
	if err != nil || base.Host == "" {
		http.Error(w, "jira host misconfigured", http.StatusServiceUnavailable)
		return
	}

	// Issue-type icons are immutable for the life of an issue type, and a
	// resource list can request the same handful of them repeatedly.
	w.Header().Set("Cache-Control", "public, max-age=86400")

	s.handleImageProxyAuth(base.Host, func(req *http.Request) {
		req.SetBasicAuth(jc.Email, jc.Token)
	})(w, r)
}
