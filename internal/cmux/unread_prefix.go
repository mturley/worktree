package cmux

import "strings"

// UnreadPrefix marks a workspace whose worktree has unread resources. It lives
// only in cmux: internal/webui's unread sync adds and removes it, and
// DisplayTitle strips it, so nothing the web UI shows or edits ever has it.
//
// A title the user writes themselves starting with this prefix is
// indistinguishable from one the sync added; that is accepted.
const UnreadPrefix = "📬 "

// StripUnreadPrefix removes one UnreadPrefix, if present.
func StripUnreadPrefix(title string) string {
	return strings.TrimPrefix(title, UnreadPrefix)
}

// WithUnreadPrefix returns title with exactly one UnreadPrefix when on, and
// none when off. Nothing else about the title changes.
func WithUnreadPrefix(title string, on bool) string {
	bare := StripUnreadPrefix(title)
	if on {
		return UnreadPrefix + bare
	}
	return bare
}

// HasUnreadPrefix reports whether the workspace's custom title carries the
// prefix. Auto-titled workspaces (no custom title) never get one, so cmux's
// own title is not consulted.
func (w Workspace) HasUnreadPrefix() bool {
	return strings.HasPrefix(w.CustomTitle, UnreadPrefix)
}
