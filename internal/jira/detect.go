package jira

import (
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"

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

// aliasBrowsePath is an issue page's path on an alias host.
var aliasBrowsePath = regexp.MustCompile(`(?i)^/browse/([A-Z][A-Z0-9]*-\d+)/?$`)

// aliasHosts holds the lowercased extra hosts whose /browse/KEY pages are Jira
// issues — typically an instance's old address that now redirects to its
// atlassian.net one (e.g. a Jira Server host kept alive after a migration to
// Cloud), so links written before the move are still recognised.
var aliasHosts atomic.Pointer[map[string]bool]

// SetAliasHosts sets the extra Jira hosts (config `jira.alias_hosts`). Called
// once at startup; nil clears them. Matching is on the URL's host exactly,
// not a substring, so an alias can't be spoofed from another URL's query.
func SetAliasHosts(hosts []string) {
	m := map[string]bool{}
	for _, h := range hosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			m[h] = true
		}
	}
	aliasHosts.Store(&m)
}

func ParseJiraURL(raw string) (key string, ok bool) {
	if m := jiraURLPattern.FindStringSubmatch(raw); m != nil {
		return strings.ToUpper(m[1]), true
	}
	return parseAliasURL(raw)
}

func parseAliasURL(raw string) (string, bool) {
	hosts := aliasHosts.Load()
	if hosts == nil || len(*hosts) == 0 {
		return "", false
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !(*hosts)[strings.ToLower(u.Hostname())] {
		return "", false
	}
	m := aliasBrowsePath.FindStringSubmatch(u.Path)
	if m == nil {
		return "", false
	}
	return strings.ToUpper(m[1]), true
}

func IsJiraURL(s string) bool {
	_, ok := ParseJiraURL(s)
	return ok
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
