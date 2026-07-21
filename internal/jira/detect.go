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
		matches := pattern.FindAllString(source, -1)
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
