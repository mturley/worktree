package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

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
	// Slack's own cursors, from cached poller state — a separate map because
	// they are compared against a different column (see unread.SlackCursors).
	slack map[string]string
}

func (s *Server) newUnreadIndex() *unreadIndex {
	ix := &unreadIndex{
		counts:  map[string]int{},
		cursors: map[string]string{},
		slack:   map[string]string{},
	}
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
	if c, err := unread.SlackCursors(s.DB); err == nil {
		ix.slack = c
	} else if s.Logger != nil {
		s.Logger.Printf("unread.SlackCursors: %v", err)
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
// Two cursors, two clocks. A Slack thread's cursor is a Slack message ts and
// is compared against externalTS, the raw ts the reply carried; every other
// resource is compared against ts, the row's own recording time. Passing one
// clock's timestamp to the other's cursor silently marks everything read or
// everything unread, so the two paths never share a comparison.
//
// A resource with no cursor on either path is read: a missing cursor is
// absence of evidence, and a dot that cannot be explained is worse than no
// dot at all.
func (ix *unreadIndex) IsUnread(resType, id, ts, externalTS string) bool {
	if ix == nil {
		return false
	}
	if resType == "slack" {
		cursor, ok := ix.slack[unread.Key(resType, id)]
		if !ok || externalTS == "" {
			return false
		}
		return slackTSGreater(externalTS, cursor)
	}
	cursor, ok := ix.cursors[unread.Key(resType, id)]
	if !ok {
		return false
	}
	return ts > cursor
}

// slackTSGreater compares two Slack timestamps ("1788464505.422459").
//
// Not a string compare: Slack ts values are seconds.microseconds, and the
// second part grows a digit as time passes ("9999999999.x" sorts above
// "10000000000.x" lexically). Numeric parsing costs nothing here and removes
// a bug that would surface once, years from now, and be impossible to explain.
func slackTSGreater(a, b string) bool {
	af, aerr := strconv.ParseFloat(a, 64)
	bf, berr := strconv.ParseFloat(b, 64)
	if aerr != nil || berr != nil {
		return false
	}
	return af > bf
}

// resourceHasUnread answers, for one enriched resource, the question the
// frontend's hasUnread() answers: two sources, one verdict. A Slack thread's
// read state is Slack's own, cached on the DTO as HasUnread; everything else
// is counted against worktree's per-resource cursor.
//
// Kept beside IsUnread rather than in internal/unread because it needs a
// resourceDTO — the enrichment step is what turns cached Slack state into the
// HasUnread bool this reads.
func resourceHasUnread(dto resourceDTO) bool {
	if dto.Type == "slack" {
		return dto.HasUnread
	}
	return dto.UnreadCount > 0
}

// handleResourceRead: POST /api/resource-read, body
// {"type":..., "id":..., "through_ts":...} -> 204.
//
// through_ts is the newest event the CLIENT rendered. The server deliberately
// does NOT substitute its own MAX(ts): events that arrived between render and
// click must stay unread rather than being swallowed by a button that promised
// to clear a specific number.
func (s *Server) handleResourceRead(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type      string `json:"type"`
		ID        string `json:"id"`
		ThroughTS string `json:"through_ts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Type == "" || req.ID == "" {
		writeError(w, http.StatusBadRequest, "type and id are required")
		return
	}
	if req.ThroughTS == "" {
		writeError(w, http.StatusBadRequest, "through_ts is required")
		return
	}
	if err := unread.MarkRead(s.DB, req.Type, req.ID, req.ThroughTS); err != nil {
		if errors.Is(err, unread.ErrSlackNotSupported) {
			// Bad input, not a server fault: Slack owns this thread's read
			// state and the thread view is where it is cleared.
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
