// Package slackurl parses Slack thread permalinks into worktree resource
// identifiers.
package slackurl

import "regexp"

var threadRe = regexp.MustCompile(`/archives/([A-Z0-9]+)/p(\d+)`)

// Parse extracts channel id + thread_ts from a Slack permalink.
// e.g. .../archives/C0123ABCD/p1699999999000100 -> ("C0123ABCD","1699999999.000100").
func Parse(url string) (channel, threadTS string, ok bool) {
	m := threadRe.FindStringSubmatch(url)
	if m == nil {
		return "", "", false
	}
	raw := m[2] // e.g. 1699999999000100
	if len(raw) <= 6 {
		return "", "", false
	}
	threadTS = raw[:len(raw)-6] + "." + raw[len(raw)-6:]
	return m[1], threadTS, true
}

// ResourceID is the worktree resource ID for a Slack thread.
func ResourceID(channel, threadTS string) string { return channel + ":" + threadTS }
