package tasks

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
)

func taskTarget(id int64) BlockerTarget { return BlockerTarget{Kind: BlockerTask, BlockingTaskID: id} }

func resTarget(typ, id string) BlockerTarget {
	return BlockerTarget{Kind: BlockerResource, ResourceType: typ, ResourceID: id}
}

func otherTarget(text string) BlockerTarget { return BlockerTarget{Kind: BlockerOther, Text: text} }

func mustAddBlocker(t *testing.T, conn *sql.DB, taskID int64, bt BlockerTarget) Blocker {
	t.Helper()
	b, err := AddBlocker(conn, user, taskID, bt)
	if err != nil {
		t.Fatalf("AddBlocker(%d, %+v): %v", taskID, bt, err)
	}
	return b
}

func mustBlockers(t *testing.T, conn *sql.DB, taskID int64) []Blocker {
	t.Helper()
	bs, err := Blockers(conn, taskID)
	if err != nil {
		t.Fatal(err)
	}
	return bs
}

func payloadOf(t *testing.T, e Event) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(e.Payload, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestAddListRemoveBlockerEachKind(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "blocked")
	dep := mustCreate(t, conn, "dependency")

	cases := []struct {
		target BlockerTarget
		label  string
	}{
		{taskTarget(dep.ID), "T" + itoa(dep.ID) + " dependency"},
		{resTarget(" pr ", " o/r#1 "), "pr:o/r#1"},
		{otherTarget("  waiting on legal  "), "waiting on legal"},
	}
	for _, c := range cases {
		backdate(t, conn, tk.ID)
		before := updatedAt(t, conn, tk.ID)
		v := mustVersion(t, conn)
		b := mustAddBlocker(t, conn, tk.ID, c.target)
		if b.ID == 0 || b.TaskID != tk.ID || b.Kind != c.target.Kind || b.ResolvedAt != "" || b.CreatedAt == "" {
			t.Fatalf("added %+v", b)
		}
		if mustVersion(t, conn) == v {
			t.Errorf("%s: version not bumped", c.target.Kind)
		}
		if updatedAt(t, conn, tk.ID) == before {
			t.Errorf("%s: updated_at not bumped", c.target.Kind)
		}
		// Adding records no event, but the resolution events' payload
		// names the blocker this way.
		p, err := blockerPayload(conn, b.ID, b.BlockerTarget)
		if err != nil {
			t.Fatal(err)
		}
		if p["label"] != c.label || p["kind"] != c.target.Kind || p["blocker_id"] != b.ID {
			t.Errorf("payload %v, want label %q", p, c.label)
		}
	}
	bs := mustBlockers(t, conn, tk.ID)
	if len(bs) != 3 {
		t.Fatalf("blockers %+v", bs)
	}
	if bs[0].TaskID != tk.ID || bs[0].BlockerTarget != taskTarget(dep.ID) {
		t.Errorf("task blocker %+v", bs[0])
	}
	if bs[1].BlockerTarget != resTarget("pr", "o/r#1") {
		t.Errorf("resource blocker not normalised: %+v", bs[1])
	}
	if bs[2].BlockerTarget != otherTarget("waiting on legal") {
		t.Errorf("other blocker not normalised: %+v", bs[2])
	}

	for i, b := range bs {
		backdate(t, conn, tk.ID)
		before := updatedAt(t, conn, tk.ID)
		if err := RemoveBlocker(conn, user, b.ID); err != nil {
			t.Fatal(err)
		}
		if updatedAt(t, conn, tk.ID) == before {
			t.Errorf("remove %d: updated_at not bumped", i)
		}
	}
	if bs := mustBlockers(t, conn, tk.ID); len(bs) != 0 {
		t.Fatalf("after remove %+v", bs)
	}
	if err := RemoveBlocker(conn, user, bs[0].ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("remove twice: %v", err)
	}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestAddBlockerValidation(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	for name, bt := range map[string]BlockerTarget{
		"bad kind":         {Kind: "nope"},
		"task without id":  {Kind: BlockerTask},
		"missing task":     taskTarget(9999),
		"resource no id":   resTarget("pr", " "),
		"resource no type": resTarget("", "x"),
		"other empty":      otherTarget("   "),
	} {
		if _, err := AddBlocker(conn, user, tk.ID, bt); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
	if _, err := AddBlocker(conn, user, 9999, otherTarget("x")); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing blocked task: %v", err)
	}
	// The CLI and web may never write as system.
	sys := Actor{Kind: ActorSystem}
	if _, err := AddBlocker(conn, sys, tk.ID, otherTarget("x")); !errors.Is(err, ErrInvalid) {
		t.Errorf("system add: %v", err)
	}
	b := mustAddBlocker(t, conn, tk.ID, otherTarget("x"))
	if err := RemoveBlocker(conn, sys, b.ID); !errors.Is(err, ErrInvalid) {
		t.Errorf("system remove: %v", err)
	}
	if err := SetBlockerResolved(conn, sys, b.ID, true); !errors.Is(err, ErrInvalid) {
		t.Errorf("system resolve: %v", err)
	}
	if _, err := Create(conn, sys, NewTask{Title: "x"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("system create: %v", err)
	}
}

func TestAddBlockerDuplicateIsNoOp(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	dep := mustCreate(t, conn, "d")
	for _, bt := range []BlockerTarget{taskTarget(dep.ID), resTarget("pr", "o/r#1"), otherTarget("legal")} {
		first := mustAddBlocker(t, conn, tk.ID, bt)
		v := mustVersion(t, conn)
		again := mustAddBlocker(t, conn, tk.ID, bt)
		if again.ID != first.ID {
			t.Errorf("%s: duplicate made a new row %d (first %d)", bt.Kind, again.ID, first.ID)
		}
		if mustVersion(t, conn) != v {
			t.Errorf("%s: duplicate bumped version", bt.Kind)
		}
	}
	if n := len(mustBlockers(t, conn, tk.ID)); n != 3 {
		t.Fatalf("blockers %d", n)
	}
}

func TestAddBlockerRejectsCycles(t *testing.T) {
	conn := newDB(t)
	a := mustCreate(t, conn, "a")
	b := mustCreate(t, conn, "b")
	c := mustCreate(t, conn, "c")

	if _, err := AddBlocker(conn, user, a.ID, taskTarget(a.ID)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("self block: %v", err)
	}
	mustAddBlocker(t, conn, a.ID, taskTarget(b.ID)) // a blocked by b
	if _, err := AddBlocker(conn, user, b.ID, taskTarget(a.ID)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("two-task cycle: %v", err)
	}
	bc := mustAddBlocker(t, conn, b.ID, taskTarget(c.ID)) // b blocked by c
	if _, err := AddBlocker(conn, user, c.ID, taskTarget(a.ID)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("three-task cycle: %v", err)
	}
	// Only unresolved edges count: resolving b<-c breaks the chain.
	if _, err := conn.Exec(`UPDATE task_blockers SET resolved_at = '2026-01-01T00:00:00Z' WHERE id = ?`, bc.ID); err != nil {
		t.Fatal(err)
	}
	mustAddBlocker(t, conn, c.ID, taskTarget(a.ID))
	// Only non-deleted tasks count: a deleted middle task breaks the chain.
	d := mustCreate(t, conn, "d")
	e := mustCreate(t, conn, "e")
	f := mustCreate(t, conn, "f")
	mustAddBlocker(t, conn, d.ID, taskTarget(e.ID))
	mustAddBlocker(t, conn, e.ID, taskTarget(f.ID))
	if _, err := Delete(conn, user, e.ID); err != nil {
		t.Fatal(err)
	}
	mustAddBlocker(t, conn, f.ID, taskTarget(d.ID))
	// A deleted blocking task can't be added.
	if _, err := AddBlocker(conn, user, f.ID, taskTarget(e.ID)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("deleted blocking task: %v", err)
	}
}

func TestSetBlockerResolvedManualRules(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	dep := mustCreate(t, conn, "d")
	allowed := []BlockerTarget{otherTarget("legal"), resTarget("slack", "C1:1.2"), resTarget("link", "https://x")}
	refused := []BlockerTarget{taskTarget(dep.ID), resTarget("pr", "o/r#1"), resTarget("jira", "ABC-1")}
	for _, bt := range refused {
		b := mustAddBlocker(t, conn, tk.ID, bt)
		if err := SetBlockerResolved(conn, user, b.ID, true); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: %v, want ErrInvalid", bt, err)
		}
	}
	for _, bt := range allowed {
		b := mustAddBlocker(t, conn, tk.ID, bt)
		backdate(t, conn, tk.ID)
		before := updatedAt(t, conn, tk.ID)
		if err := SetBlockerResolved(conn, user, b.ID, true); err != nil {
			t.Fatalf("%+v: %v", bt, err)
		}
		if updatedAt(t, conn, tk.ID) == before {
			t.Errorf("resolve didn't bump updated_at")
		}
		v := mustVersion(t, conn)
		if err := SetBlockerResolved(conn, user, b.ID, true); err != nil {
			t.Fatal(err)
		}
		if mustVersion(t, conn) != v {
			t.Errorf("%+v: re-resolve bumped version", bt)
		}
		var got Blocker
		for _, x := range mustBlockers(t, conn, tk.ID) {
			if x.ID == b.ID {
				got = x
			}
		}
		if got.ResolvedAt == "" || got.ResolvedAuto || got.ResolvedReason != "" {
			t.Errorf("resolved %+v", got)
		}
		if err := SetBlockerResolved(conn, user, b.ID, false); err != nil {
			t.Fatal(err)
		}
	}
	res := eventsOfType(t, conn, tk.ID, EventTaskBlockerResolved)
	unres := eventsOfType(t, conn, tk.ID, EventTaskBlockerUnresolved)
	if len(res) != 3 || len(unres) != 3 {
		t.Fatalf("events resolved %d unresolved %d", len(res), len(unres))
	}
	p := payloadOf(t, res[0])
	if p["auto"] != false || p["reason"] != "" || p["label"] != "link:https://x" || p["kind"] != "resource" {
		t.Errorf("resolved payload %v", p)
	}
	if p := payloadOf(t, unres[0]); p["label"] != "link:https://x" || p["blocker_id"] == nil {
		t.Errorf("unresolved payload %v", p)
	}
	if err := SetBlockerResolved(conn, user, 9999, true); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing blocker: %v", err)
	}
}

func TestBlockersOrderUnresolvedFirst(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	b1 := mustAddBlocker(t, conn, tk.ID, otherTarget("one"))
	b2 := mustAddBlocker(t, conn, tk.ID, otherTarget("two"))
	b3 := mustAddBlocker(t, conn, tk.ID, otherTarget("three"))
	if err := SetBlockerResolved(conn, user, b1.ID, true); err != nil {
		t.Fatal(err)
	}
	bs := mustBlockers(t, conn, tk.ID)
	got := []int64{bs[0].ID, bs[1].ID, bs[2].ID}
	if !equalIDs(got, []int64{b2.ID, b3.ID, b1.ID}) {
		t.Fatalf("order %v", got)
	}
}

func TestBlockedAndBlockerCountOnGetAndList(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	free := mustCreate(t, conn, "free")
	b1 := mustAddBlocker(t, conn, tk.ID, otherTarget("one"))
	mustAddBlocker(t, conn, tk.ID, resTarget("pr", "o/r#1"))
	got := mustGet(t, conn, tk.ID)
	if !got.Blocked || got.BlockerCount != 2 {
		t.Fatalf("get %v %d", got.Blocked, got.BlockerCount)
	}
	if err := SetBlockerResolved(conn, user, b1.ID, true); err != nil {
		t.Fatal(err)
	}
	for _, x := range mustList(t, conn, Filter{}) {
		switch x.ID {
		case tk.ID:
			if !x.Blocked || x.BlockerCount != 1 {
				t.Errorf("list blocked %v %d", x.Blocked, x.BlockerCount)
			}
		case free.ID:
			if x.Blocked || x.BlockerCount != 0 {
				t.Errorf("free %v %d", x.Blocked, x.BlockerCount)
			}
		}
	}
}

func TestBlockingAndResourceBlockCounts(t *testing.T) {
	conn := newDB(t)
	dep := mustCreate(t, conn, "dep")
	a := mustCreate(t, conn, "a")
	b := mustCreate(t, conn, "b")
	gone := mustCreate(t, conn, "gone")
	done := mustCreate(t, conn, "done")
	mustAddBlocker(t, conn, a.ID, taskTarget(dep.ID))
	mustAddBlocker(t, conn, b.ID, taskTarget(dep.ID))
	mustAddBlocker(t, conn, gone.ID, taskTarget(dep.ID))
	for _, id := range []int64{a.ID, b.ID, gone.ID, done.ID} {
		mustAddBlocker(t, conn, id, resTarget("pr", "o/r#1"))
	}
	mustAddBlocker(t, conn, a.ID, resTarget("jira", "ABC-1"))
	sl := mustAddBlocker(t, conn, a.ID, resTarget("slack", "C1:1.2"))
	if err := SetBlockerResolved(conn, user, sl.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := Delete(conn, user, gone.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := SetState(conn, user, done.ID, StateDone); err != nil {
		t.Fatal(err)
	}

	blocking, err := Blocking(conn, dep.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !equalIDs(blocking, []int64{a.ID, b.ID}) {
		t.Errorf("blocking %v", blocking)
	}
	counts, err := ResourceBlockCounts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 2 || counts["pr:o/r#1"] != 2 || counts["jira:ABC-1"] != 1 {
		t.Errorf("counts %v", counts)
	}
	// A deleted task's blockers are excluded everywhere.
	if _, err := Blockers(conn, gone.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleted task's blockers: %v", err)
	}
}

// The blocked and the blocking task ids both survive JSON encoding (an
// embedded field named like an outer one would be silently dropped).
func TestBlockerJSONHasBothTaskIDs(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "blocked")
	dep := mustCreate(t, conn, "dep")
	b := mustAddBlocker(t, conn, tk.ID, taskTarget(dep.ID))
	if b.TaskID != tk.ID || b.BlockingTaskID != dep.ID {
		t.Fatalf("ids %+v", b)
	}
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["TaskID"] != float64(tk.ID) || m["BlockingTaskID"] != float64(dep.ID) {
		t.Fatalf("json %s", raw)
	}
}

func TestSystemActorCountsAsUnread(t *testing.T) {
	if !CountsAsUnread(ActorSystem) {
		t.Fatal("system events must count as unread")
	}
}

func TestUnresolvedBlockersByTask(t *testing.T) {
	conn := newDB(t)
	dep := mustCreate(t, conn, "dep")
	a := mustCreate(t, conn, "a")
	gone := mustCreate(t, conn, "gone")
	mustAddBlocker(t, conn, a.ID, taskTarget(dep.ID))
	mustAddBlocker(t, conn, a.ID, otherTarget("wait"))
	done := mustAddBlocker(t, conn, a.ID, otherTarget("finished"))
	if err := SetBlockerResolved(conn, user, done.ID, true); err != nil {
		t.Fatal(err)
	}
	mustAddBlocker(t, conn, gone.ID, otherTarget("x"))
	if _, err := Delete(conn, user, gone.ID); err != nil {
		t.Fatal(err)
	}
	m, err := UnresolvedBlockers(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 1 || len(m[a.ID]) != 2 || m[a.ID][0].BlockingTaskID != dep.ID || m[a.ID][1].Text != "wait" {
		t.Fatalf("unresolved = %+v", m)
	}
}

func TestBlockerTaskID(t *testing.T) {
	conn := newDB(t)
	a := mustCreate(t, conn, "a")
	b := mustAddBlocker(t, conn, a.ID, otherTarget("x"))
	if id, err := BlockerTaskID(conn, b.ID); err != nil || id != a.ID {
		t.Fatalf("BlockerTaskID = %d, %v", id, err)
	}
	if _, err := BlockerTaskID(conn, 999); !errors.Is(err, ErrBlockerNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, err := Delete(conn, user, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := BlockerTaskID(conn, b.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted task: %v", err)
	}
}

func TestHeadsIncludeDeletedTasks(t *testing.T) {
	conn := newDB(t)
	a := mustCreate(t, conn, "a")
	b := mustCreate(t, conn, "b")
	if _, err := SetState(conn, user, a.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	if _, err := Delete(conn, user, b.ID); err != nil {
		t.Fatal(err)
	}
	h, err := Heads(conn, []int64{a.ID, b.ID, 99})
	if err != nil {
		t.Fatal(err)
	}
	if len(h) != 2 || h[a.ID] != (Head{Title: "a", State: StateDone}) || !h[b.ID].Deleted || h[b.ID].Title != "b" {
		t.Fatalf("heads = %+v", h)
	}
	if h, err := Heads(conn, nil); err != nil || len(h) != 0 {
		t.Fatalf("empty heads = %+v, %v", h, err)
	}
}

func TestManuallyResolvableExported(t *testing.T) {
	for _, c := range []struct {
		bt   BlockerTarget
		want bool
	}{
		{otherTarget("x"), true},
		{resTarget("slack", "C:1"), true},
		{resTarget("link", "https://x"), true},
		{resTarget("pr", "o/r#1"), false},
		{resTarget("jira", "X-1"), false},
		{taskTarget(1), false},
	} {
		if got := ManuallyResolvable(c.bt); got != c.want {
			t.Errorf("ManuallyResolvable(%+v) = %v", c.bt, got)
		}
	}
}

func TestDoneTaskIsNeverBlocked(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")
	mustAddBlocker(t, conn, tk.ID, otherTarget("waiting"))
	if _, err := SetState(conn, user, tk.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, conn, tk.ID)
	if got.Blocked || got.BlockerCount != 0 {
		t.Fatalf("done task: blocked %v count %d, want false 0", got.Blocked, got.BlockerCount)
	}
	for _, x := range mustList(t, conn, Filter{IncludeCompleted: true}) {
		if x.ID == tk.ID && (x.Blocked || x.BlockerCount != 0) {
			t.Fatalf("done task in list: blocked %v count %d", x.Blocked, x.BlockerCount)
		}
	}
	if _, err := SetState(conn, user, tk.ID, StateInProgress); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, conn, tk.ID); !got.Blocked || got.BlockerCount != 1 {
		t.Fatalf("reopened: blocked %v count %d, want true 1", got.Blocked, got.BlockerCount)
	}
}
