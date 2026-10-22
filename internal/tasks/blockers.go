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

// BlockerTarget is what blocks a task: another task (TaskID), a resource
// (ResourceType + ResourceID) or free text (Text). Only the fields its
// kind uses are set once normalised.
type BlockerTarget struct {
	Kind                     string
	TaskID                   int64
	ResourceType, ResourceID string
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
}

// ErrBlockerNotFound is returned for a blocker that does not exist or whose
// task was deleted. It wraps ErrNotFound.
var ErrBlockerNotFound = fmt.Errorf("%w: no such blocker", ErrNotFound)

// normalizeBlocker validates t and returns it with only the fields its kind
// uses, trimmed of surrounding space.
func normalizeBlocker(t BlockerTarget) (BlockerTarget, error) {
	switch t.Kind {
	case BlockerTask:
		if t.TaskID <= 0 {
			return BlockerTarget{}, fmt.Errorf("%w: a task blocker needs a task id", ErrInvalid)
		}
		return BlockerTarget{Kind: BlockerTask, TaskID: t.TaskID}, nil
	case BlockerResource:
		typ, id := strings.TrimSpace(t.ResourceType), strings.TrimSpace(t.ResourceID)
		if typ == "" || id == "" {
			return BlockerTarget{}, fmt.Errorf("%w: a resource blocker needs a type and an id", ErrInvalid)
		}
		return BlockerTarget{Kind: BlockerResource, ResourceType: typ, ResourceID: id}, nil
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

// manuallyResolvable reports whether the user may resolve b by hand: free
// text, or a Slack thread or link (nothing resolves those automatically).
func manuallyResolvable(b BlockerTarget) bool {
	return b.Kind == BlockerOther ||
		(b.Kind == BlockerResource && (b.ResourceType == "slack" || b.ResourceType == "link"))
}

const blockerCols = `b.id, b.task_id, b.kind, COALESCE(b.blocking_task_id, 0), b.resource_type, b.resource_id, b.text,
	b.resolved_at, b.resolved_auto, b.resolved_reason, b.created_at`

// scanBlocker reads one row selected with blockerCols. Note Blocker.TaskID
// is the blocked task; the blocking task is Blocker.BlockerTarget.TaskID.
func scanBlocker(s interface{ Scan(...any) error }) (Blocker, error) {
	var b Blocker
	var resolved sql.NullString
	var auto int
	err := s.Scan(&b.ID, &b.TaskID, &b.Kind, &b.BlockerTarget.TaskID, &b.ResourceType, &b.ResourceID, &b.Text,
		&resolved, &auto, &b.ResolvedReason, &b.CreatedAt)
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
		err := q.QueryRowContext(bg, `SELECT title FROM tasks WHERE id = ?`, b.TaskID).Scan(&title)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Sprintf("T%d", b.TaskID), nil
		}
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("T%d %s", b.TaskID, title), nil
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
// among unresolved task blockers (ErrInvalid). User or agent only.
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
		if _, err := load(tx, taskID); err != nil {
			return err
		}
		err := tx.QueryRowContext(bg,
			`SELECT id FROM task_blockers
			  WHERE task_id = ? AND kind = ? AND COALESCE(blocking_task_id, 0) = ?
			    AND resource_type = ? AND resource_id = ? AND text = ?`,
			taskID, t.Kind, t.TaskID, t.ResourceType, t.ResourceID, t.Text).Scan(&id)
		if err == nil {
			return nil // duplicate: no-op
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if t.Kind == BlockerTask {
			if _, err := load(tx, t.TaskID); errors.Is(err, ErrNotFound) {
				return fmt.Errorf("%w: blocking task %d does not exist", ErrInvalid, t.TaskID)
			} else if err != nil {
				return err
			}
			cyc, err := wouldCycle(tx, taskID, t.TaskID)
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
			blocking = t.TaskID
		}
		res, err := tx.ExecContext(bg,
			`INSERT INTO task_blockers (task_id, kind, blocking_task_id, resource_type, resource_id, text, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			taskID, t.Kind, blocking, t.ResourceType, t.ResourceID, t.Text, ts)
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
		_, err = record(tx, a, taskID, ts, EventTaskBlockerAdded, p)
		return err
	})
	if err != nil {
		return Blocker{}, err
	}
	return loadBlocker(conn, id)
}

// RemoveBlocker deletes a blocker. User or agent only.
func RemoveBlocker(conn *sql.DB, a Actor, blockerID int64) error {
	if err := validActor(a); err != nil {
		return err
	}
	return inTx(conn, func(tx dbtx) error {
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
		if !manuallyResolvable(b.BlockerTarget) {
			return fmt.Errorf("%w: only free-text, Slack thread and link blockers are resolved by hand", ErrInvalid)
		}
		return setResolvedTx(tx, a, b, resolved, false, "", now())
	})
}

// setResolvedTx moves b (as loaded inside tx) to resolved or unresolved,
// stamping auto and reason, bumping its task's updated_at and recording
// task_blocker_resolved {blocker_id, kind, label, auto, reason} or
// task_blocker_unresolved {blocker_id, kind, label}. It is the one write
// path for resolution, shared with the resolver, which passes ActorSystem;
// a is checked with validInternalActor. A blocker already in the wanted
// state is left alone. It calls no public function.
func setResolvedTx(tx dbtx, a Actor, b Blocker, resolved, auto bool, reason, ts string) error {
	if err := validInternalActor(a); err != nil {
		return err
	}
	if (b.ResolvedAt != "") == resolved {
		return nil
	}
	p, err := blockerPayload(tx, b.ID, b.BlockerTarget)
	if err != nil {
		return err
	}
	typ := EventTaskBlockerUnresolved
	if resolved {
		typ = EventTaskBlockerResolved
		p["auto"], p["reason"] = auto, reason
		_, err = tx.ExecContext(bg,
			`UPDATE task_blockers SET resolved_at = ?, resolved_auto = ?, resolved_reason = ? WHERE id = ?`,
			ts, bit(auto), reason, b.ID)
	} else {
		_, err = tx.ExecContext(bg,
			`UPDATE task_blockers SET resolved_at = NULL, resolved_auto = 0, resolved_reason = '' WHERE id = ?`, b.ID)
	}
	if err != nil {
		return err
	}
	if err := touch(tx, b.TaskID, ts); err != nil {
		return err
	}
	_, err = record(tx, a, b.TaskID, ts, typ, p)
	return err
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
