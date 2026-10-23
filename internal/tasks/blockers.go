package tasks

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Blocker kinds.
const (
	BlockerTask     = "task"     // another task; resolves when it is done
	BlockerResource = "resource" // a PR, Jira issue, Slack thread or link
	BlockerOther    = "other"    // free text, resolved by hand
)

// BlockerTarget is what blocks a task: another task (BlockingTaskID), a
// resource (ResourceType + ResourceID) or free text (Text). Only the fields
// its kind uses are set once normalised. The field is BlockingTaskID, not
// TaskID, so it never collides with Blocker.TaskID (the blocked task), which
// would shadow it and drop it from Blocker's JSON encoding.
//
// URL is the URL a resource blocker was added from (” when added by type
// and id). It is not part of the blocker's identity: it is stored so the
// resource's hold can carry it (see ReconcileHolds).
type BlockerTarget struct {
	Kind                     string
	BlockingTaskID           int64
	ResourceType, ResourceID string
	URL                      string
	Text                     string
}

// Blocker is one of a task's blockers. ResolvedAt is "" while it holds.
type Blocker struct {
	ID, TaskID int64
	BlockerTarget
	ResolvedAt     string
	ResolvedAuto   bool   // resolved by the system, not the user
	ResolvedReason string // e.g. "merged"; "" when resolved by hand
	CreatedAt      string
	// resolvedEventID is the task_blocker_resolved event that resolved it
	// (0 while unresolved, or when resolved before it was recorded). Undo
	// matches a cascade by it. Unexported, so it stays out of the JSON.
	resolvedEventID int64
}

// ErrBlockerNotFound is returned for a blocker that does not exist or whose
// task was deleted. It wraps ErrNotFound.
var ErrBlockerNotFound = fmt.Errorf("%w: no such blocker", ErrNotFound)

// normalizeBlocker validates t and returns it with only the fields its kind
// uses, trimmed of surrounding space.
func normalizeBlocker(t BlockerTarget) (BlockerTarget, error) {
	switch t.Kind {
	case BlockerTask:
		if t.BlockingTaskID <= 0 {
			return BlockerTarget{}, fmt.Errorf("%w: a task blocker needs a task id", ErrInvalid)
		}
		return BlockerTarget{Kind: BlockerTask, BlockingTaskID: t.BlockingTaskID}, nil
	case BlockerResource:
		typ, id := strings.TrimSpace(t.ResourceType), strings.TrimSpace(t.ResourceID)
		if typ == "" || id == "" {
			return BlockerTarget{}, fmt.Errorf("%w: a resource blocker needs a type and an id", ErrInvalid)
		}
		return BlockerTarget{Kind: BlockerResource, ResourceType: typ, ResourceID: id, URL: strings.TrimSpace(t.URL)}, nil
	case BlockerOther:
		text := strings.TrimSpace(t.Text)
		if text == "" {
			return BlockerTarget{}, fmt.Errorf("%w: a blocker needs text", ErrInvalid)
		}
		return BlockerTarget{Kind: BlockerOther, Text: text}, nil
	default:
		return BlockerTarget{}, fmt.Errorf("%w: blocker kind %q is not %q, %q or %q",
			ErrInvalid, t.Kind, BlockerTask, BlockerResource, BlockerOther)
	}
}

// ManuallyResolvable reports whether the user may resolve b by hand: free
// text, or a Slack thread or link (nothing resolves those automatically).
func ManuallyResolvable(b BlockerTarget) bool {
	return b.Kind == BlockerOther ||
		(b.Kind == BlockerResource && (b.ResourceType == "slack" || b.ResourceType == "link"))
}

const blockerCols = `b.id, b.task_id, b.kind, COALESCE(b.blocking_task_id, 0), b.resource_type, b.resource_id, b.resource_url, b.text,
	b.resolved_at, b.resolved_auto, b.resolved_reason, b.created_at, COALESCE(b.resolved_event_id, 0)`

// scanBlocker reads one row selected with blockerCols. Blocker.TaskID is
// the blocked task; BlockingTaskID is the blocking one (task kind only).
func scanBlocker(s interface{ Scan(...any) error }) (Blocker, error) {
	var b Blocker
	var resolved sql.NullString
	var auto int
	err := s.Scan(&b.ID, &b.TaskID, &b.Kind, &b.BlockingTaskID, &b.ResourceType, &b.ResourceID, &b.URL, &b.Text,
		&resolved, &auto, &b.ResolvedReason, &b.CreatedAt, &b.resolvedEventID)
	b.ResolvedAt, b.ResolvedAuto = resolved.String, auto != 0
	return b, err
}

// loadBlocker reads blocker id, provided its task is not deleted; else
// ErrBlockerNotFound.
func loadBlocker(q dbtx, id int64) (Blocker, error) {
	b, err := scanBlocker(q.QueryRowContext(bg,
		`SELECT `+blockerCols+` FROM task_blockers b JOIN tasks t ON t.id = b.task_id
		  WHERE b.id = ? AND t.deleted_at IS NULL`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Blocker{}, ErrBlockerNotFound
	}
	return b, err
}

// blockerLabel names b in event payloads: "T<id> <title>" for a task
// (deleted or not; "T<id>" if the row is gone), "type:id" for a resource
// (the web layer prettifies it) and the text for other.
func blockerLabel(q dbtx, b BlockerTarget) (string, error) {
	switch b.Kind {
	case BlockerTask:
		var title string
		err := q.QueryRowContext(bg, `SELECT title FROM tasks WHERE id = ?`, b.BlockingTaskID).Scan(&title)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Sprintf("T%d", b.BlockingTaskID), nil
		}
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("T%d %s", b.BlockingTaskID, title), nil
	case BlockerResource:
		return b.ResourceType + ":" + b.ResourceID, nil
	default:
		return b.Text, nil
	}
}

// blockerPayload is the {blocker_id, kind, label} every blocker event
// carries.
func blockerPayload(q dbtx, id int64, b BlockerTarget) (map[string]any, error) {
	label, err := blockerLabel(q, b)
	if err != nil {
		return nil, err
	}
	return map[string]any{"blocker_id": id, "kind": b.Kind, "label": label}, nil
}

// wouldCycle reports whether taskID being blocked by blocking would close a
// cycle: whether, following unresolved task blockers among non-deleted
// tasks from blocking ("is blocked by"), taskID is reachable. A task
// blocking itself is the trivial case.
func wouldCycle(q dbtx, taskID, blocking int64) (bool, error) {
	if taskID == blocking {
		return true, nil
	}
	rows, err := q.QueryContext(bg,
		`SELECT b.task_id, b.blocking_task_id FROM task_blockers b
		   JOIN tasks t ON t.id = b.task_id AND t.deleted_at IS NULL
		   JOIN tasks u ON u.id = b.blocking_task_id AND u.deleted_at IS NULL
		  WHERE b.kind = 'task' AND b.resolved_at IS NULL`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	blockedBy := map[int64][]int64{}
	for rows.Next() {
		var from, to int64
		if err := rows.Scan(&from, &to); err != nil {
			return false, err
		}
		blockedBy[from] = append(blockedBy[from], to)
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	seen := map[int64]bool{blocking: true}
	stack := []int64{blocking}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, next := range blockedBy[n] {
			if next == taskID {
				return true, nil
			}
			if !seen[next] {
				seen[next] = true
				stack = append(stack, next)
			}
		}
	}
	return false, nil
}

// AddBlocker adds t as a blocker of taskID, unresolved. Adding a target the
// task already has (resolved or not) is a no-op returning the existing
// blocker. A task blocker must name a live task and must not close a cycle
// among unresolved task blockers (ErrInvalid); one whose blocking task is
// already done is resolved in the same transaction, marked on_add (see
// ResolveOptions), unless taskID is itself done. User or agent only.
func AddBlocker(conn *sql.DB, a Actor, taskID int64, t BlockerTarget) (Blocker, error) {
	if err := validActor(a); err != nil {
		return Blocker{}, err
	}
	t, err := normalizeBlocker(t)
	if err != nil {
		return Blocker{}, err
	}
	var id int64
	err = inTx(conn, func(tx dbtx) error {
		cur, err := load(tx, taskID)
		if err != nil {
			return err
		}
		err = tx.QueryRowContext(bg,
			`SELECT id FROM task_blockers
			  WHERE task_id = ? AND kind = ? AND COALESCE(blocking_task_id, 0) = ?
			    AND resource_type = ? AND resource_id = ? AND text = ?`,
			taskID, t.Kind, t.BlockingTaskID, t.ResourceType, t.ResourceID, t.Text).Scan(&id)
		if err == nil {
			// Duplicate: a no-op, except that a URL first given now is kept.
			if t.URL != "" {
				_, err = tx.ExecContext(bg,
					`UPDATE task_blockers SET resource_url = ? WHERE id = ? AND resource_url = ''`, t.URL, id)
			}
			return err
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if t.Kind == BlockerTask {
			if _, err := load(tx, t.BlockingTaskID); errors.Is(err, ErrNotFound) {
				return fmt.Errorf("%w: blocking task %d does not exist", ErrInvalid, t.BlockingTaskID)
			} else if err != nil {
				return err
			}
			cyc, err := wouldCycle(tx, taskID, t.BlockingTaskID)
			if err != nil {
				return err
			}
			if cyc {
				return fmt.Errorf("%w: would create a blocking cycle", ErrInvalid)
			}
		}
		ts := now()
		var blocking any
		if t.Kind == BlockerTask {
			blocking = t.BlockingTaskID
		}
		res, err := tx.ExecContext(bg,
			`INSERT INTO task_blockers (task_id, kind, blocking_task_id, resource_type, resource_id, resource_url, text, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			taskID, t.Kind, blocking, t.ResourceType, t.ResourceID, t.URL, t.Text, ts)
		if err != nil {
			return err
		}
		if id, err = res.LastInsertId(); err != nil {
			return err
		}
		if err := touch(tx, taskID, ts); err != nil {
			return err
		}
		p, err := blockerPayload(tx, id, t)
		if err != nil {
			return err
		}
		if _, err = record(tx, a, taskID, ts, EventTaskBlockerAdded, p); err != nil {
			return err
		}
		if t.Kind != BlockerTask || cur.State == StateDone {
			return nil
		}
		// The blocking task was loaded live above, so only "done" applies.
		done, reason, err := blockingTaskDone(tx, t.BlockingTaskID)
		if err != nil || !done {
			return err
		}
		b, err := loadBlocker(tx, id)
		if err != nil {
			return err
		}
		_, err = setResolvedTx(tx, Actor{Kind: ActorSystem}, b, true, true, true, reason, ts)
		return err
	})
	if err != nil {
		return Blocker{}, err
	}
	reconcileHoldsAfterWrite(conn) // a resource blocker holds its resource
	return loadBlocker(conn, id)
}

// RemoveBlocker deletes a blocker. User or agent only.
func RemoveBlocker(conn *sql.DB, a Actor, blockerID int64) error {
	if err := validActor(a); err != nil {
		return err
	}
	err := inTx(conn, func(tx dbtx) error {
		b, err := loadBlocker(tx, blockerID)
		if err != nil {
			return err
		}
		p, err := blockerPayload(tx, b.ID, b.BlockerTarget)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(bg, `DELETE FROM task_blockers WHERE id = ?`, b.ID); err != nil {
			return err
		}
		ts := now()
		if err := touch(tx, b.TaskID, ts); err != nil {
			return err
		}
		_, err = record(tx, a, b.TaskID, ts, EventTaskBlockerRemoved, p)
		return err
	})
	if err != nil {
		return err
	}
	reconcileHoldsAfterWrite(conn) // release a removed resource blocker's hold
	return nil
}

// SetBlockerResolved resolves (or unresolves) a blocker by hand. Only free
// text, Slack thread and link blockers may be; any other is ErrInvalid,
// since the resolver owns them. Setting the current state is a no-op.
// User or agent only.
func SetBlockerResolved(conn *sql.DB, a Actor, blockerID int64, resolved bool) error {
	if err := validActor(a); err != nil {
		return err
	}
	return inTx(conn, func(tx dbtx) error {
		b, err := loadBlocker(tx, blockerID)
		if err != nil {
			return err
		}
		if !ManuallyResolvable(b.BlockerTarget) {
			return fmt.Errorf("%w: only free-text, Slack thread and link blockers are resolved by hand", ErrInvalid)
		}
		_, err = setResolvedTx(tx, a, b, resolved, false, false, "", now())
		return err
	})
}

// setResolvedTx moves b (as loaded inside tx) to resolved or unresolved,
// stamping auto and reason, bumping its task's updated_at and recording
// task_blocker_resolved {blocker_id, kind, label, auto, reason} (plus
// on_add: true when onAdd, see ResolveOptions) or
// task_blocker_unresolved {blocker_id, kind, label}, and returns that
// event's id. A resolution also stores the id as the blocker's
// resolved_event_id (an unresolve clears it). It is the one write path for
// resolution, shared with the resolver and the in-transaction cascades,
// which pass ActorSystem; a is checked with validInternalActor. A blocker
// already in the wanted state is left alone (id 0). It calls no public
// function.
func setResolvedTx(tx dbtx, a Actor, b Blocker, resolved, auto, onAdd bool, reason, ts string) (int64, error) {
	if err := validInternalActor(a); err != nil {
		return 0, err
	}
	if (b.ResolvedAt != "") == resolved {
		return 0, nil
	}
	p, err := blockerPayload(tx, b.ID, b.BlockerTarget)
	if err != nil {
		return 0, err
	}
	if err := touch(tx, b.TaskID, ts); err != nil {
		return 0, err
	}
	if !resolved {
		if _, err := tx.ExecContext(bg,
			`UPDATE task_blockers SET resolved_at = NULL, resolved_auto = 0, resolved_reason = '', resolved_event_id = NULL
			  WHERE id = ?`, b.ID); err != nil {
			return 0, err
		}
		return record(tx, a, b.TaskID, ts, EventTaskBlockerUnresolved, p)
	}
	p["auto"], p["reason"] = auto, reason
	if onAdd {
		p["on_add"] = true
	}
	id, err := record(tx, a, b.TaskID, ts, EventTaskBlockerResolved, p)
	if err != nil {
		return 0, err
	}
	_, err = tx.ExecContext(bg,
		`UPDATE task_blockers SET resolved_at = ?, resolved_auto = ?, resolved_reason = ?, resolved_event_id = ?
		  WHERE id = ?`, ts, bit(auto), reason, id, b.ID)
	return id, err
}

// Blockers returns taskID's blockers, unresolved first, then oldest first;
// ErrNotFound when the task is missing or deleted. Never nil.
func Blockers(conn *sql.DB, taskID int64) ([]Blocker, error) {
	if _, err := load(conn, taskID); err != nil {
		return nil, err
	}
	rows, err := conn.QueryContext(bg,
		`SELECT `+blockerCols+` FROM task_blockers b WHERE b.task_id = ?
		  ORDER BY b.resolved_at IS NOT NULL, b.created_at, b.id`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Blocker{}
	for rows.Next() {
		b, err := scanBlocker(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Blocking returns the ids of the non-deleted tasks taskID blocks (by a
// task blocker, resolved or not), in master order. Never nil.
func Blocking(conn *sql.DB, taskID int64) ([]int64, error) {
	rows, err := conn.QueryContext(bg,
		`SELECT DISTINCT t.id, t.rank FROM task_blockers b JOIN tasks t ON t.id = b.task_id
		  WHERE b.kind = 'task' AND b.blocking_task_id = ? AND t.deleted_at IS NULL
		  ORDER BY t.rank, t.id`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []int64{}
	for rows.Next() {
		var id int64
		var rank string
		if err := rows.Scan(&id, &rank); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ResourceBlockCounts maps "type:id" to the number of open (not done),
// non-deleted tasks with an unresolved blocker on that resource. Resources
// blocking nothing are absent.
func ResourceBlockCounts(conn *sql.DB) (map[string]int, error) {
	rows, err := conn.QueryContext(bg,
		`SELECT b.resource_type, b.resource_id, COUNT(DISTINCT b.task_id)
		   FROM task_blockers b JOIN tasks t ON t.id = b.task_id
		  WHERE b.kind = 'resource' AND b.resolved_at IS NULL
		    AND t.deleted_at IS NULL AND t.state != ?
		  GROUP BY b.resource_type, b.resource_id`, StateDone)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var typ, id string
		var n int
		if err := rows.Scan(&typ, &id, &n); err != nil {
			return nil, err
		}
		out[typ+":"+id] = n
	}
	return out, rows.Err()
}

// BlockerTaskID returns the id of the task blocker id belongs to;
// ErrBlockerNotFound when the blocker is missing or its task deleted.
func BlockerTaskID(conn *sql.DB, id int64) (int64, error) {
	b, err := loadBlocker(conn, id)
	if err != nil {
		return 0, err
	}
	return b.TaskID, nil
}

// UnresolvedBlockers maps every live task with an unresolved blocker to
// those blockers, oldest first, in one query: what a listing needs to name
// each task's blockers without a query per task. Tasks with none are
// absent.
func UnresolvedBlockers(conn *sql.DB) (map[int64][]Blocker, error) {
	rows, err := conn.QueryContext(bg,
		`SELECT `+blockerCols+` FROM task_blockers b JOIN tasks t ON t.id = b.task_id
		  WHERE t.deleted_at IS NULL AND b.resolved_at IS NULL
		  ORDER BY b.task_id, b.created_at, b.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]Blocker{}
	for rows.Next() {
		b, err := scanBlocker(rows)
		if err != nil {
			return nil, err
		}
		out[b.TaskID] = append(out[b.TaskID], b)
	}
	return out, rows.Err()
}

// Head is the little of a task a blocker's label and status need. Unlike
// Get, it is answered for a deleted task too (Deleted set): a task blocker
// outlives its blocking task.
type Head struct {
	Title   string
	State   State
	Deleted bool
}

// Heads returns the heads of the tasks in ids, deleted ones included. Ids
// with no row are absent. Never nil.
func Heads(conn *sql.DB, ids []int64) (map[int64]Head, error) {
	out := map[int64]Head{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := conn.QueryContext(bg,
		`SELECT id, title, state, deleted_at IS NOT NULL FROM tasks
		  WHERE id IN (?`+strings.Repeat(",?", len(ids)-1)+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var h Head
		var deleted int
		if err := rows.Scan(&id, &h.Title, &h.State, &deleted); err != nil {
			return nil, err
		}
		h.Deleted = deleted != 0
		out[id] = h
	}
	return out, rows.Err()
}
