package resources

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

// The fake worktree paths throughout these tests are not real git worktrees,
// so the predicate defaults to permissive here; the tests that care about the
// guard stub it themselves.
func TestMain(m *testing.M) {
	isWorktree = func(p string) (string, bool) { return p, true }
	os.Exit(m.Run())
}

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

func TestAddRejectsEmptyIDAndType(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"

	if err := Add(conn, wt, Resource{Type: "slack", ID: ""}); err == nil {
		t.Fatal("expected error for empty ID, got nil")
	}
	if err := Add(conn, wt, Resource{Type: "slack", ID: "   "}); err == nil {
		t.Fatal("expected error for whitespace-only ID, got nil")
	}
	if err := Add(conn, wt, Resource{Type: "", ID: "C1:1.2"}); err == nil {
		t.Fatal("expected error for empty type, got nil")
	}

	// Nothing should have been written for the rejected adds.
	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 0 {
		t.Fatalf("expected no resources after rejected adds, got %+v", res)
	}
}

func TestMultiplePrimariesPerType(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/a"
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u1"}) // primary
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#2", URL: "u2"}) // ALSO primary (no demote)
	res, _ := Load(conn, wt)
	prims := PrimariesOfType(res, "pr")
	if len(prims) != 2 {
		t.Fatalf("expected 2 primary PRs, got %d: %+v", len(prims), res)
	}
	// a related one is excluded
	Add(conn, wt, Resource{Type: "pr", ID: "o/r#3", URL: "u3", Related: true})
	res, _ = Load(conn, wt)
	if got := len(PrimariesOfType(res, "pr")); got != 2 {
		t.Fatalf("related resource must not count as primary; got %d primaries", got)
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

func TestSetMetaAndLoadDecorates(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt-meta-test"

	if err := Add(conn, wt, Resource{Type: "slack", ID: "C1:1700000000.000100", URL: "https://x"}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := SetMeta(conn, "slack", "C1:1700000000.000100", "Release blocker", "e2e regression"); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}
	rs, err := Load(conn, wt)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(rs) != 1 {
		t.Fatalf("expected 1 resource, got %d", len(rs))
	}
	if rs[0].CustomName != "Release blocker" || rs[0].CustomDescription != "e2e regression" {
		t.Fatalf("Load did not decorate custom meta: %+v", rs[0])
	}
}

func TestLoadNoMetaLeavesEmpty(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt-meta-test2"
	if err := Add(conn, wt, Resource{Type: "slack", ID: "C2:1700000000.000200", URL: "https://y"}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	rs, _ := Load(conn, wt)
	if rs[0].CustomName != "" || rs[0].CustomDescription != "" {
		t.Fatalf("expected empty custom meta, got %+v", rs[0])
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

func TestSetMetaAtPreservesTimestampThroughLoad(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/meta"
	if err := Add(conn, wt, Resource{Type: "slack", ID: "C1:1.2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	const ts = "2030-05-06T07:08:09Z"
	if err := SetMetaAt(conn, "slack", "C1:1.2", "Custom", "Desc", ts); err != nil {
		t.Fatal(err)
	}
	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 {
		t.Fatalf("got %d resources", len(res))
	}
	if res[0].CustomName != "Custom" || res[0].CustomDescription != "Desc" || res[0].UpdatedAt != ts {
		t.Fatalf("meta not preserved: %+v", res[0])
	}
}

func TestSetMetaAtEmptyTimestampStampsNow(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/meta2"
	if err := Add(conn, wt, Resource{Type: "slack", ID: "C2:2.2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	if err := SetMetaAt(conn, "slack", "C2:2.2", "N", "", ""); err != nil {
		t.Fatal(err)
	}
	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	if res[0].UpdatedAt == "" {
		t.Fatal("empty --updated-at should stamp a non-empty timestamp")
	}
}

// TestSetPrimaryFlipsBothWays pins Phase E's backend: the related flag could
// only be set at creation, so a resource added as Related could never be
// promoted to Focus (or demoted) without removing and re-adding it.
func TestSetPrimaryFlipsBothWays(t *testing.T) {
	conn := testDB(t)
	wt := t.TempDir()
	if err := Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u", Related: true}); err != nil {
		t.Fatal(err)
	}

	primaryOf := func() bool {
		t.Helper()
		rs, err := Load(conn, wt)
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range rs {
			if r.ID == "o/r#1" {
				return !r.Related
			}
		}
		t.Fatal("resource missing")
		return false
	}

	if primaryOf() {
		t.Fatal("added as related, should not be primary")
	}
	if err := SetPrimary(conn, wt, "pr", "o/r#1", true); err != nil {
		t.Fatalf("promote: %v", err)
	}
	if !primaryOf() {
		t.Error("expected primary after promoting")
	}
	if err := SetPrimary(conn, wt, "pr", "o/r#1", false); err != nil {
		t.Fatalf("demote: %v", err)
	}
	if primaryOf() {
		t.Error("expected related after demoting")
	}
}

// TestSetPrimaryUnknownResource ensures flipping a resource this worktree
// does not track is an error rather than a silent no-op that looks like it
// worked in the UI.
func TestSetPrimaryUnknownResource(t *testing.T) {
	conn := testDB(t)
	wt := t.TempDir()
	if err := SetPrimary(conn, wt, "pr", "nope#1", true); err == nil {
		t.Fatal("expected an error for an untracked resource")
	}
}

// stubIsWorktree replaces the worktree predicate for one test. The package
// default is permissive under TestMain so the fake paths the rest of these
// tests use keep working; tests that care set their own.
func stubIsWorktree(t *testing.T, fn func(string) (string, bool)) {
	t.Helper()
	prev := isWorktree
	isWorktree = fn
	t.Cleanup(func() { isWorktree = prev })
}

func TestAddRejectsNonWorktreePath(t *testing.T) {
	conn := testDB(t)
	stubIsWorktree(t, func(string) (string, bool) { return "", false })

	wt := "/Users/me/git/some-repo"
	err := Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u"})
	if err == nil {
		t.Fatal("expected Add to reject a path that is not a git worktree")
	}
	if !strings.Contains(err.Error(), "not a git worktree") {
		t.Fatalf("error should say why it was rejected, got: %v", err)
	}

	// Nothing written: no subscription and no primary-flag row.
	sub := wdb.Subscriber(wt)
	var subs, prims int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM watcher_subscriptions WHERE subscriber = ?`, sub).Scan(&subs); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(`SELECT COUNT(*) FROM worktree_primary WHERE subscriber = ?`, sub).Scan(&prims); err != nil {
		t.Fatal(err)
	}
	if subs != 0 || prims != 0 {
		t.Fatalf("rejected Add wrote rows: %d subscriptions, %d primary", subs, prims)
	}
}

func TestRemoveStillWorksOnNonWorktreePath(t *testing.T) {
	conn := testDB(t)
	wt := "/Users/me/git/some-repo"
	if err := Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	// The path stops being a worktree (deleted, or never was one).
	stubIsWorktree(t, func(string) (string, bool) { return "", false })
	if err := Remove(conn, wt, "pr", "o/r#1"); err != nil {
		t.Fatalf("Remove must keep working so stale rows can be cleaned up: %v", err)
	}
}
