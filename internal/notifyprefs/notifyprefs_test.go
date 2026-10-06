package notifyprefs

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestGetOnNothingIsAllOff(t *testing.T) {
	conn := testDB(t)
	p, err := Get(conn, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if p.All || len(p.Resources) != 0 || p.Notifies(Key{"pr", "o/r#1"}) {
		t.Fatalf("got %+v, want everything off", p)
	}
}

func TestWorktreeWideAndPerResourceAreIndependent(t *testing.T) {
	conn := testDB(t)
	wt := t.TempDir()
	k := Key{"pr", "o/r#1"}
	if err := SetResource(conn, wt, k.Type, k.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := SetAll(conn, wt, true); err != nil {
		t.Fatal(err)
	}
	if err := SetAll(conn, wt, false); err != nil {
		t.Fatal(err)
	}
	p, _ := Get(conn, wt)
	if p.All {
		t.Fatal("All still on after SetAll(false)")
	}
	if !p.Resources[k] {
		t.Fatal("turning the worktree-wide toggle off must keep the per-resource choice")
	}
}

func TestNotifiesIsEffectiveState(t *testing.T) {
	p := Prefs{All: true}
	if !p.Notifies(Key{"jira", "X-1"}) {
		t.Fatal("All must cover every resource")
	}
	p = Prefs{Resources: map[Key]bool{{"jira", "X-1"}: true}}
	if !p.Notifies(Key{"jira", "X-1"}) || p.Notifies(Key{"jira", "X-2"}) {
		t.Fatalf("per-resource match wrong: %+v", p)
	}
}

func TestSetIsIdempotentAndOffDeletes(t *testing.T) {
	conn := testDB(t)
	wt := t.TempDir()
	for i := 0; i < 2; i++ {
		if err := SetResource(conn, wt, "pr", "o/r#1", true); err != nil {
			t.Fatalf("second enable must not fail: %v", err)
		}
	}
	if err := SetResource(conn, wt, "pr", "o/r#1", false); err != nil {
		t.Fatal(err)
	}
	var n int
	conn.QueryRow(`SELECT COUNT(*) FROM worktree_notify`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d rows left after turning off", n)
	}
}

func TestSetResourceRejectsEmptyKey(t *testing.T) {
	conn := testDB(t)
	if err := SetResource(conn, t.TempDir(), "", "", true); err == nil {
		t.Fatal("an empty type/id would collide with the worktree-wide row")
	}
}

func TestSymlinkedPathIsTheSameWorktree(t *testing.T) {
	conn := testDB(t)
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if err := SetAll(conn, link, true); err != nil {
		t.Fatal(err)
	}
	p, _ := Get(conn, real)
	if !p.All {
		t.Fatal("rows must be keyed by wdb.Subscriber, which resolves symlinks")
	}
}

func TestListAllAndRemove(t *testing.T) {
	conn := testDB(t)
	a, b := t.TempDir(), t.TempDir()
	SetAll(conn, a, true)
	SetResource(conn, b, "pr", "o/r#1", true)
	SetResource(conn, b, "pr", "o/r#2", true)

	all, err := ListAll(conn)
	if err != nil {
		t.Fatal(err)
	}
	if !all[wdb.Subscriber(a)].All || len(all[wdb.Subscriber(b)].Resources) != 2 {
		t.Fatalf("ListAll = %+v", all)
	}

	if err := RemoveResource(conn, b, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	if err := RemoveAll(conn, a); err != nil {
		t.Fatal(err)
	}
	all, _ = ListAll(conn)
	if _, ok := all[wdb.Subscriber(a)]; ok {
		t.Fatal("RemoveAll left rows for a")
	}
	if got := all[wdb.Subscriber(b)].Resources; len(got) != 1 || !got[Key{"pr", "o/r#2"}] {
		t.Fatalf("b after RemoveResource = %+v", got)
	}
}
