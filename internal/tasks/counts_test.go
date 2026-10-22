package tasks

import (
	"fmt"
	"sort"
	"testing"
)

func TestOpenCounts(t *testing.T) {
	conn := newDB(t)
	x := mkWorktree(t, conn, "x")
	subscribe(t, conn, x, prLink)
	wtX := LinkTarget{Kind: LinkWorktree, Worktree: x}
	if _, err := Create(conn, user, NewTask{Title: "a", Focus: []LinkTarget{prLink}}); err != nil {
		t.Fatal(err)
	}
	if _, err := Create(conn, user, NewTask{Title: "b", Focus: []LinkTarget{wtX}}); err != nil {
		t.Fatal(err)
	}
	c, err := Create(conn, user, NewTask{Title: "c", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := SetState(conn, user, c.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	mustCreate(t, conn, "d")

	got, err := OpenCounts(conn)
	if err != nil {
		t.Fatal(err)
	}
	key := prLink.ResourceType + ":" + prLink.ResourceID
	if got.ByWorktree[canon(x)] != 2 || got.ByResource[key] != 1 || got.Total != 3 {
		t.Fatalf("counts = %+v", got)
	}
	if len(got.ByWorktree) != 1 || len(got.ByResource) != 1 {
		t.Fatalf("unexpected keys: %+v", got)
	}
	// The worktree count agrees with List over the same scope.
	if n := len(mustList(t, conn, wtScope(x))); n != got.ByWorktree[canon(x)] {
		t.Fatalf("ByWorktree %d != List %d", got.ByWorktree[canon(x)], n)
	}
}

func TestOpenCountsArchivedFallback(t *testing.T) {
	conn := newDB(t)
	x := mkWorktree(t, conn, "x")
	subscribe(t, conn, x, prLink)
	if _, err := Create(conn, user, NewTask{Title: "a", Focus: []LinkTarget{prLink}}); err != nil {
		t.Fatal(err)
	}
	// x stops following the PR: the task is archived and falls back to x.
	unsubscribe(t, conn, x, prLink)
	got, err := OpenCounts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got.ByWorktree[canon(x)] != 1 || got.Total != 1 {
		t.Fatalf("counts = %+v", got)
	}
}

// BuildScopeIndex agrees with ScopeTaskIDs for every worktree, in one load.
func TestScopeIndexMatchesScopeTaskIDs(t *testing.T) {
	conn := newDB(t)
	x := mkWorktree(t, conn, "x")
	y := mkWorktree(t, conn, "y")
	z := mkWorktree(t, conn, "z")
	subscribe(t, conn, x, prLink)
	wtX := LinkTarget{Kind: LinkWorktree, Worktree: x}
	a, err := Create(conn, user, NewTask{Title: "a", Focus: []LinkTarget{prLink, wtX}})
	if err != nil {
		t.Fatal(err)
	}
	// Done tasks are in the index too: it is feed membership, not open counts.
	c, err := Create(conn, user, NewTask{Title: "c", Focus: []LinkTarget{prLink}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := SetState(conn, user, c.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	// Archived fallback: z followed pr2 and stopped.
	pr2 := LinkTarget{Kind: LinkResource, ResourceType: "pr", ResourceID: "o/r#99"}
	subscribe(t, conn, z, pr2)
	e, err := Create(conn, user, NewTask{Title: "e", Focus: []LinkTarget{pr2}})
	if err != nil {
		t.Fatal(err)
	}
	unsubscribe(t, conn, z, pr2)
	mustCreate(t, conn, "global")
	d := mustCreate(t, conn, "deleted")
	if _, err := Delete(conn, user, d.ID); err != nil {
		t.Fatal(err)
	}

	ix, err := BuildScopeIndex(conn)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{x, y, z} {
		want, err := ScopeTaskIDs(conn, Scope{Kind: ScopeWorktree, Worktree: p})
		if err != nil {
			t.Fatal(err)
		}
		got := ix.ByWorktree[canon(p)]
		if fmt.Sprint(sortedIDs(got)) != fmt.Sprint(sortedIDs(want)) {
			t.Fatalf("worktree %s: index %v, ScopeTaskIDs %v", p, got, want)
		}
	}
	// Linked twice (PR and worktree) but listed once.
	if got := sortedIDs(ix.ByWorktree[canon(x)]); fmt.Sprint(got) != fmt.Sprint([]int64{a.ID, c.ID}) {
		t.Fatalf("x = %v", got)
	}
	if got := ix.ByWorktree[canon(z)]; fmt.Sprint(got) != fmt.Sprint([]int64{e.ID}) {
		t.Fatalf("z = %v", got)
	}
	key := prLink.ResourceType + ":" + prLink.ResourceID
	if got := sortedIDs(ix.ByResource[key]); fmt.Sprint(got) != fmt.Sprint([]int64{a.ID, c.ID}) {
		t.Fatalf("resource = %v", got)
	}
}

func sortedIDs(ids []int64) []int64 {
	out := append([]int64(nil), ids...)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
