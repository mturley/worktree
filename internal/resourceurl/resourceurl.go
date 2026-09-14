// Package resourceurl maps a pasted URL to the worktree resource it names.
//
// It exists because three callers need the same answer — the CLI (`worktree
// resources add`), the web UI's add-resource handler, and the creation runner
// — and the previous arrangement had webui hand-copying cmd/root.go's PR
// pattern with a comment promising to keep them in sync. One detector, no
// promise to keep.
package resourceurl

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/slackurl"
)

// PRURLPattern extracts owner/repo/number from a GitHub PR URL.
var PRURLPattern = regexp.MustCompile(`github\.com/([^/]+)/([^/]+)/pull/(\d+)`)

// Infer returns the resource type and id a URL names, or ok=false when the URL
// matches nothing known.
func Infer(rawURL string) (resType, id string, ok bool) {
	if m := PRURLPattern.FindStringSubmatch(rawURL); m != nil {
		number, _ := strconv.Atoi(m[3])
		return "pr", fmt.Sprintf("%s/%s#%d", m[1], m[2], number), true
	}
	if key, ok := jira.ParseJiraURL(rawURL); ok {
		return "jira", key, true
	}
	if ch, ts, ok := slackurl.Parse(rawURL); ok {
		return "slack", slackurl.ResourceID(ch, ts), true
	}
	return "", "", false
}

// NormalizeLinkURL canonicalises a URL for use as a link resource's ID, so
// that following the same page twice reuses one resource.
//
// Deliberately conservative: it lowercases the scheme and host, drops a
// default port, and strips the fragment (which never reaches the server, so
// two URLs differing only by fragment are the same page). It does NOT touch
// the query — `?id=2` is a different page, and there is no way to know which
// parameters are tracking noise.
func NormalizeLinkURL(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	if u.Hostname() == "" {
		return "", false
	}
	u.Scheme = scheme
	u.Host = strings.ToLower(u.Host)
	if (scheme == "http" && u.Port() == "80") || (scheme == "https" && u.Port() == "443") {
		u.Host = u.Hostname()
	}
	u.Fragment = ""
	u.RawFragment = ""
	return u.String(), true
}

// InferAny is Infer with a fallback: any remaining absolute http(s) URL is a
// `link` resource, identified by its normalized form.
//
// Separate from Infer on purpose. Infer's callers rely on it REJECTING what
// it does not recognise — `worktree add ./typo-path` must stay an error, not
// become a followed page — so the fallback is opt-in per caller.
func InferAny(raw string) (resType, id string, ok bool) {
	if t, i, ok := Infer(raw); ok {
		return t, i, true
	}
	if norm, ok := NormalizeLinkURL(raw); ok {
		return "link", norm, true
	}
	return "", "", false
}
