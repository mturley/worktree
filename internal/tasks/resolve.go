package tasks

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
)

// Logf is where the package logs what it cannot return: failures of the
// after-commit steps (hold reconciliation, write-time blocker resolution),
// which never fail the user's committed write. `worktree ui` points it at
// its own logger at startup; the CLI keeps the standard logger.
var Logf = log.Printf

// ResourceStatus is a resource's blocking condition as a StatusLookup sees
// it. Label is what the UI shows ("merged", "closed", "Done", "In
// Progress"); when Done, it is also the resolution's reason.
type ResourceStatus struct {
	Done  bool
	Label string
}

// StatusLookup reports a resource's status. ok=false means unknown (never
// polled, its watcher off, a failed lookup, or a Slack thread or link,
// which only the user resolves): the blocker then keeps its last state.
type StatusLookup func(resourceType, resourceID string) (ResourceStatus, bool)

// Resolution is one blocker the resolver moved: resolved (Reason says why,
// e.g. "merged", "done", "deleted") or unresolved. Label is the blocker's
// event label ("T<id> <title>", "type:id" or the text).
type Resolution struct {
	TaskID, BlockerID int64
	Resolved          bool
	Label, Reason     string
}

// Reasons for a task blocker's automatic resolution.
const (
	reasonDone    = "done"
	reasonDeleted = "deleted"
)

// candidateWhere selects the blockers the resolver owns: task and resource
// blockers (minus Slack threads and links, which are resolved by hand)
// that are unresolved or were resolved automatically, on tasks that are
// neither done nor deleted. A blocker the user resolved is never selected.
const candidateWhere = `t.deleted_at IS NULL AND t.state != 'done'
	AND (b.resolved_at IS NULL OR b.resolved_auto = 1)
	AND (b.kind = 'task' OR (b.kind = 'resource' AND b.resource_type NOT IN ('slack', 'link')))`

// ResolvableResourceIDs returns the distinct ids of resources of type typ
// that some blocker the resolver owns names, sorted. A StatusLookup uses it
// to batch its own lookups (one Jira search per pass). Never nil.
func ResolvableResourceIDs(conn *sql.DB, typ string) ([]string, error) {
	rows, err := conn.QueryContext(bg,
		`SELECT DISTINCT b.resource_id FROM task_blockers b JOIN tasks t ON t.id = b.task_id
		  WHERE `+candidateWhere+` AND b.kind = 'resource' AND b.resource_type = ?
		  ORDER BY b.resource_id`, typ)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ResolveBlockers evaluates every blocker it owns (see candidateWhere): a
// task blocker holds until its blocking task is done or deleted; a
// resource blocker follows lookup, and is left alone when lookup is nil or
// does not know the resource. A blocker whose condition holds is resolved
// (automatically, as the system actor); an automatically resolved one whose
// condition stopped holding (PR reopened, issue left Done, task reopened)
// is unresolved. It returns what changed.
//
// lookup runs before the transaction, since it may call out to Jira, and
// must not write to conn. The writes then happen in one inTx, which reloads
// each blocker and re-reads task state, so a concurrent write is never
// overwritten with a stale decision. A pass with nothing it could change
// (no task blockers, and no resource the lookup knows) never opens it.
// A blocker whose own reads fail (its row, its task's state, its label)
// is logged via Logf and skipped; only a failed write fails the pass.
func ResolveBlockers(conn *sql.DB, lookup StatusLookup) ([]Resolution, error) {
	rows, err := conn.QueryContext(bg,
		`SELECT `+blockerCols+` FROM task_blockers b JOIN tasks t ON t.id = b.task_id
		  WHERE `+candidateWhere+` ORDER BY b.id`)
	if err != nil {
		return nil, fmt.Errorf("resolve blockers: %w", err)
	}
	var cands []Blocker
	for rows.Next() {
		b, err := scanBlocker(rows)
		if err != nil {
			rows.Close()
			return nil, fmt.Errorf("resolve blockers: %w", err)
		}
		cands = append(cands, b)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("resolve blockers: %w", err)
	}

	// Only resource blockers the lookup knows can change; dropping the rest
	// here means a pass with nothing to decide never takes the write lock.
	statuses := map[int64]ResourceStatus{}
	kept := cands[:0]
	for _, b := range cands {
		if b.Kind == BlockerResource {
			if lookup == nil {
				continue
			}
			st, ok := lookup(b.ResourceType, b.ResourceID)
			if !ok {
				continue
			}
			statuses[b.ID] = st
		}
		kept = append(kept, b)
	}
	cands = kept
	if len(cands) == 0 {
		return nil, nil
	}

	var out []Resolution
	err = inTx(conn, func(tx dbtx) error {
		ts := now()
		for _, c := range cands {
			b, err := loadBlocker(tx, c.ID)
			if errors.Is(err, ErrBlockerNotFound) {
				continue // removed, or its task deleted, since the read
			}
			if err != nil {
				Logf("tasks: resolve blocker %d: %v (skipped)", c.ID, err)
				continue
			}
			if b.ResolvedAt != "" && !b.ResolvedAuto {
				continue // resolved by hand since the read
			}
			var state State
			if err := tx.QueryRowContext(bg, `SELECT state FROM tasks WHERE id = ?`, b.TaskID).Scan(&state); err != nil {
				Logf("tasks: resolve blocker %d: task state: %v (skipped)", b.ID, err)
				continue
			}
			if state == StateDone {
				continue
			}
			done, reason, known := false, "", false
			switch b.Kind {
			case BlockerTask:
				if done, reason, err = blockingTaskDone(tx, b.BlockingTaskID); err != nil {
					Logf("tasks: resolve blocker %d: blocking task state: %v (skipped)", b.ID, err)
					continue
				}
				known = true
			case BlockerResource:
				var st ResourceStatus
				st, known = statuses[b.ID]
				done, reason = st.Done, st.Label
			}
			if !known || done == (b.ResolvedAt != "") {
				continue
			}
			label, err := blockerLabel(tx, b.BlockerTarget)
			if err != nil {
				Logf("tasks: resolve blocker %d: label: %v (skipped)", b.ID, err)
				continue
			}
			// Only a failed write fails the pass (and rolls it back).
			if err := setResolvedTx(tx, Actor{Kind: ActorSystem}, b, done, true, reason, ts); err != nil {
				return err
			}
			r := Resolution{TaskID: b.TaskID, BlockerID: b.ID, Resolved: done, Label: label}
			if done {
				r.Reason = reason
			}
			out = append(out, r)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("resolve blockers: %w", err)
	}
	return out, nil
}

// blockingTaskDone reports whether a task blocker's blocking task is done
// (reason "done") or gone (reason "deleted": soft-deleted, or no row).
func blockingTaskDone(q dbtx, id int64) (bool, string, error) {
	var state State
	var deleted sql.NullString
	err := q.QueryRowContext(bg, `SELECT state, deleted_at FROM tasks WHERE id = ?`, id).Scan(&state, &deleted)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return true, reasonDeleted, nil
	case err != nil:
		return false, "", err
	case deleted.Valid:
		return true, reasonDeleted, nil
	case state == StateDone:
		return true, reasonDone, nil
	}
	return false, "", nil
}

// resolveAfterWrite is what a public write that can change a task
// blocker's condition calls after its commit: it resolves task blockers at
// once (they depend only on this DB). Resource blockers need a
// StatusLookup, which only `worktree ui` has; they wait for its next pass
// (or its own after-write step). The resolutions need no handing on: the
// events they write are what `worktree ui`'s notifier reads, whichever
// process wrote them. As with holds, an error is logged, not returned: the
// write has committed, and the poll loop resolves again after every pass.
func resolveAfterWrite(conn *sql.DB) {
	if _, err := ResolveBlockers(conn, nil); err != nil {
		Logf("tasks: %v (the poll loop will retry)", err)
	}
}
