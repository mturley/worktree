package webui

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/testgit"
)

func insertTypedEvent(t *testing.T, conn *sql.DB, id, ts, typ, title, resType, resID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?, ?, 'github', ?, ?)`,
		id, ts, typ, title); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES (?, ?, ?)`,
		id, resType, resID); err != nil {
		t.Fatal(err)
	}
}

func newEventIDs(evs []newEvent) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.id)
	}
	return out
}

func TestCursorStartsAtNewestSoNoBacklog(t *testing.T) {
	conn := unreadTestDB(t)
	insertTypedEvent(t, conn, "old", "2026-01-01T00:00:00Z", "pr_comment", "x", "pr", "o/r#1")
	c, err := initNotifyCursor(conn)
	if err != nil {
		t.Fatal(err)
	}
	evs, _, err := readNewEvents(conn, c)
	if err != nil {
		t.Fatal(err)
	}
	if len(evs) != 0 {
		t.Fatalf("boot must not replay history, got %v", newEventIDs(evs))
	}
}

func TestCursorCatchesSameSecondEventsExactlyOnce(t *testing.T) {
	conn := unreadTestDB(t)
	c, _ := initNotifyCursor(conn) // empty DB
	insertTypedEvent(t, conn, "a", "2026-01-01T00:00:05Z", "pr_comment", "x", "pr", "o/r#1")
	evs, c, _ := readNewEvents(conn, c)
	if got := newEventIDs(evs); len(got) != 1 || got[0] != "a" {
		t.Fatalf("first pass = %v", got)
	}
	// Written later, in the SAME second the cursor now sits on.
	insertTypedEvent(t, conn, "b", "2026-01-01T00:00:05Z", "pr_comment", "x", "pr", "o/r#1")
	evs, c, _ = readNewEvents(conn, c)
	if got := newEventIDs(evs); len(got) != 1 || got[0] != "b" {
		t.Fatalf("second pass = %v, want only b", got)
	}
	evs, _, _ = readNewEvents(conn, c)
	if len(evs) != 0 {
		t.Fatalf("third pass re-read %v", newEventIDs(evs))
	}
}

func TestReadNewEventsSkipsNoiseTypes(t *testing.T) {
	conn := unreadTestDB(t)
	c, _ := initNotifyCursor(conn)
	for i, typ := range []string{"watch_started", "watcher_error", "ci_pending", "ci_workflows_pending", "ci_failed"} {
		insertTypedEvent(t, conn, typ, "2026-01-01T00:00:0"+string(rune('1'+i))+"Z", typ, "x", "pr", "o/r#1")
	}
	evs, _, _ := readNewEvents(conn, c)
	if got := newEventIDs(evs); len(got) != 1 || got[0] != "ci_failed" {
		t.Fatalf("got %v, want only ci_failed", got)
	}
}

// twoWorktrees tracks the same PR in two worktrees and returns them.
func twoWorktrees(t *testing.T, conn *sql.DB) (string, string) {
	t.Helper()
	a, b := testgit.Worktree(t), testgit.Worktree(t)
	for _, wt := range []string{a, b} {
		if err := registry.Register(conn, registry.Entry{Path: wt, Repo: "r", RepoRoot: "/r", Branch: filepath.Base(wt), CreatedAt: "now"}); err != nil {
			t.Fatal(err)
		}
		if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#7", URL: "https://github.com/o/r/pull/7"}); err != nil {
			t.Fatal(err)
		}
	}
	return a, b
}

func TestBatchesOnlyForNotifyingWorktree(t *testing.T) {
	conn := unreadTestDB(t)
	a, _ := twoWorktrees(t, conn)
	notifyprefs.SetResource(conn, a, "pr", "o/r#7", true)
	s := &Server{DB: conn}
	evs := []newEvent{
		{id: "e1", ts: "1", title: "first", resType: "pr", resID: "o/r#7"},
		{id: "e2", ts: "2", title: "newest", resType: "pr", resID: "o/r#7"},
		{id: "e3", ts: "2", title: "untracked", resType: "pr", resID: "o/r#99"},
	}
	got, err := s.notifyBatches(evs)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d batches, want 1 (only a notifies; #99 is tracked nowhere): %+v", len(got), got)
	}
	b := got[0]
	if b.WorktreePath != a || b.ResourceID != "o/r#7" {
		t.Fatalf("batch for wrong target: %+v", b)
	}
	if b.Title != "PR #7" || b.Subtitle != filepath.Base(a) || b.Body != "newest (+1 more)" {
		t.Fatalf("text = %q / %q / %q", b.Title, b.Subtitle, b.Body)
	}
	if b.Tag != notifyTag(a, "pr", "o/r#7") {
		t.Fatalf("tag = %q", b.Tag)
	}
}

func TestWorktreeWideToggleCoversEveryTrackedResource(t *testing.T) {
	conn := unreadTestDB(t)
	_, b := twoWorktrees(t, conn)
	notifyprefs.SetAll(conn, b, true)
	s := &Server{DB: conn}
	got, _ := s.notifyBatches([]newEvent{{id: "e1", ts: "1", title: "hi", resType: "pr", resID: "o/r#7"}})
	if len(got) != 1 || got[0].WorktreePath != b || got[0].Body != "hi" {
		t.Fatalf("got %+v", got)
	}
}

func TestNotifyResourceLabel(t *testing.T) {
	cases := []struct {
		d    resourceDTO
		want string
	}{
		{resourceDTO{Type: "pr", ID: "o/r#12", Title: "Fix foo"}, "PR #12: Fix foo"},
		{resourceDTO{Type: "pr", ID: "o/r#12", Title: "Fix foo", CustomName: "Mine"}, "PR #12: Mine"},
		{resourceDTO{Type: "jira", ID: "X-1", Title: "Bug"}, "X-1: Bug"},
		{resourceDTO{Type: "jira", ID: "X-1"}, "X-1"},
		{resourceDTO{Type: "slack", ID: "C1:1.2", ChannelName: "dev"}, "Thread in #dev"},
		{resourceDTO{Type: "slack", ID: "C1:1.2", CustomName: "Rollout"}, "Slack thread: Rollout"},
	}
	for _, c := range cases {
		if got := notifyResourceLabel(c.d); got != c.want {
			t.Errorf("%+v -> %q, want %q", c.d, got, c.want)
		}
	}
}

func TestCursorCatchesEventCommittedLateIntoAnEarlierSecond(t *testing.T) {
	conn := unreadTestDB(t)
	c, _ := initNotifyCursor(conn)
	insertTypedEvent(t, conn, "b", "2026-01-01T00:00:06Z", "pr_comment", "x", "pr", "o/r#1")
	evs, c, _ := readNewEvents(conn, c)
	if got := newEventIDs(evs); len(got) != 1 || got[0] != "b" {
		t.Fatalf("first pass = %v", got)
	}
	// A writer that stamped ts before waiting on the SQLite lock commits
	// after the cursor has already moved past its second.
	insertTypedEvent(t, conn, "a", "2026-01-01T00:00:05Z", "pr_comment", "x", "pr", "o/r#1")
	evs, c, _ = readNewEvents(conn, c)
	if got := newEventIDs(evs); len(got) != 1 || got[0] != "a" {
		t.Fatalf("second pass = %v, want the late event a", got)
	}
	if evs, _, _ = readNewEvents(conn, c); len(evs) != 0 {
		t.Fatalf("third pass re-read %v", newEventIDs(evs))
	}
}

func TestCursorRereadsAReusedIDWithANewTS(t *testing.T) {
	conn := unreadTestDB(t)
	c, _ := initNotifyCursor(conn)
	insertTypedEvent(t, conn, "ci1", "2026-01-01T00:00:05Z", "ci_failed", "x", "pr", "o/r#1")
	_, c, _ = readNewEvents(conn, c)
	// The watcher reuses a CI bundle's ID and restamps its ts on update.
	if _, err := conn.Exec(`UPDATE watcher_events SET ts = '2026-01-01T00:00:08Z', type = 'ci_passed' WHERE id = 'ci1'`); err != nil {
		t.Fatal(err)
	}
	evs, _, _ := readNewEvents(conn, c)
	if got := newEventIDs(evs); len(got) != 1 || got[0] != "ci1" {
		t.Fatalf("got %v, want the updated bundle again", got)
	}
}

func TestReadNewEventsSkipsMyOwnEvents(t *testing.T) {
	conn := unreadTestDB(t)
	selfid.Set(conn, "github", "101")
	c, _ := initNotifyCursor(conn)
	insertTypedEvent(t, conn, "mine", "2026-01-01T00:00:01Z", "pr_comment", "x", "pr", "o/r#1")
	insertTypedEvent(t, conn, "theirs", "2026-01-01T00:00:02Z", "pr_comment", "x", "pr", "o/r#1")
	insertTypedEvent(t, conn, "ghost", "2026-01-01T00:00:03Z", "pr_comment", "x", "pr", "o/r#1")
	conn.Exec(`UPDATE watcher_events SET author_id = '101' WHERE id = 'mine'`)
	conn.Exec(`UPDATE watcher_events SET author_id = '202' WHERE id = 'theirs'`)
	// "ghost" has no author_id, like an actor without a databaseId.
	evs, _, err := readNewEvents(conn, c)
	if err != nil {
		t.Fatal(err)
	}
	if got := newEventIDs(evs); len(got) != 2 || got[0] != "theirs" || got[1] != "ghost" {
		t.Fatalf("got %v, want [theirs ghost]", got)
	}
}
