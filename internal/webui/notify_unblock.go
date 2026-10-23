package webui

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
)

// unblockHoldDefault is how long an "Unblocked" notification waits, from
// the notifier pass that finds its event, before it is sent, so an undo
// can withdraw it first (an undone completion deletes the event, and the
// recheck before sending drops it). It is the undo toast's window,
// UNDO_WINDOW_MS (10s, ui/src/components/UndoToast.tsx), plus the
// notifier's 5s scan interval, since the wait starts when a pass finds the
// event, up to one interval after it was written. Change them together.
const unblockHoldDefault = 10*time.Second + 5*time.Second

// pendingUnblock is an automatic blocker resolution found by a pass and
// held until due. Pending items live only in memory: a restart drops them
// (the new cursor starts past their events), which costs at most one
// notification per resolution made in the last hold window.
type pendingUnblock struct {
	eventID   int64
	taskID    int64
	blockerID int64
	due       time.Time
	body      string // "Unblocked: <label> <reason>"
}

func (s *Server) unblockHoldWindow() time.Duration {
	if s.unblockHold > 0 {
		return s.unblockHold
	}
	return unblockHoldDefault
}

func (s *Server) notifyClock() time.Time {
	if s.notifyNow != nil {
		return s.notifyNow()
	}
	return time.Now()
}

// isUnblockEvent reports whether e is an automatic blocker resolution: a
// task_blocker_resolved written by the system actor with auto set. Those
// notify only through the Unblocked path, never the per-worktree one. A
// resolution made by the request that added the blocker (on_add: an
// already-merged PR, an already-done task) is not one: the user's own
// click is not news. Nor is one an undo settled in its own transaction
// (on_undo): the undo puts back the user's own earlier state. In both
// cases isSystemBlockerEvent still keeps it off the per-worktree path, so
// it notifies nowhere.
func isUnblockEvent(e tasks.FeedEvent) bool {
	if e.Type != tasks.EventTaskBlockerResolved || e.Actor != tasks.ActorSystem {
		return false
	}
	p := parseTaskPayload(e.Payload)
	return p.Auto && !p.OnAdd && !p.OnUndo
}

// isSystemBlockerEvent reports whether e is a system resolve or unresolve.
// The per-worktree task path skips them all: resolves notify through the
// Unblocked path, and unresolves never notify.
func isSystemBlockerEvent(e tasks.FeedEvent) bool {
	return e.Actor == tasks.ActorSystem &&
		(e.Type == tasks.EventTaskBlockerResolved || e.Type == tasks.EventTaskBlockerUnresolved)
}

// unblockedText is "Unblocked: <label> <reason>": the label prettified (a
// resource's short ref, a task's "T<id> <title>"), and a task blocker's
// reason as "is done" or "was deleted". A PR's or Jira issue's reason
// ("merged", "closed", a status name) is appended as is.
func unblockedText(p taskEventPayload) string {
	reason := p.Reason
	if p.Kind == tasks.BlockerTask {
		switch reason {
		case "done":
			reason = "is done"
		case "deleted":
			reason = "was deleted"
		}
	}
	return strings.TrimSpace("Unblocked: " + blockerPayloadLabel(p) + " " + reason)
}

// holdUnblocks queues the Unblocked events a pass found, each due one hold
// window from now.
func (s *Server) holdUnblocks(evs []tasks.FeedEvent) {
	if len(evs) == 0 {
		return
	}
	due := s.notifyClock().Add(s.unblockHoldWindow())
	s.unblockMu.Lock()
	defer s.unblockMu.Unlock()
	for _, e := range evs {
		p := parseTaskPayload(e.Payload)
		s.unblockPending = append(s.unblockPending, pendingUnblock{
			eventID: e.ID, taskID: e.TaskID, blockerID: p.BlockerID, due: due,
			body: unblockedText(p),
		})
	}
}

// dueUnblockBatches takes the held items whose hold has elapsed and builds
// their notifications. Each is re-checked first (unblockStillStands): one
// whose event is gone (an undo deleted it), whose task is deleted, or
// whose blocker was removed or is no longer resolved is dropped silently. No toggle is
// consulted; only the global switch, in deliver, applies.
func (s *Server) dueUnblockBatches() []notifyBatch {
	now := s.notifyClock()
	s.unblockMu.Lock()
	var due []pendingUnblock
	kept := s.unblockPending[:0]
	for _, p := range s.unblockPending {
		if now.Before(p.due) {
			kept = append(kept, p)
		} else {
			due = append(due, p)
		}
	}
	s.unblockPending = kept
	s.unblockMu.Unlock()
	if len(due) == 0 {
		return nil
	}
	var out []notifyBatch
	var t *unblockTargeter
	for _, p := range due {
		title, ok, err := unblockStillStands(s.DB, p)
		if err != nil {
			s.logger().Printf("notify: unblocked event %d: %v", p.eventID, err)
			continue
		}
		if !ok {
			continue
		}
		if t == nil {
			t = s.newUnblockTargeter()
		}
		out = append(out, unblockBatch(p, title, t.target(p.taskID)))
	}
	return out
}

// unblockStillStands re-reads p's event: ok when the row still exists, its
// task is not deleted, and the blocker it resolved still exists and is
// still resolved, with the task's current title.
func unblockStillStands(conn *sql.DB, p pendingUnblock) (title string, ok bool, err error) {
	var live bool
	err = conn.QueryRow(
		`SELECT COALESCE(t.title,''),
		        (t.id IS NOT NULL AND t.deleted_at IS NULL AND b.resolved_at IS NOT NULL)
		   FROM task_events e
		   LEFT JOIN tasks t ON t.id = e.task_id
		   LEFT JOIN task_blockers b ON b.id = ? AND b.task_id = e.task_id
		  WHERE e.id = ?`, p.blockerID, p.eventID).Scan(&title, &live)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return title, live, nil
}

func unblockBatch(p pendingUnblock, title, path string) notifyBatch {
	sid := strconv.FormatInt(p.taskID, 10)
	b := notifyBatch{
		WorktreePath: path,
		ResourceType: "task",
		ResourceID:   sid,
		Title:        title,
		Body:         p.body,
		// Per event, so two unblocks of one task never replace each other.
		Tag:         notifyTag(path, "task", sid) + "|unblocked:" + strconv.FormatInt(p.eventID, 10),
		Event:       p.body,
		Resource:    "T" + sid + ": " + truncateRunes(title, notifyNameMax),
		Description: truncateRunes(oneLine(p.body), notifyDescriptionMax),
	}
	if path != "" {
		b.Subtitle = filepath.Base(path)
	}
	return b
}

// unblockTargeter picks the worktree an Unblocked notification targets,
// loading what it needs once per pass.
type unblockTargeter struct {
	s       *Server
	entries []registry.Entry           // registry order
	byCanon map[string]string          // canonical path -> registry path
	scope   tasks.ScopeIndex           // nil maps when it failed to load
	follows map[string]map[string]bool // registry path -> followed "type:id", loaded lazily
}

func (s *Server) newUnblockTargeter() *unblockTargeter {
	t := &unblockTargeter{s: s, byCanon: map[string]string{}, follows: map[string]map[string]bool{}}
	es, err := registry.List(s.DB)
	if err != nil {
		s.logger().Printf("notify: registry: %v", err)
	}
	t.entries = es
	for _, e := range es {
		c, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(e.Path))
		t.byCanon[c] = e.Path
	}
	if t.scope, err = tasks.BuildScopeIndex(s.DB); err != nil {
		s.logger().Printf("notify: task scope: %v", err)
	}
	return t
}

// target is the worktree of the task's first Focus link when that is a
// registered worktree or a resource some worktree follows (the first such
// worktree in registry order); otherwise the first worktree, in registry
// order, whose scope holds the task; otherwise "" (untargeted: home page,
// or the UI server's own cmux workspace).
func (t *unblockTargeter) target(taskID int64) string {
	tk, err := tasks.Get(t.s.DB, taskID)
	if err != nil {
		t.s.logger().Printf("notify: task %d: %v", taskID, err)
	} else {
		for _, l := range tk.Links {
			if !l.Primary {
				continue
			}
			if p := t.focusWorktree(l); p != "" {
				return p
			}
			break // only the first Focus link counts
		}
	}
	for _, e := range t.entries {
		c, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(e.Path))
		for _, id := range t.scope.ByWorktree[c] {
			if id == taskID {
				return e.Path
			}
		}
	}
	return ""
}

func (t *unblockTargeter) focusWorktree(l tasks.Link) string {
	switch l.Kind {
	case tasks.LinkWorktree:
		c, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(l.Worktree))
		return t.byCanon[c]
	case tasks.LinkResource:
		key := l.ResourceType + ":" + l.ResourceID
		for _, e := range t.entries {
			if t.followed(e.Path)[key] {
				return e.Path
			}
		}
	}
	return ""
}

// followed is the set of resources a worktree actively tracks
// (resources.Load counts only its own worktree: subscriptions, never a
// task's hold).
func (t *unblockTargeter) followed(path string) map[string]bool {
	if f, ok := t.follows[path]; ok {
		return f
	}
	f := map[string]bool{}
	rs, err := resources.Load(t.s.DB, path)
	if err != nil {
		t.s.logger().Printf("notify: resources.Load(%s): %v", path, err)
	}
	for _, r := range rs {
		f[r.Type+":"+r.ID] = true
	}
	t.follows[path] = f
	return f
}
