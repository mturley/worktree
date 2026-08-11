package registry

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

func TestRegisterListGet(t *testing.T) {
	conn := testDB(t)
	e := Entry{Path: "/wt/a", Repo: "repo", RepoRoot: "/repo", Branch: "b", CreatedAt: "2026-08-11T00:00:00Z"}
	if err := Register(conn, e); err != nil {
		t.Fatal(err)
	}
	list, _ := List(conn)
	if len(list) != 1 || list[0].Path != "/wt/a" {
		t.Fatalf("list: %+v", list)
	}
	got, _ := Get(conn, "/wt/a")
	if got == nil || got.Branch != "b" {
		t.Fatalf("get: %+v", got)
	}
	if missing, _ := Get(conn, "/nope"); missing != nil {
		t.Fatalf("expected nil for missing path")
	}
}

func TestRegisterUpsert(t *testing.T) {
	conn := testDB(t)
	Register(conn, Entry{Path: "/wt/a", Repo: "r", RepoRoot: "/r", Branch: "b1", CreatedAt: "t"})
	Register(conn, Entry{Path: "/wt/a", Repo: "r", RepoRoot: "/r", Branch: "b2", CreatedAt: "t"})
	list, _ := List(conn)
	if len(list) != 1 || list[0].Branch != "b2" {
		t.Fatalf("expected upsert to one row w/ branch b2: %+v", list)
	}
}

func TestReconcileFindsStaleAndOrphans(t *testing.T) {
	conn := testDB(t)
	base := t.TempDir()

	// on-disk worktree dir NOT in DB -> orphan
	orphan := filepath.Join(base, "orphan")
	os.MkdirAll(orphan, 0o755)

	// DB row whose dir is gone -> stale
	Register(conn, Entry{Path: filepath.Join(base, "gone"), Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: "t"})

	// DB row that exists -> neither
	live := filepath.Join(base, "live")
	os.MkdirAll(live, 0o755)
	Register(conn, Entry{Path: live, Repo: "r", RepoRoot: "/r", Branch: "b", CreatedAt: "t"})

	res, err := Reconcile(conn, base)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Orphans) != 1 || res.Orphans[0] != orphan {
		t.Fatalf("orphans: %+v", res.Orphans)
	}
	if len(res.Stale) != 1 || res.Stale[0] != filepath.Join(base, "gone") {
		t.Fatalf("stale: %+v", res.Stale)
	}
}
