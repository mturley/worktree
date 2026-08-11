package resources

import (
	"database/sql"
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

func TestAddAndLoad(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	if err := Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "http://x/1"}); err != nil {
		t.Fatal(err)
	}
	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].ID != "o/r#1" || res[0].Related {
		t.Fatalf("got %+v", res)
	}
}

func TestSecondPrimaryDemotesFirst(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#2", URL: "u2"}) // new primary
	res, _ := Load(conn, wt)
	primaries := 0
	for _, r := range res {
		if !r.Related {
			primaries++
		}
	}
	if primaries != 1 {
		t.Fatalf("expected exactly 1 primary pr, got %d in %+v", primaries, res)
	}
	if p := PrimaryOfType(res, "pr"); p == nil || p.ID != "o/r#2" {
		t.Fatalf("expected #2 primary, got %+v", p)
	}
}

func TestUnwatchThenLoadExcludes(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "jira", ID: "RH-1", URL: "u"})
	if err := Unwatch(conn, wt, "jira", "RH-1"); err != nil {
		t.Fatal(err)
	}
	res, _ := Load(conn, wt)
	if len(res) != 0 {
		t.Fatalf("unwatched resource should not appear in Load: %+v", res)
	}
}

func TestAddRevivesUserUnwatched(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "jira", ID: "RH-1", URL: "u"})
	Unwatch(conn, wt, "jira", "RH-1")
	if err := Add(conn, wt, Resource{Type: "jira", ID: "RH-1", URL: "u2"}); err != nil {
		t.Fatal(err)
	}
	res, _ := Load(conn, wt)
	if len(res) != 1 || res[0].URL != "u2" {
		t.Fatalf("explicit Add must revive a user-unwatched resource: %+v", res)
	}
}

func TestRemoveIsHard(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u"})
	if err := Remove(conn, wt, "pr", "o/r#1"); err != nil {
		t.Fatal(err)
	}
	res, _ := Load(conn, wt)
	if len(res) != 0 {
		t.Fatalf("removed resource should be gone: %+v", res)
	}
}
