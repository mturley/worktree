package tasks

import (
	"database/sql"
	"testing"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
)

// liveHolds returns the live task: subscriptions as "subscriber type:id".
func liveHolds(t *testing.T, conn *sql.DB) map[string]bool {
	t.Helper()
	subs, err := watcherdb.ActiveSubscriptions(conn, holdPrefix, true)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, s := range subs {
		out[s.Subscriber+" "+s.Resource.Type+":"+s.Resource.ID] = true
	}
	return out
}

// holdRows counts every task: row, tombstoned or not.
func holdRows(t *testing.T, conn *sql.DB) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM watcher_subscriptions WHERE subscriber LIKE 'task:%'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func holdKey(taskID int64, res string) string { return HoldSubscriber(taskID) + " " + res }

func TestHoldSubscriber(t *testing.T) {
	if got := HoldSubscriber(42); got != "task:42" {
		t.Fatalf("HoldSubscriber(42) = %q", got)
	}
}

func TestHoldLifecycle(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "blocked")
	b := mustAddBlocker(t, conn, tk.ID, resTarget("pr", "o/r#1"))
	want := holdKey(tk.ID, "pr:o/r#1")
	if h := liveHolds(t, conn); !h[want] || len(h) != 1 {
		t.Fatalf("after add, holds = %v, want only %s", h, want)
	}

	if _, err := SetState(conn, user, tk.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	if h := liveHolds(t, conn); len(h) != 0 {
		t.Fatalf("after completing, holds = %v, want none", h)
	}

	if _, err := SetState(conn, user, tk.ID, StateInProgress); err != nil {
		t.Fatal(err)
	}
	if h := liveHolds(t, conn); !h[want] || len(h) != 1 {
		t.Fatalf("after reopening, holds = %v, want only %s", h, want)
	}

	if err := RemoveBlocker(conn, user, b.ID); err != nil {
		t.Fatal(err)
	}
	if h := liveHolds(t, conn); len(h) != 0 {
		t.Fatalf("after removing the blocker, holds = %v, want none", h)
	}
	// Complete, reopen and re-add all reuse the one row: nothing piles up.
	if n := holdRows(t, conn); n != 1 {
		t.Fatalf("task: rows = %d, want 1 (reused tombstone)", n)
	}
	mustAddBlocker(t, conn, tk.ID, resTarget("pr", "o/r#1"))
	if n := holdRows(t, conn); n != 1 {
		t.Fatalf("task: rows after re-add = %d, want 1", n)
	}
}

func TestHoldReleasedOnDelete(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "blocked")
	mustAddBlocker(t, conn, tk.ID, resTarget("jira", "J-1"))
	if len(liveHolds(t, conn)) != 1 {
		t.Fatal("want a hold before delete")
	}
	if _, err := Delete(conn, user, tk.ID); err != nil {
		t.Fatal(err)
	}
	if h := liveHolds(t, conn); len(h) != 0 {
		t.Fatalf("after delete, holds = %v", h)
	}
}

func TestHoldOnlyForResourceBlockers(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "blocked")
	dep := mustCreate(t, conn, "dep")
	mustAddBlocker(t, conn, tk.ID, taskTarget(dep.ID))
	mustAddBlocker(t, conn, tk.ID, otherTarget("legal"))
	if h := liveHolds(t, conn); len(h) != 0 {
		t.Fatalf("task/other blockers must not hold: %v", h)
	}
}

func TestHoldKeptWhenBlockerResolves(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "blocked")
	b := mustAddBlocker(t, conn, tk.ID, resTarget("slack", "C1:1.2"))
	if err := SetBlockerResolved(conn, user, b.ID, true); err != nil {
		t.Fatal(err)
	}
	if h := liveHolds(t, conn); !h[holdKey(tk.ID, "slack:C1:1.2")] {
		t.Fatalf("a resolved blocker keeps its hold: %v", h)
	}
}

func TestHoldPerTask(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "a"), mustCreate(t, conn, "b")
	mustAddBlocker(t, conn, a.ID, resTarget("pr", "o/r#1"))
	mustAddBlocker(t, conn, b.ID, resTarget("pr", "o/r#1"))
	h := liveHolds(t, conn)
	if !h[holdKey(a.ID, "pr:o/r#1")] || !h[holdKey(b.ID, "pr:o/r#1")] || len(h) != 2 {
		t.Fatalf("holds = %v, want one per task", h)
	}
	if _, err := SetState(conn, user, a.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	if h := liveHolds(t, conn); !h[holdKey(b.ID, "pr:o/r#1")] || len(h) != 1 {
		t.Fatalf("completing a releases only a's hold: %v", h)
	}
}

func TestReconcileHoldsIdempotentAndRepairs(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "blocked")
	mustAddBlocker(t, conn, tk.ID, resTarget("pr", "o/r#1"))

	// Drift both ways behind its back: drop the wanted hold and add a stray.
	r := watcher.Resource{Type: "pr", ID: "o/r#1"}
	if err := watcherdb.Unsubscribe(conn, HoldSubscriber(tk.ID), r); err != nil {
		t.Fatal(err)
	}
	stray := watcher.Resource{Type: "jira", ID: "J-9"}
	if err := watcherdb.Subscribe(conn, HoldSubscriber(999), stray, watcherdb.SubscribeOpts{}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := ReconcileHolds(conn); err != nil {
			t.Fatal(err)
		}
		if h := liveHolds(t, conn); !h[holdKey(tk.ID, "pr:o/r#1")] || len(h) != 1 {
			t.Fatalf("pass %d: holds = %v", i, h)
		}
	}
	if n := holdRows(t, conn); n != 2 {
		t.Fatalf("task: rows = %d, want 2 (one live, one tombstone)", n)
	}

	// Even a user tombstone on a hold is revived: holds are not the user's.
	if err := watcherdb.UserUnsubscribe(conn, HoldSubscriber(tk.ID), r); err != nil {
		t.Fatal(err)
	}
	if err := ReconcileHolds(conn); err != nil {
		t.Fatal(err)
	}
	if h := liveHolds(t, conn); !h[holdKey(tk.ID, "pr:o/r#1")] {
		t.Fatalf("user-tombstoned hold not revived: %v", h)
	}
}

func TestHoldLeavesWorktreeSubscriptionsAlone(t *testing.T) {
	conn := newDB(t)
	r := watcher.Resource{Type: "pr", ID: "o/r#1"}
	if err := watcherdb.Subscribe(conn, "worktree:/x", r, watcherdb.SubscribeOpts{}); err != nil {
		t.Fatal(err)
	}
	tk := mustCreate(t, conn, "blocked")
	b := mustAddBlocker(t, conn, tk.ID, resTarget("pr", "o/r#1"))
	if err := RemoveBlocker(conn, user, b.ID); err != nil {
		t.Fatal(err)
	}
	subs, err := watcherdb.ActiveSubscriptions(conn, "worktree:/x", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("worktree subscription disturbed: %+v", subs)
	}
}

func TestHoldCopiesKnownURL(t *testing.T) {
	conn := newDB(t)
	r := watcher.Resource{Type: "pr", ID: "o/r#1", URL: "https://github.com/o/r/pull/1"}
	if err := watcherdb.Subscribe(conn, "worktree:/x", r, watcherdb.SubscribeOpts{}); err != nil {
		t.Fatal(err)
	}
	tk := mustCreate(t, conn, "blocked")
	mustAddBlocker(t, conn, tk.ID, resTarget("pr", "o/r#1"))
	subs, err := watcherdb.ActiveSubscriptions(conn, HoldSubscriber(tk.ID), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || subs[0].Resource.URL != r.URL {
		t.Fatalf("hold = %+v, want URL %s", subs, r.URL)
	}
}
