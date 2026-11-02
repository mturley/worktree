package webui

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

func timelineDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func addWatched(t *testing.T, conn *sql.DB, rid string) string {
	t.Helper()
	p := testgit.Worktree(t)
	if err := registry.Register(conn, registry.Entry{Path: p, Repo: "odh", RepoRoot: "/r", Branch: "b", CreatedAt: "2026-08-13T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, p, resources.Resource{Type: "pr", ID: rid, URL: "u-" + rid}); err != nil {
		t.Fatal(err)
	}
	return p
}

func timelineIDs(evs []TimelineEvent) []string {
	ids := []string{}
	for _, e := range evs {
		ids = append(ids, e.ID)
	}
	return ids
}

func equalIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestTimelineSince(t *testing.T) {
	t.Parallel()
	conn := timelineDB(t)
	p := addWatched(t, conn, "o/r#1")
	t0 := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	ts := func(d time.Duration) string { return t0.Add(d).Format(time.RFC3339) }
	insertEvent(t, conn, "e0", ts(0), "github", "pr_comment", "a", "pr", "o/r#1", "u")
	insertEvent(t, conn, "e1", ts(time.Hour), "github", "pr_comment", "b", "pr", "o/r#1", "u")
	insertEvent(t, conn, "e2", ts(2*time.Hour), "github", "pr_comment", "c", "pr", "o/r#1", "u")
	srv := &Server{DB: conn}
	for name, wt := range map[string]string{"global": "", "worktree": p} {
		got, err := srv.Timeline(TimelineQuery{WorktreePath: wt, Since: ts(time.Hour)})
		if err != nil {
			t.Fatal(err)
		}
		if ids := timelineIDs(got); !equalIDs(ids, []string{"e2", "e1"}) {
			t.Errorf("%s: got %v, want [e2 e1]", name, ids)
		}
	}
}

func TestTimelineWorktreeScope(t *testing.T) {
	t.Parallel()
	conn := timelineDB(t)
	p1 := addWatched(t, conn, "o/r#1")
	addWatched(t, conn, "o/r#2")
	now := time.Now().UTC()
	insertEvent(t, conn, "mine", now.Format(time.RFC3339), "github", "pr_comment", "a", "pr", "o/r#1", "u")
	insertEvent(t, conn, "theirs", now.Format(time.RFC3339), "github", "pr_comment", "b", "pr", "o/r#2", "u")
	srv := &Server{DB: conn}
	got, err := srv.Timeline(TimelineQuery{WorktreePath: p1})
	if err != nil {
		t.Fatal(err)
	}
	if ids := timelineIDs(got); !equalIDs(ids, []string{"mine"}) {
		t.Errorf("got %v, want [mine]", ids)
	}
	all, err := srv.Timeline(TimelineQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Errorf("global got %v, want both", timelineIDs(all))
	}
}

func TestTimelineUnreadOnly(t *testing.T) {
	t.Parallel()
	conn := timelineDB(t)
	p := addWatched(t, conn, "o/r#1")
	t0 := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	insertEvent(t, conn, "old", t0.Format(time.RFC3339), "github", "pr_comment", "a", "pr", "o/r#1", "u")
	insertEvent(t, conn, "new", t0.Add(time.Hour).Format(time.RFC3339), "github", "pr_comment", "b", "pr", "o/r#1", "u")
	if _, err := conn.Exec(`UPDATE resource_read_cursor SET last_read_ts = ? WHERE resource_type = 'pr' AND resource_id = 'o/r#1'`,
		t0.Add(time.Minute).Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	srv := &Server{DB: conn}
	for name, wt := range map[string]string{"global": "", "worktree": p} {
		got, err := srv.Timeline(TimelineQuery{WorktreePath: wt, UnreadOnly: true})
		if err != nil {
			t.Fatal(err)
		}
		if ids := timelineIDs(got); !equalIDs(ids, []string{"new"}) {
			t.Errorf("%s: got %v, want [new]", name, ids)
		}
	}
}

func TestTimelineResourceFilter(t *testing.T) {
	t.Parallel()
	conn := timelineDB(t)
	p := addWatched(t, conn, "o/r#1")
	if err := resources.Add(conn, p, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	insertEvent(t, conn, "one", now, "github", "pr_comment", "a", "pr", "o/r#1", "u")
	insertEvent(t, conn, "two", now, "github", "pr_comment", "b", "pr", "o/r#2", "u")
	srv := &Server{DB: conn}
	for name, wt := range map[string]string{"global": "", "worktree": p} {
		got, err := srv.Timeline(TimelineQuery{WorktreePath: wt, ResourceType: "pr", ResourceID: "o/r#2"})
		if err != nil {
			t.Fatal(err)
		}
		if ids := timelineIDs(got); !equalIDs(ids, []string{"two"}) {
			t.Errorf("%s: got %v, want [two]", name, ids)
		}
	}
	if _, err := srv.Timeline(TimelineQuery{ResourceType: "pr"}); err == nil {
		t.Error("expected error for resource type without id")
	}
}
