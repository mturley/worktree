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
)

// ErrSlackNotSupported is returned for any write against a Slack thread.
//
// Slack owns a read cursor for the current user already, worktree reads it via
// the poller-cached has_unread, and two systems must not both claim authority
// over the same thread.
var ErrSlackNotSupported = errors.New("slack threads keep their own read state")

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
	rows, err := conn.Query(`
		SELECT er.resource_type, er.resource_id, COUNT(*)
		  FROM watcher_event_resources er
		  JOIN watcher_events e ON e.id = er.event_id
		  JOIN resource_read_cursor c
		    ON c.resource_type = er.resource_type
		   AND c.resource_id   = er.resource_id
		 WHERE e.ts > c.last_read_ts
		   AND e.type NOT IN ('watch_started','watcher_error')
		 GROUP BY er.resource_type, er.resource_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var rt, rid string
		var n int
		if err := rows.Scan(&rt, &rid, &n); err != nil {
			return nil, err
		}
		out[Key(rt, rid)] = n
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
	if resType == "slack" {
		return ErrSlackNotSupported
	}
	if throughTS == "" {
		return errors.New("through_ts is required")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := conn.Exec(`
		INSERT INTO resource_read_cursor
			(resource_type, resource_id, last_read_ts, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (resource_type, resource_id) DO UPDATE SET
			last_read_ts = MAX(excluded.last_read_ts, resource_read_cursor.last_read_ts),
			updated_at   = excluded.updated_at`,
		resType, id, throughTS, now)
	return err
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
