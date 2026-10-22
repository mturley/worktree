// Package unread implements the per-resource read cursor.
//
// One cursor per resource, NOT per subscriber. agent-handler — the watcher
// library's other consumer — tracks unread per subscriber so each session has
// its own read state; this is deliberately different. If a PR is tracked by
// two worktrees, marking it read in one clears it in both: you read the PR,
// not the worktree.
//
// The cursor is compared against watcher_events.ts, never external_ts. Both
// timeline queries ORDER BY e.ts DESC, and external_ts is nullable and can run
// out of order relative to ts — a cursor on it would let read and unread
// events interleave in display order, making the unread divider a lie.
package unread

import (
	"database/sql"
	"errors"
	"time"

	"github.com/mturley/worktree/internal/selfid"
)

// ErrSlackNotSupported is returned for any write against a Slack thread.
//
// Slack owns a read cursor for the current user already, worktree reads it via
// the poller-cached has_unread, and two systems must not both claim authority
// over the same thread.
var ErrSlackNotSupported = errors.New("slack threads keep their own read state")

// NotPendingCISQL is the condition "this event is not a CI run still in
// progress", over a watcher_events row aliased e. A running run is churn, not
// news: only its completion (passed, failed, failing) is worth reading, and
// the watcher rewrites the same bundle row in place — type AND ts — when the
// run completes, so the completion still lands past the cursor as unread.
// Left out exactly like the user's own events (selfid.NotMineSQL): still
// rendered in the feeds, never counted or flagged unread.
const NotPendingCISQL = `e.type NOT IN ('ci_pending','ci_workflows_pending')`

// IsPendingCI is NotPendingCISQL's Go twin, for code that already holds an
// event.
func IsPendingCI(eventType string) bool {
	return eventType == "ci_pending" || eventType == "ci_workflows_pending"
}

// Key is the map key used by Counts and Cursors. The separator is a NUL so it
// cannot collide with a resource id (Slack ids contain ':', Jira ids '-',
// PR ids '/' and '#').
func Key(resType, id string) string { return resType + "\x00" + id }

// EnsureCursor seeds a cursor for a resource that has none, at the newest ts
// among its events, or now if it has no events. It is INSERT OR IGNORE: a
// resource someone already reads keeps its cursor when a second worktree
// subscribes, rather than having its unread state reset.
//
// A Slack resource is a silent no-op, not an error — callers seed
// indiscriminately as resources are added, and the skip belongs here rather
// than at every call site.
func EnsureCursor(conn *sql.DB, resType, id string) error {
	if resType == "slack" {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := conn.Exec(`
		INSERT OR IGNORE INTO resource_read_cursor
			(resource_type, resource_id, last_read_ts, updated_at)
		VALUES (?, ?,
		        COALESCE((SELECT MAX(e.ts)
		                    FROM watcher_events e
		                    JOIN watcher_event_resources er ON er.event_id = e.id
		                   WHERE er.resource_type = ? AND er.resource_id = ?), ?),
		        ?)`, resType, id, resType, id, now, now)
	return err
}

// Counts returns the unread event count per resource, keyed by Key.
//
// The INNER join on resource_read_cursor does three jobs at once: it excludes
// Slack threads (never seeded), resources with no cursor row (read as nothing
// unread), and fully read resources (count zero yields no row). Resources
// absent from the map therefore have zero unread, which is what every caller
// wants from a missing key anyway.
//
// The excluded event types MUST match what the timelines render — see the
// filter in internal/webui/timeline.go (`e.type NOT IN
// ('watch_started','watcher_error')`), which the watcher library's
// EventsForSubscriberSince applies too. The count and the feed are a single
// promise to the user: a badge saying "1 unread" above a feed that shows
// nothing is unclearable, because mark-read sends the newest ts the client
// RENDERED and a bookkeeping event is never rendered. These two lists are
// coupled; change one and you must change the other.
func Counts(conn *sql.DB) (map[string]int, error) {
	sums, err := Summaries(conn)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int, len(sums))
	for k, v := range sums {
		out[k] = v.Count
	}
	return out, nil
}

// Summary is one resource's unread events: how many, and the ts of the
// newest one.
//
// NewestTS is what a "mark all read" sends as through_ts. It comes from the
// SAME query as Count, so a client clearing Count events clears exactly those
// and no more — an event that lands after this snapshot is newer than
// NewestTS and stays unread. See MarkRead for why the server never
// substitutes its own MAX(ts) at write time.
type Summary struct {
	Count    int
	NewestTS string
}

// Summaries is Counts with each resource's newest unread ts alongside. Same
// rules as Counts, including the event types it excludes. The user's own
// events (internal/selfid) and CI runs still in progress (NotPendingCISQL)
// never count, so NewestTS is the newest event worth reading.
func Summaries(conn *sql.DB) (map[string]Summary, error) {
	rows, err := conn.Query(`
		SELECT er.resource_type, er.resource_id, COUNT(*), MAX(e.ts)
		  FROM watcher_event_resources er
		  JOIN watcher_events e ON e.id = er.event_id
		  JOIN resource_read_cursor c
		    ON c.resource_type = er.resource_type
		   AND c.resource_id   = er.resource_id
		 WHERE e.ts > c.last_read_ts
		   AND e.type NOT IN ('watch_started','watcher_error')
		   AND ` + selfid.NotMineSQL + `
		   AND ` + NotPendingCISQL + `
		 GROUP BY er.resource_type, er.resource_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Summary{}
	for rows.Next() {
		var rt, rid string
		var sum Summary
		if err := rows.Scan(&rt, &rid, &sum.Count, &sum.NewestTS); err != nil {
			return nil, err
		}
		out[Key(rt, rid)] = sum
	}
	return out, rows.Err()
}

// TaskSummaries returns the unread task events per task id: the AGENT events
// of non-deleted tasks newer than the task's cursor. A task's cursor is a
// resource_read_cursor row with resource_type 'task' and the task id as its
// resource_id; a missing row reads as '' so every agent event counts (unlike
// Summaries, where no row means nothing unread). The user's own events never
// count. Mark and Restore already work for resType "task". Plain SQL over the
// tables, so this package does not import internal/tasks.
func TaskSummaries(conn *sql.DB) (map[int64]Summary, error) {
	rows, err := conn.Query(`
		SELECT e.task_id, COUNT(*), MAX(e.ts)
		  FROM task_events e
		  JOIN tasks t ON t.id = e.task_id AND t.deleted_at IS NULL
		  LEFT JOIN resource_read_cursor c
		    ON c.resource_type = 'task' AND c.resource_id = CAST(e.task_id AS TEXT)
		 WHERE e.actor = 'agent'
		   AND e.ts > COALESCE(c.last_read_ts, '')
		 GROUP BY e.task_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]Summary{}
	for rows.Next() {
		var id int64
		var sum Summary
		if err := rows.Scan(&id, &sum.Count, &sum.NewestTS); err != nil {
			return nil, err
		}
		out[id] = sum
	}
	return out, rows.Err()
}

// Cursors returns every stored cursor, keyed by Key. Used to decide whether an
// individual event is unread without a query per event.
func Cursors(conn *sql.DB) (map[string]string, error) {
	rows, err := conn.Query(
		`SELECT resource_type, resource_id, last_read_ts FROM resource_read_cursor`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var rt, rid, ts string
		if err := rows.Scan(&rt, &rid, &ts); err != nil {
			return nil, err
		}
		out[Key(rt, rid)] = ts
	}
	return out, rows.Err()
}

// MarkRead moves a resource's cursor to throughTS.
//
// throughTS is the newest event the CLIENT actually saw, never a server-side
// MAX(ts): events arriving between render and click must stay unread rather
// than being swallowed by a button that promised to clear a specific number.
//
// The cursor only ever moves forward. A stale client replaying an older
// throughTS is a no-op, not a rewind that resurrects read events.
func MarkRead(conn *sql.DB, resType, id, throughTS string) error {
	_, err := Mark(conn, resType, id, throughTS)
	return err
}

// Change is what one mark-read did to a cursor: where it was before, and
// where it is now. It is everything Restore needs to take the write back.
type Change struct {
	// Previous is the cursor before the write, nil when the resource had no
	// cursor row at all (which reads as nothing unread, not everything).
	Previous *string
	// Current is the cursor after it. Equal to *Previous when the write was a
	// no-op because the cursor was already past throughTS.
	Current string
}

// Mark is MarkRead reporting the cursor it moved, for an undo. The read and
// the write share a transaction so Previous is exactly what was replaced.
func Mark(conn *sql.DB, resType, id, throughTS string) (Change, error) {
	if resType == "slack" {
		return Change{}, ErrSlackNotSupported
	}
	if throughTS == "" {
		return Change{}, errors.New("through_ts is required")
	}
	tx, err := conn.Begin()
	if err != nil {
		return Change{}, err
	}
	defer tx.Rollback()

	var ch Change
	var prev string
	err = tx.QueryRow(`
		SELECT last_read_ts FROM resource_read_cursor
		 WHERE resource_type = ? AND resource_id = ?`, resType, id).Scan(&prev)
	switch {
	case err == nil:
		ch.Previous = &prev
	case !errors.Is(err, sql.ErrNoRows):
		return Change{}, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := tx.Exec(`
		INSERT INTO resource_read_cursor
			(resource_type, resource_id, last_read_ts, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (resource_type, resource_id) DO UPDATE SET
			last_read_ts = MAX(excluded.last_read_ts, resource_read_cursor.last_read_ts),
			updated_at   = excluded.updated_at`,
		resType, id, throughTS, now); err != nil {
		return Change{}, err
	}
	if err := tx.QueryRow(`
		SELECT last_read_ts FROM resource_read_cursor
		 WHERE resource_type = ? AND resource_id = ?`, resType, id).Scan(&ch.Current); err != nil {
		return Change{}, err
	}
	return ch, tx.Commit()
}

// ErrCursorMoved is returned by Restore when the cursor is no longer where the
// mark being undone left it.
var ErrCursorMoved = errors.New("read state changed since it was marked read")

// Restore takes back a Mark: it puts the cursor back to previous (removing the
// row when previous is nil, as there was none) — but only while the cursor
// still reads current, the value that Mark left.
//
// This is the ONLY way a cursor moves backward, and the compare-and-swap is
// what keeps that safe. Anything that marked the resource further in the
// meantime (another tab, the CLI, agent-handler) is a read the user made
// after the one being undone, and silently rewinding past it would resurrect
// events they have since read. That case is ErrCursorMoved, not a partial
// restore.
func Restore(conn *sql.DB, resType, id, current string, previous *string) error {
	if resType == "slack" {
		return ErrSlackNotSupported
	}
	if current == "" {
		return errors.New("current is required")
	}
	var res sql.Result
	var err error
	if previous == nil {
		res, err = conn.Exec(`
			DELETE FROM resource_read_cursor
			 WHERE resource_type = ? AND resource_id = ? AND last_read_ts = ?`,
			resType, id, current)
	} else {
		res, err = conn.Exec(`
			UPDATE resource_read_cursor
			   SET last_read_ts = ?, updated_at = ?
			 WHERE resource_type = ? AND resource_id = ? AND last_read_ts = ?`,
			*previous, time.Now().UTC().Format(time.RFC3339), resType, id, current)
	}
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrCursorMoved
	}
	return nil
}

// SlackCursors returns the read cursor per Slack thread, keyed by Key.
//
// Two things make it unlike Cursors, and both matter to callers:
//
// It is sourced from the poller-cached watcher_resource_state, not from
// resource_read_cursor. Slack owns this cursor — worktree only mirrors what
// the last poll saw — which is why marking a Slack thread read here is still
// ErrSlackNotSupported. The read side gained a source; the write side did not.
//
// It is a SLACK message ts, so it must be compared against
// watcher_events.external_ts and never against ts. That is the exact opposite
// of the rule in this package's doc comment, and deliberately so: the two
// timestamps live in different clocks, and Slack's cursor only means anything
// against Slack's own. The ordering hazard that rule exists to prevent — read
// and unread interleaving under a divider — does not arise here, because a
// Slack thread's own feed is the rendered thread view (which draws its divider
// from the live API) and the interleaved timelines mark events individually
// rather than dividing them.
//
// Threads with no cursor are absent from the map, so a caller's missing key
// means "nothing unread" — matching how has_unread resolves the same case.
func SlackCursors(conn *sql.DB) (map[string]string, error) {
	rows, err := conn.Query(`
		SELECT resource_id, json_extract(state_json, '$.last_read')
		  FROM watcher_resource_state
		 WHERE resource_type = 'slack'
		   AND json_extract(state_json, '$.last_read') IS NOT NULL
		   AND json_extract(state_json, '$.last_read') <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var rid, ts string
		if err := rows.Scan(&rid, &ts); err != nil {
			return nil, err
		}
		out[Key("slack", rid)] = ts
	}
	return out, rows.Err()
}

// SlackNewerSQL is the SQL form of "this Slack event is newer than Slack's
// read cursor", over an event aliased `e` and its thread's cached state row
// aliased `rs`. It mirrors the webui's slackTSGreater: Slack ts values are
// compared NUMERICALLY (they grow digits, so a string compare goes wrong),
// and the GLOBs stand in for ParseFloat's failure case — an unparseable or
// missing ts on either side reads as read, where CAST would quietly turn it
// into 0.
//
// Shared by SlackCounts and the global timeline's unread-only filter, so the
// count on a thread and the events that filter shows cannot drift apart.
const SlackNewerSQL = `e.external_ts GLOB '[0-9]*'
	AND json_extract(rs.state_json, '$.last_read') GLOB '[0-9]*'
	AND CAST(e.external_ts AS REAL) > CAST(json_extract(rs.state_json, '$.last_read') AS REAL)`

// SlackCounts returns the unread event count per Slack thread, keyed by Key:
// its events newer than Slack's cached last_read (see SlackCursors), with
// the same bookkeeping types left out as Counts. Threads with none, or with
// no cached cursor, are absent.
//
// This is a count of the REPLIES THE POLLER RECORDED, which is what the
// timelines can mark unread — not Slack's own tally. A thread Slack calls
// unread can therefore count zero here (its unread message was never
// recorded as an event, e.g. the root). Callers that pair this with
// has_unread must decide what that case shows; see unreadIndex.fill.
func SlackCounts(conn *sql.DB) (map[string]int, error) {
	rows, err := conn.Query(`
		SELECT er.resource_id, COUNT(*)
		  FROM watcher_event_resources er
		  JOIN watcher_events e ON e.id = er.event_id
		  JOIN watcher_resource_state rs
		    ON rs.resource_type = 'slack' AND rs.resource_id = er.resource_id
		 WHERE er.resource_type = 'slack'
		   AND e.type NOT IN ('watch_started','watcher_error')
		   AND ` + SlackNewerSQL + `
		   AND ` + selfid.NotMineSQL + `
		 GROUP BY er.resource_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var rid string
		var n int
		if err := rows.Scan(&rid, &n); err != nil {
			return nil, err
		}
		out[Key("slack", rid)] = n
	}
	return out, rows.Err()
}
