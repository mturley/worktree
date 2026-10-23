package tasks

import (
	"database/sql"
	"fmt"
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
// (resolved or not) of a task that is neither done nor deleted, links
// excepted: a link is never polled for a status (only the user resolves
// it), so holding one would serve no purpose. Missing holds
// are subscribed (reviving the pair's tombstone, so complete/reopen cycles
// reuse one row rather than piling them up); live holds nothing wants are
// unsubscribed. A live hold whose URL is not what holdURL now picks is
// rewritten. It is idempotent: a second call writes nothing.
//
// It goes through the watcher library, which opens its own transactions on
// conn, so it must never run inside inTx: callers run it after commit.
func ReconcileHolds(conn *sql.DB) error {
	holdsMu.Lock()
	defer holdsMu.Unlock()

	type hold struct{ sub, typ, id string }
	wanted := map[hold]string{} // -> the blocker's own URL ('' if none)
	rows, err := conn.QueryContext(bg,
		`SELECT b.task_id, b.resource_type, b.resource_id, MAX(b.resource_url)
		   FROM task_blockers b JOIN tasks t ON t.id = b.task_id
		  WHERE b.kind = 'resource' AND b.resource_type != 'link'
		    AND t.deleted_at IS NULL AND t.state != ?
		  GROUP BY b.task_id, b.resource_type, b.resource_id`, StateDone)
	if err != nil {
		return fmt.Errorf("reconcile holds: %w", err)
	}
	for rows.Next() {
		var taskID int64
		var h hold
		var u string
		if err := rows.Scan(&taskID, &h.typ, &h.id, &u); err != nil {
			rows.Close()
			return fmt.Errorf("reconcile holds: %w", err)
		}
		h.sub = HoldSubscriber(taskID)
		wanted[h] = u
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
	live := map[hold]string{} // -> the live hold's URL
	userTomb := map[hold]bool{}
	nowTS := now()
	for _, s := range all {
		h := hold{s.Subscriber, s.Resource.Type, s.Resource.ID}
		switch {
		case s.DeletedAt == nil && (s.ExpiresAt == nil || *s.ExpiresAt > nowTS):
			live[h] = s.Resource.URL
		case s.DeletedAt != nil && s.UnsubscribedByUser:
			userTomb[h] = true
		}
	}

	for h := range live {
		if _, ok := wanted[h]; ok {
			continue
		}
		if err := watcherdb.Unsubscribe(conn, h.sub, watcher.Resource{Type: h.typ, ID: h.id}); err != nil {
			return fmt.Errorf("reconcile holds: release %s %s:%s: %w", h.sub, h.typ, h.id, err)
		}
	}
	// One URL decision per resource per pass, from inputs that do not
	// depend on map order: the lexically first non-empty blocker URL among
	// the resource's wanted holds.
	blockerURLs := map[[2]string]string{}
	for h, u := range wanted {
		k := [2]string{h.typ, h.id}
		if cur := blockerURLs[k]; u != "" && (cur == "" || u < cur) {
			blockerURLs[k] = u
		}
	}
	urls := map[[2]string]string{}
	for h := range wanted {
		k := [2]string{h.typ, h.id}
		u, ok := urls[k]
		if !ok {
			u = holdURL(conn, h.typ, h.id, blockerURLs[k])
			urls[k] = u
		}
		cur, isLive := live[h]
		if isLive && cur == u {
			continue
		}
		r := watcher.Resource{Type: h.typ, ID: h.id, URL: u}
		if !isLive && userTomb[h] {
			// Nobody user-unsubscribes a hold on purpose; revive it.
			if err := watcherdb.Reinstate(conn, h.sub, r); err != nil {
				return fmt.Errorf("reconcile holds: reinstate %s %s:%s: %w", h.sub, h.typ, h.id, err)
			}
		}
		// Not IfAbsent: a live row whose lease expired is not live here, and
		// a plain Subscribe clears its expiry (TTL 0 never expires). On a
		// live hold it only rewrites the URL.
		if err := watcherdb.Subscribe(conn, h.sub, r, watcherdb.SubscribeOpts{}); err != nil {
			return fmt.Errorf("reconcile holds: hold %s %s:%s: %w", h.sub, h.typ, h.id, err)
		}
	}
	return nil
}

// holdURL is the URL a hold on (typ, id) records: the lexically first URL
// the resource's blockers were added from, else the URL already known for
// the resource (watcherdb.ResourceURL), else none. The pollers work from
// the id alone, so a hold without a URL still polls, and since watcher
// v0.16.0 watcherdb.ActiveResources lists each resource once whatever URLs
// its subscriptions record, so a hold's URL never makes it polled twice.
//
// ReconcileHolds computes it once per resource per pass, before writing any
// hold on that resource, so all of one resource's holds record the same
// URL. It settles in one pass: from blocker URLs the answer does not depend
// on the holds at all; from ResourceURL, the next pass sees the holds'
// own URL among the live ones, and it was already the lexically first.
func holdURL(conn *sql.DB, typ, id, blockerURL string) string {
	if blockerURL != "" {
		return blockerURL
	}
	u, err := watcherdb.ResourceURL(conn, typ, id)
	if err != nil {
		Logf("tasks: hold url %s %s: %v", typ, id, err)
		return ""
	}
	return u
}

// reconcileHoldsAfterWrite is what a public write calls after its commit.
// The user's write has already committed and is not undone by a hold that
// failed to move, so the error is logged rather than returned: the poll loop
// reconciles again after every pass, which repairs any drift.
func reconcileHoldsAfterWrite(conn *sql.DB) {
	if err := ReconcileHolds(conn); err != nil {
		Logf("tasks: %v (the poll loop will retry)", err)
	}
}
