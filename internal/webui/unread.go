package webui

import (
	"github.com/mturley/worktree/internal/unread"
)

// unreadIndex answers "how many unread?" and "is this event unread?" for ONE
// request, from two queries taken up front.
//
// Request-scoped for the same reason eventEnricher is (see timeline.go): its
// contents change whenever the poller writes events or anyone moves a cursor,
// including from OTHER PROCESSES writing this same SQLite file (`worktree
// resources mark-read`, agent-handler's shell-outs). Hanging it off Server
// would need invalidation this process cannot observe. At request scope there
// is nothing to invalidate — the next request builds a fresh one.
//
// A read failure yields an empty index, which degrades to "nothing unread".
// That is the same direction every other enrichment failure here degrades:
// a missing dot is a smaller lie than a wrong one.
type unreadIndex struct {
	counts  map[string]int
	cursors map[string]string
}

func (s *Server) newUnreadIndex() *unreadIndex {
	ix := &unreadIndex{counts: map[string]int{}, cursors: map[string]string{}}
	if c, err := unread.Counts(s.DB); err == nil {
		ix.counts = c
	} else if s.Logger != nil {
		s.Logger.Printf("unread.Counts: %v", err)
	}
	if c, err := unread.Cursors(s.DB); err == nil {
		ix.cursors = c
	} else if s.Logger != nil {
		s.Logger.Printf("unread.Cursors: %v", err)
	}
	return ix
}

// Count returns the unread event count for a resource, 0 when it has no
// cursor (Slack threads, and anything never seeded).
func (ix *unreadIndex) Count(resType, id string) int {
	if ix == nil {
		return 0
	}
	return ix.counts[unread.Key(resType, id)]
}

// IsUnread reports whether one event is newer than its resource's cursor.
//
// Always false for a Slack resource: Slack's read state is a message ts held
// in the thread, and the cached state carries only the derived has_unread
// boolean — there is no per-message cursor here to compare against. A Slack
// thread's unread state reaches the timeline through its resource chip
// instead.
func (ix *unreadIndex) IsUnread(resType, id, ts string) bool {
	if ix == nil || resType == "slack" {
		return false
	}
	cursor, ok := ix.cursors[unread.Key(resType, id)]
	if !ok {
		return false
	}
	return ts > cursor
}
