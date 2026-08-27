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
	"regexp"
	"strconv"

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
