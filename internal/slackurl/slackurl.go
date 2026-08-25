// Package slackurl parses Slack thread permalinks into worktree resource
// identifiers.
package slackurl

import "regexp"

var threadRe = regexp.MustCompile(`/archives/([A-Z0-9]+)/p(\d+)`)

// threadTSRe pulls the explicit thread_ts query param Slack appends when a
// link points at a REPLY rather than at the thread's root. Slack sometimes
// HTML-escapes the separator ("&amp;"), so the value is bounded by a
// character class rather than by "&".
var threadTSRe = regexp.MustCompile(`[?&](?:amp;)?thread_ts=([0-9.]+)`)

// Parse extracts channel id + thread_ts from a Slack permalink.
// e.g. .../archives/C0123ABCD/p1699999999000100 -> ("C0123ABCD","1699999999.000100").
func Parse(url string) (channel, threadTS string, ok bool) {
	m := threadRe.FindStringSubmatch(url)
	if m == nil {
		return "", "", false
	}
	// A link to a reply carries the thread's root in thread_ts, and the ROOT
	// is what we track — a reply is not its own thread. The frontend's
	// parseThreadUrl already worked this way; this parser did not, so a
	// thread added from a reply link was stored under an id the UI never
	// looked for and the "already tracked?" check could never match.
	if tm := threadTSRe.FindStringSubmatch(url); tm != nil {
		return m[1], tm[1], true
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
