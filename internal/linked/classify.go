package linked

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/mturley/worktree/internal/resourceurl"
)

var (
	htmlCommentPattern = regexp.MustCompile(`(?s)<!--.*?-->`)
	mdImagePattern     = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	htmlImgPattern     = regexp.MustCompile(`(?i)<img\b[^>]*>`)
	// Brackets and quotes end a URL, so markdown "[x](url)", autolinks
	// "<url>" and parenthesised URLs all yield just the URL.
	mdURLPattern = regexp.MustCompile("https?://[^\\s<>()\\[\\]\"'`]+")
)

// ExtractMarkdownURLs returns the URLs in a GitHub-flavoured markdown body,
// in order, deduplicated. Images (markdown or <img>) and HTML comments —
// PR templates are full of commented-out guidance — are ignored. Trailing
// sentence punctuation is trimmed.
func ExtractMarkdownURLs(body string) []string {
	body = htmlCommentPattern.ReplaceAllString(body, "")
	body = mdImagePattern.ReplaceAllString(body, "")
	body = htmlImgPattern.ReplaceAllString(body, "")
	var out []string
	seen := map[string]bool{}
	for _, u := range mdURLPattern.FindAllString(body, -1) {
		u = strings.TrimRight(u, ".,;:!?")
		if u != "" && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	return out
}

// Classify turns URLs into Items: PR / Jira / Slack thread via the shared
// resourceurl detector, anything else http(s) as a link. Items are
// deduplicated by (type, id) — so ".../pull/2" and ".../pull/2/files" are one
// row — and the resource itself (self) is dropped. Non-link items start
// unresolved; links are "resolved" from the start because a URL + domain is
// already a complete row (titles are an optional extra).
func Classify(urls []string, self Key) []Item {
	var out []Item
	seen := map[Key]bool{self: true}
	for _, raw := range urls {
		t, id, ok := resourceurl.InferAny(raw)
		if !ok {
			continue
		}
		k := Key{t, id}
		if seen[k] {
			continue
		}
		seen[k] = true
		it := Item{Type: t, ID: id, URL: raw}
		switch t {
		case "pr":
			// Canonical URL, so ".../pull/2/files" opens the PR itself.
			it.URL = canonicalPRURL(id, raw)
		case "link":
			it.URL = id
			it.Resolved = true
			if u, err := url.Parse(id); err == nil {
				it.Domain = u.Hostname()
			}
		}
		out = append(out, it)
	}
	return out
}

// canonicalPRURL rebuilds https://github.com/o/r/pull/N from "o/r#N".
func canonicalPRURL(id, fallback string) string {
	slash := strings.Index(id, "/")
	hash := strings.LastIndex(id, "#")
	if slash < 0 || hash < slash {
		return fallback
	}
	return "https://github.com/" + id[:hash] + "/pull/" + id[hash+1:]
}
