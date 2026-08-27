package jira

import (
	"regexp"
	"strings"

	"github.com/mturley/worktree/internal/resources"
)

func DetectKeys(branch, prTitle, prBody string, projects []string) []string {
	if len(projects) == 0 {
		return nil
	}

	pattern := buildPattern(projects)
	seen := make(map[string]bool)
	var keys []string

	for _, source := range []string{branch, prTitle, prBody} {
		matches := pattern.FindAllString(stripHTMLComments(source), -1)
		for _, m := range matches {
			m = strings.ToUpper(m)
			if !seen[m] {
				seen[m] = true
				keys = append(keys, m)
			}
		}
	}
	return keys
}

// htmlCommentPattern matches HTML comment blocks, including unterminated ones
// that run to the end of the input. PR body templates (e.g. odh-dashboard) put
// example Jira keys inside <!-- ... --> comments, which must not be detected as
// tracked resources.
var htmlCommentPattern = regexp.MustCompile(`(?s)<!--.*?(-->|$)`)

// stripHTMLComments removes HTML comment blocks so keys inside them are ignored.
func stripHTMLComments(s string) string {
	return htmlCommentPattern.ReplaceAllString(s, "")
}

var jiraURLPattern = regexp.MustCompile(`(?i)atlassian\.net/browse/([A-Z]+-\d+)`)

func ParseJiraURL(url string) (key string, ok bool) {
	m := jiraURLPattern.FindStringSubmatch(url)
	if m == nil {
		return "", false
	}
	return strings.ToUpper(m[1]), true
}

func IsJiraURL(s string) bool {
	return jiraURLPattern.MatchString(s)
}

var keyPattern = regexp.MustCompile(`^([A-Z][A-Z0-9]+)-(\d+)$`)

// ParseKey reports whether s is a bare Jira issue key like "RHOAIENG-123".
func ParseKey(s string) (string, bool) {
	if keyPattern.MatchString(strings.ToUpper(s)) {
		return strings.ToUpper(s), true
	}
	return "", false
}

func DetectFromResources(res []resources.Resource) []string {
	var keys []string
	for _, r := range res {
		if r.Type == "jira" {
			keys = append(keys, r.ID)
		}
	}
	return keys
}

func buildPattern(projects []string) *regexp.Regexp {
	escaped := make([]string, len(projects))
	for i, p := range projects {
		escaped[i] = regexp.QuoteMeta(p)
	}
	pattern := "(?i)(" + strings.Join(escaped, "|") + ")-\\d+"
	return regexp.MustCompile(pattern)
}
