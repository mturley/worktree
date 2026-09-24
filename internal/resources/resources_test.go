package resources

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/unread"
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

func TestAddSeedsAReadCursorSoNewResourcesStartSilent(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/seed-cursor"

	// An event already exists for this resource before anyone tracks it.
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES ('e1', '2026-01-01T00:00:00Z', 'github', 'pr_comment', 'x')`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES ('e1', 'pr', 'o/r#1')`); err != nil {
		t.Fatal(err)
	}

	if err := Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	// Assert the cursor was CREATED, not merely that the count is zero: with
	// no cursor row at all the count is also zero, so a count-only assertion
	// would pass against an unimplemented Add.
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := cursors[unread.Key("pr", "o/r#1")]
	if !ok {
		t.Fatal("Add must seed a read cursor for the resource")
	}
	if got < "2026-01-01T00:00:00Z" {
		t.Fatalf("cursor = %q, want it at or after the existing event so the backlog reads as seen", got)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 0 {
		t.Fatalf("unread = %d, want 0 — tracking a resource must not announce its backlog", n)
	}
}

func TestAddDoesNotSeedACursorForSlack(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/seed-cursor-slack"

	if err := Add(conn, wt, Resource{Type: "slack", ID: "C1:1.2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cursors[unread.Key("slack", "C1:1.2")]; ok {
		t.Fatal("a slack thread must never get a cursor row")
	}
}

// ids renders the loaded resources as "type:id" strings, in order, for
// readable ordering assertions.
func ids(rs []Resource) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.Type+":"+r.ID)
	}
	return out
}

func setRank(t *testing.T, conn *sql.DB, wt, resType, id string, rank int) {
	t.Helper()
	if _, err := conn.Exec(
		`UPDATE worktree_primary SET sort_order = ?
		  WHERE subscriber = ? AND resource_type = ? AND resource_id = ?`,
		rank, wdb.Subscriber(wt), resType, id); err != nil {
		t.Fatal(err)
	}
}

func TestLoadOrdersRankedBeforeUnrankedWithinAGroup(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/order"
	for _, id := range []string{"o/r#1", "o/r#2", "o/r#3"} {
		if err := Add(conn, wt, Resource{Type: "pr", ID: id, URL: "u"}); err != nil {
			t.Fatal(err)
		}
	}
	// #3 first, #1 second, #2 left unranked so it falls to the back.
	setRank(t, conn, wt, "pr", "o/r#3", 1)
	setRank(t, conn, wt, "pr", "o/r#1", 2)

	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(ids(res), ",")
	want := "pr:o/r#3,pr:o/r#1,pr:o/r#2"
	if got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
}

func TestLoadWithoutAnyRanksKeepsSubscriptionOrder(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/unranked"
	for _, id := range []string{"o/r#1", "o/r#2", "o/r#3"} {
		if err := Add(conn, wt, Resource{Type: "pr", ID: id, URL: "u"}); err != nil {
			t.Fatal(err)
		}
	}
	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(ids(res), ",")
	want := "pr:o/r#1,pr:o/r#2,pr:o/r#3"
	if got != want {
		t.Fatalf("order = %s, want %s (ordering must not disturb an untouched list)", got, want)
	}
}

func TestLoadPutsFocusBeforeRelated(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/groups"
	if err := Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u", Related: true}); err != nil {
		t.Fatal(err)
	}
	if err := Add(conn, wt, Resource{Type: "pr", ID: "o/r#2", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	// Ranks are per-group, so the groups have to be kept apart for the
	// numbers to mean anything: focus first, related after.
	got := strings.Join(ids(res), ",")
	want := "pr:o/r#2,pr:o/r#1"
	if got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
}

// addAll follows each id in order, in the given group.
func addAll(t *testing.T, conn *sql.DB, wt string, related bool, ids ...string) {
	t.Helper()
	for _, id := range ids {
		if err := Add(conn, wt, Resource{Type: "pr", ID: id, URL: "u", Related: related}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSetPrimaryMovesFlippedResourceToBottomOfNewGroup(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/flip"
	addAll(t, conn, wt, false, "o/r#1", "o/r#2", "o/r#3") // focus
	addAll(t, conn, wt, true, "o/r#8", "o/r#9")           // related

	// #2 is in the middle of focus; demoting it must land it under #9,
	// not keep its old middle position in the related list.
	if err := SetPrimary(conn, wt, "pr", "o/r#2", false); err != nil {
		t.Fatal(err)
	}

	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(ids(res), ",")
	want := "pr:o/r#1,pr:o/r#3,pr:o/r#8,pr:o/r#9,pr:o/r#2"
	if got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
}

func TestSetPrimaryToSameGroupLeavesOrderAlone(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/noop"
	addAll(t, conn, wt, false, "o/r#1", "o/r#2", "o/r#3")

	// The UI fires this on every toggle with no confirmation, so setting the
	// group a resource is already in must not shuffle it to the bottom.
	if err := SetPrimary(conn, wt, "pr", "o/r#2", true); err != nil {
		t.Fatal(err)
	}

	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(ids(res), ",")
	want := "pr:o/r#1,pr:o/r#2,pr:o/r#3"
	if got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
}

func TestAddReclassifyingATrackedResourceMovesItToBottom(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/readd"
	addAll(t, conn, wt, false, "o/r#1", "o/r#2")
	addAll(t, conn, wt, true, "o/r#8", "o/r#9")

	// Add overwrites is_primary from the caller's flag, so a re-add is a
	// flip too and must not strand #1 mid-list in a group it just joined.
	if err := Add(conn, wt, Resource{Type: "pr", ID: "o/r#1", URL: "u", Related: true}); err != nil {
		t.Fatal(err)
	}

	res, err := Load(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(ids(res), ",")
	want := "pr:o/r#2,pr:o/r#8,pr:o/r#9,pr:o/r#1"
	if got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
}

func keys(ids ...string) []Key {
	out := make([]Key, 0, len(ids))
	for _, id := range ids {
		out = append(out, Key{Type: "pr", ID: id})
	}
	return out
}

func TestSetOrderReordersWithinAGroup(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/setorder"
	addAll(t, conn, wt, false, "o/r#1", "o/r#2", "o/r#3")

	if err := SetOrder(conn, wt, keys("o/r#3", "o/r#1", "o/r#2"), nil); err != nil {
		t.Fatal(err)
	}

	res, _ := Load(conn, wt)
	if got, want := strings.Join(ids(res), ","), "pr:o/r#3,pr:o/r#1,pr:o/r#2"; got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
}

func TestSetOrderCrossGroupDragHonoursTheDropPosition(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/crossgroup"
	addAll(t, conn, wt, false, "o/r#1", "o/r#2")
	addAll(t, conn, wt, true, "o/r#8", "o/r#9")

	// #9 dragged out of related and dropped BETWEEN the two focus cards.
	// Unlike the toggle, a drag says exactly where the card should land.
	if err := SetOrder(conn, wt,
		keys("o/r#1", "o/r#9", "o/r#2"), keys("o/r#8")); err != nil {
		t.Fatal(err)
	}

	res, _ := Load(conn, wt)
	if got, want := strings.Join(ids(res), ","), "pr:o/r#1,pr:o/r#9,pr:o/r#2,pr:o/r#8"; got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
	for _, r := range res {
		if r.ID == "o/r#9" && r.Related {
			t.Fatal("o/r#9 should have been reclassified as focus by the drag")
		}
	}
}

func TestSetOrderAppendsResourcesTheClientDidNotKnowAbout(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/stale"
	addAll(t, conn, wt, false, "o/r#1", "o/r#2")
	addAll(t, conn, wt, true, "o/r#8")

	// A phone that loaded the page before #2 was followed reorders focus
	// without mentioning it. #2 must keep its group and land at its end,
	// not vanish and not be reclassified.
	if err := SetOrder(conn, wt, keys("o/r#1"), keys("o/r#8")); err != nil {
		t.Fatal(err)
	}

	res, _ := Load(conn, wt)
	if got, want := strings.Join(ids(res), ","), "pr:o/r#1,pr:o/r#2,pr:o/r#8"; got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
	for _, r := range res {
		if r.ID == "o/r#2" && r.Related {
			t.Fatal("o/r#2 must keep its group when the client omits it")
		}
	}
}

func TestSetOrderIgnoresKeysThatAreNotTracked(t *testing.T) {
	conn := testDB(t)
	wt := "/tmp/wt/untracked"
	addAll(t, conn, wt, false, "o/r#1", "o/r#2")

	// A stale client may name a resource that has since been removed.
	// Dropping it beats failing the whole reorder over it.
	if err := SetOrder(conn, wt, keys("o/r#2", "o/r#404", "o/r#1"), nil); err != nil {
		t.Fatal(err)
	}

	res, _ := Load(conn, wt)
	if got, want := strings.Join(ids(res), ","), "pr:o/r#2,pr:o/r#1"; got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
}
