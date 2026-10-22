package webui

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/tasks"
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
	counts map[string]unread.Summary
	// Per-thread counts of replies newer than Slack's cursor; see fill for
	// how they are reconciled with has_unread.
	slackCounts map[string]int
	cursors     map[string]string
	// Slack's own cursors, from cached poller state — a separate map because
	// they are compared against a different column (see unread.SlackCursors).
	slack map[string]string
	// mine is the user's own ID per source (internal/selfid); their events
	// are never unread.
	mine map[string]string

	// Task unread, loaded on first use (see loadTasks): most requests that
	// build an index never ask about tasks.
	db          *sql.DB
	logger      *log.Logger
	tasksLoaded bool
	taskSums    map[int64]unread.Summary // unread.TaskSummaries
	taskScope   tasks.ScopeIndex         // which tasks each worktree/resource holds
}

// loadTasks reads every task's unread summary and every scope's task
// membership, once per index: one query plus one tasks load, however many
// worktrees and resources the request then asks about. A failure degrades to
// "no task unread", like every other read here.
func (ix *unreadIndex) loadTasks() {
	if ix.tasksLoaded {
		return
	}
	ix.tasksLoaded = true
	ix.taskSums = map[int64]unread.Summary{}
	if ix.db == nil {
		return
	}
	sums, err := unread.TaskSummaries(ix.db)
	if err != nil {
		ix.logf("unread.TaskSummaries: %v", err)
		return
	}
	ix.taskSums = sums
	if len(sums) == 0 {
		return // nothing unread: membership cannot change any count
	}
	sc, err := tasks.BuildScopeIndex(ix.db)
	if err != nil {
		ix.logf("tasks.BuildScopeIndex: %v", err)
		return
	}
	ix.taskScope = sc
}

func (ix *unreadIndex) logf(format string, args ...any) {
	if ix.logger != nil {
		ix.logger.Printf(format, args...)
	}
}

// sumTasks is the total unread count of the tasks ids.
func (ix *unreadIndex) sumTasks(ids []int64) int {
	n := 0
	for _, id := range ids {
		n += ix.taskSums[id].Count
	}
	return n
}

// resourceTaskUnread is the unread task events of the (non-deleted, open or
// done) tasks linking resource typ:id.
func (ix *unreadIndex) resourceTaskUnread(typ, id string) int {
	if ix == nil {
		return 0
	}
	ix.loadTasks()
	return ix.sumTasks(ix.taskScope.ByResource[typ+":"+id])
}

// worktreeTaskUnread is the unread task events of the DISTINCT tasks in
// path's scope (linked directly or implicitly, or the archived fallback).
// Not the sum over the worktree's resources: a task linking two of them
// counts once. Exact, since every task event belongs to exactly one task.
func (ix *unreadIndex) worktreeTaskUnread(path string) int {
	if ix == nil {
		return 0
	}
	ix.loadTasks()
	canon, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(path))
	return ix.sumTasks(ix.taskScope.ByWorktree[canon])
}

func (s *Server) newUnreadIndex() *unreadIndex {
	ix := &unreadIndex{
		counts:      map[string]unread.Summary{},
		slackCounts: map[string]int{},
		cursors:     map[string]string{},
		slack:       map[string]string{},
		mine:        map[string]string{},
		db:          s.DB,
		logger:      s.Logger,
	}
	if m, err := selfid.Load(s.DB); err == nil {
		ix.mine = m
	} else if s.Logger != nil {
		s.Logger.Printf("selfid.Load: %v", err)
	}
	if c, err := unread.Summaries(s.DB); err == nil {
		ix.counts = c
	} else if s.Logger != nil {
		s.Logger.Printf("unread.Summaries: %v", err)
	}
	if c, err := unread.Cursors(s.DB); err == nil {
		ix.cursors = c
	} else if s.Logger != nil {
		s.Logger.Printf("unread.Cursors: %v", err)
	}
	if c, err := unread.SlackCounts(s.DB); err == nil {
		ix.slackCounts = c
	} else if s.Logger != nil {
		s.Logger.Printf("unread.SlackCounts: %v", err)
	}
	if c, err := unread.SlackCursors(s.DB); err == nil {
		ix.slack = c
	} else if s.Logger != nil {
		s.Logger.Printf("unread.SlackCursors: %v", err)
	}
	return ix
}

// fill sets a resource DTO's unread_count (and, for cursor-owning types,
// unread_through_ts). Every endpoint that returns a resource goes through
// here, so a resource counts the same on its card, in its worktree's total,
// on a timeline chip and in mark-all-read.
//
// A Slack thread's count is the replies newer than Slack's cursor, as the
// timelines mark them — but reconciled with has_unread, which is Slack's own
// verdict and drives the thread's dot. Slack says read: 0, whatever stale
// events say. Slack says unread: at least 1, because an unread message the
// poller never recorded as an event (an unread root, say) is still unread,
// and a dot with no number beside it would read as a bug. So the count and
// the dot cannot disagree. The DTO must already be enriched (HasUnread set)
// when this is called.
//
// Slack threads get no through_ts: Slack owns their cursor, and they are
// marked read through their cached latest message (updated_ts) instead.
//
// On top of its own events, a resource counts the unread task events of the
// tasks linking it (task_unread_count, also included in unread_count).
// through_ts stays the resource's own: a task's events are cleared through
// the task's cursor (POST /api/task-read), never the resource's. Slack's
// has_unread is left as Slack's verdict; resourceHasUnread reads the task
// count beside it.
func (ix *unreadIndex) fill(dto *resourceDTO) {
	if ix == nil {
		return
	}
	key := unread.Key(dto.Type, dto.ID)
	dto.TaskUnreadCount = ix.resourceTaskUnread(dto.Type, dto.ID)
	if dto.Type == "slack" {
		dto.UnreadCount = 0
		if dto.HasUnread {
			dto.UnreadCount = max(ix.slackCounts[key], 1)
		}
		dto.UnreadCount += dto.TaskUnreadCount
		return
	}
	sum := ix.counts[key]
	dto.UnreadCount = sum.Count + dto.TaskUnreadCount
	dto.UnreadThroughTS = sum.NewestTS
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
func (ix *unreadIndex) IsUnread(resType, id, ts, externalTS, eventType, source, authorID string) bool {
	if ix == nil {
		return false
	}
	// The user's own events and CI runs still in progress are never unread:
	// the Go twins of selfid.NotMineSQL and unread.NotPendingCISQL, so the
	// unread-only SQL and this flag agree.
	if selfid.IsMine(ix.mine, source, authorID) || unread.IsPendingCI(eventType) {
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
// is counted against worktree's per-resource cursor. Either way, unread task
// events of the tasks linking the resource (TaskUnreadCount) count too.
//
// Kept beside IsUnread rather than in internal/unread because it needs a
// resourceDTO — the enrichment step is what turns cached Slack state into the
// HasUnread bool this reads.
func resourceHasUnread(dto resourceDTO) bool {
	if dto.Type == "slack" {
		return dto.HasUnread || dto.TaskUnreadCount > 0
	}
	return dto.UnreadCount > 0
}

// resourceReadResponse is what a mark-read did to the cursor, handed back so
// the client can offer to undo it (POST /api/resource-read/restore).
// previous_ts is null when the resource had no cursor before.
type resourceReadResponse struct {
	PreviousTS *string `json:"previous_ts"`
	LastReadTS string  `json:"last_read_ts"`
}

// handleResourceRead: POST /api/resource-read, body
// {"type":..., "id":..., "through_ts":...} -> 200 resourceReadResponse.
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
	ch, err := unread.Mark(s.DB, req.Type, req.ID, req.ThroughTS)
	if err != nil {
		if errors.Is(err, unread.ErrSlackNotSupported) {
			// Bad input, not a server fault: Slack owns this thread's read
			// state and the thread view is where it is cleared.
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resourceReadResponse{PreviousTS: ch.Previous, LastReadTS: ch.Current})
}

// handleResourceReadRestore: POST /api/resource-read/restore, body
// {"type":..., "id":..., "last_read_ts":..., "previous_ts":...|null} -> 204,
// the undo of a POST /api/resource-read, echoing back what it returned.
//
// 409 when the cursor has moved on since (see unread.Restore): a read made
// after the one being undone is never rewound past.
func (s *Server) handleResourceReadRestore(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type       string  `json:"type"`
		ID         string  `json:"id"`
		LastReadTS string  `json:"last_read_ts"`
		PreviousTS *string `json:"previous_ts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Type == "" || req.ID == "" || req.LastReadTS == "" {
		writeError(w, http.StatusBadRequest, "type, id and last_read_ts are required")
		return
	}
	err := unread.Restore(s.DB, req.Type, req.ID, req.LastReadTS, req.PreviousTS)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, unread.ErrSlackNotSupported):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, unread.ErrCursorMoved):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}
