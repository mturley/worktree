package tasks

import (
	"database/sql"
	"fmt"
	"log"
	"sync"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
)

// holdPrefix is the subscriber prefix of a task's subscription holds.
const holdPrefix = "task:"

// HoldSubscriber is the watcher_subscriptions subscriber under which task
// taskID holds the resources it is blocked by: "task:<id>".
//
// A hold exists only to keep the resource polled (watcherdb.ActiveResources
// counts every live subscriber), so the resolver sees a PR merge or a Jira
// issue reach Done even when no worktree follows it. It must never make the
// resource look followed: everything that means "followed by a worktree"
// reads `worktree:` subscribers only.
func HoldSubscriber(taskID int64) string { return fmt.Sprintf("%s%d", holdPrefix, taskID) }

// holdsMu serialises ReconcileHolds within this process. The watcher
// library's Subscribe is check-then-insert with no unique index behind it,
// so two concurrent reconciles could both insert the same missing hold.
var holdsMu sync.Mutex

// ReconcileHolds makes the live `task:` subscriptions match exactly what
// should be held: one per (task, resource) for every resource blocker
// (resolved or not) of a task that is neither done nor deleted. Missing holds
// are subscribed (reviving the pair's tombstone, so complete/reopen cycles
// reuse one row rather than piling them up); live holds nothing wants are
// unsubscribed. It is idempotent: a second call writes nothing.
//
// It goes through the watcher library, which opens its own transactions on
// conn, so it must never run inside inTx: callers run it after commit.
func ReconcileHolds(conn *sql.DB) error {
	holdsMu.Lock()
	defer holdsMu.Unlock()

	type hold struct{ sub, typ, id string }
	wanted := map[hold]bool{}
	rows, err := conn.QueryContext(bg,
		`SELECT DISTINCT b.task_id, b.resource_type, b.resource_id
		   FROM task_blockers b JOIN tasks t ON t.id = b.task_id
		  WHERE b.kind = 'resource' AND t.deleted_at IS NULL AND t.state != ?`, StateDone)
	if err != nil {
		return fmt.Errorf("reconcile holds: %w", err)
	}
	for rows.Next() {
		var taskID int64
		var h hold
		if err := rows.Scan(&taskID, &h.typ, &h.id); err != nil {
			rows.Close()
			return fmt.Errorf("reconcile holds: %w", err)
		}
		h.sub = HoldSubscriber(taskID)
		wanted[h] = true
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("reconcile holds: %w", err)
	}

	// Every task: row, live or not: live ones are compared against wanted,
	// and a user tombstone needs Reinstate, which Subscribe will not do.
	all, err := watcherdb.AllSubscriptions(conn, holdPrefix, true)
	if err != nil {
		return fmt.Errorf("reconcile holds: %w", err)
	}
	live := map[hold]bool{}
	userTomb := map[hold]bool{}
	nowTS := now()
	for _, s := range all {
		h := hold{s.Subscriber, s.Resource.Type, s.Resource.ID}
		switch {
		case s.DeletedAt == nil && (s.ExpiresAt == nil || *s.ExpiresAt > nowTS):
			live[h] = true
		case s.DeletedAt != nil && s.UnsubscribedByUser:
			userTomb[h] = true
		}
	}

	for h := range live {
		if wanted[h] {
			continue
		}
		if err := watcherdb.Unsubscribe(conn, h.sub, watcher.Resource{Type: h.typ, ID: h.id}); err != nil {
			return fmt.Errorf("reconcile holds: release %s %s:%s: %w", h.sub, h.typ, h.id, err)
		}
	}
	for h := range wanted {
		if live[h] {
			continue
		}
		r := watcher.Resource{Type: h.typ, ID: h.id, URL: knownResourceURL(conn, h.typ, h.id)}
		if userTomb[h] {
			// Nobody user-unsubscribes a hold on purpose; revive it.
			if err := watcherdb.Reinstate(conn, h.sub, r); err != nil {
				return fmt.Errorf("reconcile holds: reinstate %s %s:%s: %w", h.sub, h.typ, h.id, err)
			}
		}
		// Not IfAbsent: a live row whose lease expired is not live here, and
		// a plain Subscribe clears its expiry (TTL 0 never expires).
		if err := watcherdb.Subscribe(conn, h.sub, r, watcherdb.SubscribeOpts{}); err != nil {
			return fmt.Errorf("reconcile holds: hold %s %s:%s: %w", h.sub, h.typ, h.id, err)
		}
	}
	return nil
}

// knownResourceURL is the resource's URL as any subscription (live first) or
// event already records it, or "" when nothing does. A resource blocker
// stores only a type and id; the pollers work from the id alone, so a hold
// without a URL still polls.
func knownResourceURL(q dbtx, typ, id string) string {
	var u string
	_ = q.QueryRowContext(bg, `SELECT resource_url FROM watcher_subscriptions
		WHERE resource_type = ? AND resource_id = ? AND COALESCE(resource_url,'') <> ''
		ORDER BY deleted_at IS NOT NULL, created_at DESC LIMIT 1`, typ, id).Scan(&u)
	if u != "" {
		return u
	}
	_ = q.QueryRowContext(bg, `SELECT resource_url FROM watcher_event_resources
		WHERE resource_type = ? AND resource_id = ? AND COALESCE(resource_url,'') <> '' LIMIT 1`, typ, id).Scan(&u)
	return u
}

// reconcileHoldsAfterWrite is what a public write calls after its commit.
// The user's write has already committed and is not undone by a hold that
// failed to move, so the error is logged rather than returned: the poll loop
// reconciles again after every pass, which repairs any drift.
func reconcileHoldsAfterWrite(conn *sql.DB) {
	if err := ReconcileHolds(conn); err != nil {
		log.Printf("tasks: %v (the poll loop will retry)", err)
	}
}
