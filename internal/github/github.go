package github

import (
	"regexp"
	"strconv"
	"strings"
)

// PRInfo is what creating a worktree from a pull request needs. It is read
// with the watcher's GitHub token (internal/worktreenew/prfetch.go), not the
// gh CLI, which worktree no longer requires.
type PRInfo struct {
	Number  int
	Title   string
	URL     string
	HeadRef string
	State   string
	Body    string
}

var prURLPattern = regexp.MustCompile(`github\.com/([^/]+)/([^/]+)/pull/(\d+)`)

func ParsePRURL(url string) (owner, repo string, number int, ok bool) {
	m := prURLPattern.FindStringSubmatch(url)
	if m == nil {
		return "", "", 0, false
	}
	n, _ := strconv.Atoi(m[3])
	return m[1], m[2], n, true
}

func IsPRNumber(s string) bool {
	_, err := strconv.Atoi(s)
	return err == nil && len(s) > 0
}

func Slugify(title string) string {
	s := strings.ToLower(title)
	s = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 50 {
		s = s[:50]
		if last := strings.LastIndex(s, "-"); last > 20 {
			s = s[:last]
		}
	}
	return s
}
