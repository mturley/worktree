package resources

import (
	"database/sql"
	"path/filepath"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
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

	// Contrast with TestRemoveIsHard: Unwatch is a *user* tombstone.
	all, err := watcherdb.AllSubscriptions(conn, wdb.Subscriber(wt), false)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range all {
		if s.Resource.Type == "jira" && s.Resource.ID == "RH-1" {
			found = true
			if !s.UnsubscribedByUser {
				t.Fatalf("expected UnsubscribedByUser=true after Unwatch, got %+v", s)
			}
		}
	}
	if !found {
		t.Fatal("expected subscription row to still exist (soft tombstone) after Unwatch")
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

func TestRemoveAllClearsSubscriptionsAndPrimary(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u1"})                 // primary
	Add(conn, wt, Resource{Type: "jira", ID: "RH-1", URL: "u2", Related: true}) // related
	if err := RemoveAll(conn, wt); err != nil {
		t.Fatal(err)
	}
	// Load returns nothing.
	rs, _ := Load(conn, wt)
	if len(rs) != 0 {
		t.Fatalf("expected no active resources after RemoveAll, got %+v", rs)
	}
	// No worktree_primary rows remain for this subscriber.
	sub := wdb.Subscriber(wt)
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM worktree_primary WHERE subscriber = ?`, sub).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("expected 0 worktree_primary rows, got %d", n)
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

	// Load alone can't distinguish a hard Remove from a soft Unwatch (both
	// exclude the resource). Assert the primary row is actually deleted...
	sub := wdb.Subscriber(wt)
	var count int
	if err := conn.QueryRow(
		`SELECT COUNT(*) FROM worktree_primary WHERE subscriber = ? AND resource_type = ? AND resource_id = ?`,
		sub, "pr", "o/r#1").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expected worktree_primary row to be deleted after Remove, found %d", count)
	}

	// ...and that the tombstone is a NON-user tombstone (distinct from Unwatch).
	all, err := watcherdb.AllSubscriptions(conn, sub, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range all {
		if s.Resource.Type == "pr" && s.Resource.ID == "o/r#1" {
			if s.UnsubscribedByUser {
				t.Fatalf("expected UnsubscribedByUser=false after hard Remove, got %+v", s)
			}
			if s.DeletedAt == nil {
				t.Fatalf("expected DeletedAt to be set after hard Remove, got %+v", s)
			}
		}
	}
}
