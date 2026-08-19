package webui

import (
	"fmt"
	"regexp"
	"strconv"

	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/slackurl"
)

// prURLPattern mirrors cmd/root.go's prURLPattern (kept in sync — the CLI is
// the source of truth for the PR id format). Extracts owner/repo/number from a
// GitHub PR URL.
var prURLPattern = regexp.MustCompile(`github\.com/([^/]+)/([^/]+)/pull/(\d+)`)

// inferResource infers a worktree resource (type, id) from a pasted URL,
// matching the CLI's `worktree add` behavior so a UI-added and CLI-added
// resource share the same id. Returns ok=false for an unrecognized URL.
func inferResource(rawURL string) (resType, id string, ok bool) {
	if m := prURLPattern.FindStringSubmatch(rawURL); m != nil {
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
