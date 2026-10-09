package linked

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/mturley/watcher"
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
// in order, deduplicated (see ExtractMarkdownLinks for what is ignored).
func ExtractMarkdownURLs(body string) []string {
	return watcher.DedupeLinkURLs(ExtractMarkdownLinks(body))
}

// Classify is ClassifyLinks for bare URLs, which carry no context.
func Classify(urls []string, self Key) []Item {
	refs := make([]watcher.LinkRef, len(urls))
	for i, u := range urls {
		refs[i] = watcher.LinkRef{URL: u, Label: u}
	}
	return ClassifyLinks(refs, self)
}

// ClassifyLinks turns link occurrences into Items: PR / Jira / Slack thread
// via the shared resourceurl detector, anything else http(s) as a link.
// Items are deduplicated by (type, id) — so ".../pull/2" and
// ".../pull/2/files" are one row — and the resource itself (self) is
// dropped. The FIRST occurrence of each decides its Context (see
// contextFor). Non-link items start unresolved; links are "resolved" from
// the start because a URL + domain is already a complete row (titles are an
// optional extra).
func ClassifyLinks(refs []watcher.LinkRef, self Key) []Item {
	var out []Item
	seen := map[Key]bool{self: true}
	for _, ref := range refs {
		raw := ref.URL
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
			it.Context = contextFor(ref, false, prKeyForms(id)...)
		case "jira":
			it.Context = contextFor(ref, false, id)
		case "slack":
			it.Context = contextFor(ref, false)
		case "link":
			it.URL = id
			it.Resolved = true
			if u, err := url.Parse(id); err == nil {
				it.Domain = u.Hostname()
			}
			it.Context = contextFor(ref, true)
		}
		out = append(out, it)
	}
	return out
}

// prKeyForms are the ways a PR "owner/repo#N" is commonly written as a
// label: "#N", "repo#N" and "owner/repo#N".
func prKeyForms(id string) []string {
	hash := strings.LastIndex(id, "#")
	if hash < 0 {
		return []string{id}
	}
	forms := []string{id, id[hash:]}
	if slash := strings.Index(id, "/"); slash >= 0 && slash < hash {
		forms = append(forms, id[slash+1:])
	}
	return forms
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
