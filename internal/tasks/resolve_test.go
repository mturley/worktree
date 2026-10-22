package tasks

import (
	"database/sql"
	"sync"
	"testing"
)

// fakeLookup answers from a map keyed "type:id"; absent keys are unknown.
type fakeLookup map[string]ResourceStatus

func (f fakeLookup) lookup(typ, id string) (ResourceStatus, bool) {
	st, ok := f[typ+":"+id]
	return st, ok
}

func mustResolve(t *testing.T, conn *sql.DB, l StatusLookup) []Resolution {
	t.Helper()
	rs, err := ResolveBlockers(conn, l)
	if err != nil {
		t.Fatal(err)
	}
	return rs
}

func onlyBlocker(t *testing.T, conn *sql.DB, taskID int64) Blocker {
	t.Helper()
	bs := mustBlockers(t, conn, taskID)
	if len(bs) != 1 {
		t.Fatalf("task %d has %d blockers, want 1", taskID, len(bs))
	}
	return bs[0]
}

// lastEvent is the newest event of taskID.
func lastEvent(t *testing.T, conn *sql.DB, taskID int64) Event {
	t.Helper()
	es, err := Events(conn, taskID)
	if err != nil || len(es) == 0 {
		t.Fatalf("Events(%d) = %v, %v", taskID, es, err)
	}
	return es[0]
}

func TestTaskBlockerResolvesWhenDoneAndUnresolvesOnReopen(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "B")
	mustAddBlocker(t, conn, a.ID, taskTarget(b.ID))

	// Completing B resolves A's blocker at once, with no poll.
	if _, err := SetState(conn, user, b.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	got := onlyBlocker(t, conn, a.ID)
	if got.ResolvedAt == "" || !got.ResolvedAuto || got.ResolvedReason != "done" {
		t.Fatalf("after completing B, blocker = %+v, want auto-resolved \"done\"", got)
	}
	e := lastEvent(t, conn, a.ID)
	if e.Type != EventTaskBlockerResolved || e.Actor != ActorSystem {
		t.Fatalf("last event = %s by %s, want %s by system", e.Type, e.Actor, EventTaskBlockerResolved)
	}
	if p := payloadOf(t, e); p["auto"] != true || p["reason"] != "done" {
		t.Fatalf("resolved payload = %v", p)
	}
	if tk, _ := Get(conn, a.ID); tk.Blocked {
		t.Fatal("A still blocked after B was completed")
	}
	// A second pass changes nothing.
	if rs := mustResolve(t, conn, nil); len(rs) != 0 {
		t.Fatalf("second pass = %+v, want none", rs)
	}

	// Reopening B unresolves it.
	if _, err := SetState(conn, user, b.ID, StateInProgress); err != nil {
		t.Fatal(err)
	}
	got = onlyBlocker(t, conn, a.ID)
	if got.ResolvedAt != "" || got.ResolvedAuto || got.ResolvedReason != "" {
		t.Fatalf("after reopening B, blocker = %+v, want unresolved", got)
	}
	if e := lastEvent(t, conn, a.ID); e.Type != EventTaskBlockerUnresolved || e.Actor != ActorSystem {
		t.Fatalf("last event = %s by %s, want %s by system", e.Type, e.Actor, EventTaskBlockerUnresolved)
	}
}

func TestTaskBlockerResolvesWhenBlockingTaskDeleted(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "B")
	mustAddBlocker(t, conn, a.ID, taskTarget(b.ID))
	if _, err := Delete(conn, user, b.ID); err != nil {
		t.Fatal(err)
	}
	got := onlyBlocker(t, conn, a.ID)
	if got.ResolvedAt == "" || !got.ResolvedAuto || got.ResolvedReason != "deleted" {
		t.Fatalf("blocker = %+v, want auto-resolved \"deleted\"", got)
	}
}

func TestAddBlockerOnDoneTaskResolvesAtOnce(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "B")
	if _, err := SetState(conn, user, b.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	got := mustAddBlocker(t, conn, a.ID, taskTarget(b.ID))
	if got.ResolvedAt == "" || !got.ResolvedAuto || got.ResolvedReason != "done" {
		t.Fatalf("AddBlocker returned %+v, want it already auto-resolved", got)
	}
}

func TestResourceBlockerFollowsLookup(t *testing.T) {
	conn := newDB(t)
	a := mustCreate(t, conn, "A")
	b := mustAddBlocker(t, conn, a.ID, resTarget("pr", "o/r#1"))

	// Unknown: nothing changes; a nil lookup leaves resources alone too.
	if rs := mustResolve(t, conn, fakeLookup{}.lookup); len(rs) != 0 {
		t.Fatalf("unknown status gave %+v", rs)
	}
	if rs := mustResolve(t, conn, nil); len(rs) != 0 {
		t.Fatalf("nil lookup gave %+v", rs)
	}

	merged := fakeLookup{"pr:o/r#1": {Done: true, Label: "merged"}}
	rs := mustResolve(t, conn, merged.lookup)
	want := Resolution{TaskID: a.ID, BlockerID: b.ID, Resolved: true, Label: "pr:o/r#1", Reason: "merged"}
	if len(rs) != 1 || rs[0] != want {
		t.Fatalf("merged pass = %+v, want [%+v]", rs, want)
	}
	if got := onlyBlocker(t, conn, a.ID); !got.ResolvedAuto || got.ResolvedReason != "merged" {
		t.Fatalf("blocker = %+v", got)
	}
	if rs := mustResolve(t, conn, merged.lookup); len(rs) != 0 {
		t.Fatalf("repeat pass = %+v, want none", rs)
	}
	// Unknown later keeps the last state.
	if rs := mustResolve(t, conn, fakeLookup{}.lookup); len(rs) != 0 || onlyBlocker(t, conn, a.ID).ResolvedAt == "" {
		t.Fatalf("unknown status changed a resolved blocker: %+v", rs)
	}

	reopened := fakeLookup{"pr:o/r#1": {Done: false, Label: "open"}}
	rs = mustResolve(t, conn, reopened.lookup)
	want = Resolution{TaskID: a.ID, BlockerID: b.ID, Resolved: false, Label: "pr:o/r#1"}
	if len(rs) != 1 || rs[0] != want {
		t.Fatalf("reopened pass = %+v, want [%+v]", rs, want)
	}
	if got := onlyBlocker(t, conn, a.ID); got.ResolvedAt != "" {
		t.Fatalf("blocker = %+v, want unresolved", got)
	}
}

func TestManualResolveIsNeverTouched(t *testing.T) {
	conn := newDB(t)
	a := mustCreate(t, conn, "A")
	sl := mustAddBlocker(t, conn, a.ID, resTarget("slack", "C1:1.2"))
	ot := mustAddBlocker(t, conn, a.ID, otherTarget("waiting on legal"))
	for _, id := range []int64{sl.ID, ot.ID} {
		if err := SetBlockerResolved(conn, user, id, true); err != nil {
			t.Fatal(err)
		}
	}
	// Even a lookup claiming the thread is not done leaves it alone.
	l := fakeLookup{"slack:C1:1.2": {Done: false, Label: "open"}}
	if rs := mustResolve(t, conn, l.lookup); len(rs) != 0 {
		t.Fatalf("pass touched manual resolves: %+v", rs)
	}
	for _, b := range mustBlockers(t, conn, a.ID) {
		if b.ResolvedAt == "" || b.ResolvedAuto {
			t.Fatalf("blocker %+v changed", b)
		}
	}
}

func TestDoneOrDeletedTasksAreNotEvaluated(t *testing.T) {
	conn := newDB(t)
	done, gone := mustCreate(t, conn, "done"), mustCreate(t, conn, "gone")
	mustAddBlocker(t, conn, done.ID, resTarget("pr", "o/r#1"))
	mustAddBlocker(t, conn, gone.ID, resTarget("pr", "o/r#1"))
	if _, err := SetState(conn, user, done.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	if _, err := Delete(conn, user, gone.ID); err != nil {
		t.Fatal(err)
	}
	l := fakeLookup{"pr:o/r#1": {Done: true, Label: "merged"}}
	if rs := mustResolve(t, conn, l.lookup); len(rs) != 0 {
		t.Fatalf("pass resolved blockers of done/deleted tasks: %+v", rs)
	}
}

func TestResolutionSinkGetsWriteTimeResolutions(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "B")
	blk := mustAddBlocker(t, conn, a.ID, taskTarget(b.ID))

	var mu sync.Mutex
	var got []Resolution
	SetResolutionSink(conn, func(rs []Resolution) {
		mu.Lock()
		got = append(got, rs...)
		mu.Unlock()
	})
	t.Cleanup(func() { SetResolutionSink(conn, nil) })

	if _, err := SetState(conn, user, b.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || got[0].BlockerID != blk.ID || !got[0].Resolved || got[0].Reason != "done" ||
		got[0].Label != "T"+itoa(b.ID)+" B" {
		t.Fatalf("sink got %+v", got)
	}
}

func TestLogfSeam(t *testing.T) {
	var msgs []string
	old := Logf
	Logf = func(format string, args ...any) { msgs = append(msgs, format) }
	t.Cleanup(func() { Logf = old })

	conn := newDB(t)
	conn.Close() // every write after commit now fails, and must be logged
	resolveAfterWrite(conn)
	reconcileHoldsAfterWrite(conn)
	if len(msgs) != 2 {
		t.Fatalf("Logf calls = %v, want 2", msgs)
	}
}
