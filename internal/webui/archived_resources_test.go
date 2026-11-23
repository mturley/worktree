package webui

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	watcher "github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/testgit"
)

func archivedFixture(t *testing.T, n int) (*sql.DB, []string) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	var paths []string
	for i := 0; i < n; i++ {
		p := testgit.Worktree(t)
		must(t, registry.Register(conn, registry.Entry{Path: p, Repo: "r", RepoRoot: p, Branch: filepath.Base(p), CreatedAt: "now"}))
		paths = append(paths, p)
	}
	return conn, paths
}

func TestArchivedResourcesListsUnfollowed(t *testing.T) {
	t.Parallel()
	conn, ps := archivedFixture(t, 1)
	a := ps[0]
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#1", `{"title":"Cached","state":"OPEN"}`, "2026-02-01T00:00:00Z", "x"))
	must(t, resources.Remove(conn, a, "pr", "o/r#1"))

	got, err := (&Server{DB: conn}).ArchivedResources()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 archived, got %+v", got)
	}
	r := got[0]
	if !r.Archived || len(r.Worktrees) != 0 || len(r.LastFollowedBy) != 1 || r.LastFollowedBy[0].Path != a {
		t.Errorf("archived dto = %+v", r)
	}
	if r.LastFollowedBy[0].Repo != "r" {
		t.Errorf("registered worktree should carry its repo: %+v", r.LastFollowedBy)
	}
	if r.Title != "Cached" {
		t.Errorf("title not enriched: %q", r.Title)
	}
}

func TestArchivedResourcesExcludesStillFollowed(t *testing.T) {
	t.Parallel()
	conn, ps := archivedFixture(t, 2)
	a, b := ps[0], ps[1]
	// Followed by both, removed from a only: still followed.
	must(t, resources.Add(conn, a, resources.Resource{Type: "slack", ID: "C1:1.1", URL: "s"}))
	must(t, resources.Add(conn, b, resources.Resource{Type: "slack", ID: "C1:1.1", URL: "s"}))
	must(t, resources.Remove(conn, a, "slack", "C1:1.1"))
	// Removed then re-added in a: followed again.
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2"}))
	must(t, resources.Remove(conn, a, "pr", "o/r#2"))
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2"}))
	// Removed from a, then only a task hold subscribes: archived.
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#3", URL: "u3"}))
	must(t, resources.Remove(conn, a, "pr", "o/r#3"))
	must(t, watcherdb.Subscribe(conn, tasks.HoldSubscriber(1), watcher.Resource{Type: "pr", ID: "o/r#3", URL: "u3"}, watcherdb.SubscribeOpts{}))

	got, err := (&Server{DB: conn}).ArchivedResources()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "o/r#3" {
		t.Fatalf("want only o/r#3 archived, got %+v", got)
	}
}

func TestAllResourcesEndpointArchivedParam(t *testing.T) {
	t.Parallel()
	conn, ps := archivedFixture(t, 1)
	a := ps[0]
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2"}))
	must(t, resources.Remove(conn, a, "pr", "o/r#2"))

	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()
	fetch := func(q string) []map[string]any {
		resp, err := http.Get(ts.URL + "/api/all-resources" + q)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out []map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	plain := fetch("")
	if len(plain) != 1 || plain[0]["id"] != "o/r#1" || plain[0]["archived"] != nil {
		t.Fatalf("plain = %+v", plain)
	}
	with := fetch("?archived=true")
	if len(with) != 2 || with[1]["id"] != "o/r#2" || with[1]["archived"] != true {
		t.Fatalf("archived = %+v", with)
	}
}

func TestArchivedResourcesTwoFollowersNewestFirst(t *testing.T) {
	t.Parallel()
	conn, ps := archivedFixture(t, 2)
	a, b := ps[0], ps[1]
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, resources.Add(conn, b, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, resources.Remove(conn, a, "pr", "o/r#1"))
	must(t, resources.Remove(conn, b, "pr", "o/r#1"))
	// Pin the tombstone times so the order does not depend on the clock.
	for sub, ts := range map[string]string{wdb.Subscriber(a): "2026-01-01T00:00:00Z", wdb.Subscriber(b): "2026-02-01T00:00:00Z"} {
		if _, err := conn.Exec(`UPDATE watcher_subscriptions SET deleted_at = ? WHERE subscriber = ?`, ts, sub); err != nil {
			t.Fatal(err)
		}
	}
	got, err := (&Server{DB: conn}).ArchivedResources()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].LastFollowedBy) != 2 {
		t.Fatalf("want one resource with two last followers, got %+v", got)
	}
	if got[0].LastFollowedBy[0].Path != b || got[0].LastFollowedBy[1].Path != a {
		t.Errorf("newest tombstone first: %+v", got[0].LastFollowedBy)
	}
}

func TestArchivedResourcesUnregisteredFollowerIsPathOnly(t *testing.T) {
	t.Parallel()
	conn, ps := archivedFixture(t, 1)
	a := ps[0]
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, resources.Remove(conn, a, "pr", "o/r#1"))
	must(t, registry.Unregister(conn, a))
	got, err := (&Server{DB: conn}).ArchivedResources()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].LastFollowedBy) != 1 {
		t.Fatalf("got %+v", got)
	}
	// The subscriber holds the canonical (symlink-resolved) path.
	want, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(a))
	if lf := got[0].LastFollowedBy[0]; lf.Path != want || lf.Repo != "" || lf.Branch != "" {
		t.Errorf("want path only, got %+v", lf)
	}
}

func TestArchivedResourcesReleasedHoldDoesNotCount(t *testing.T) {
	t.Parallel()
	conn, ps := archivedFixture(t, 1)
	a := ps[0]
	hold := tasks.HoldSubscriber(1)
	res := watcher.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}
	// Only ever held by a task, then released: never followed by a worktree.
	must(t, watcherdb.Subscribe(conn, hold, res, watcherdb.SubscribeOpts{}))
	must(t, watcherdb.Unsubscribe(conn, hold, res))
	// Followed by a worktree, removed, held by a task, hold released.
	must(t, resources.Add(conn, a, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2"}))
	must(t, resources.Remove(conn, a, "pr", "o/r#2"))
	res2 := watcher.Resource{Type: "pr", ID: "o/r#2", URL: "u2"}
	must(t, watcherdb.Subscribe(conn, hold, res2, watcherdb.SubscribeOpts{}))
	must(t, watcherdb.Unsubscribe(conn, hold, res2))

	got, err := (&Server{DB: conn}).ArchivedResources()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "o/r#2" {
		t.Fatalf("want only o/r#2, got %+v", got)
	}
	if len(got[0].LastFollowedBy) != 1 || got[0].LastFollowedBy[0].Path != a {
		t.Errorf("a released hold is not a last follower: %+v", got[0].LastFollowedBy)
	}
}
