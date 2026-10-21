package tasks

import "testing"

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
