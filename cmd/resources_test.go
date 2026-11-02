package cmd

import (
	"bytes"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/jira/jiratest"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
	"github.com/mturley/worktree/internal/unread"
)

func TestResolveResourceArgs(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		wantType string
		wantID   string
		wantURL  string
		wantErr  bool
		setup    func(t *testing.T)
	}{
		{
			name:     "url form infers type and id",
			args:     []string{"https://github.com/o/r/pull/42"},
			wantType: "pr",
			wantID:   "o/r#42",
			wantURL:  "https://github.com/o/r/pull/42",
		},
		{
			name:     "slack url form",
			args:     []string{"https://x.slack.com/archives/C123/p1700000000000200"},
			wantType: "slack",
			wantID:   "C123:1700000000.000200",
			wantURL:  "https://x.slack.com/archives/C123/p1700000000000200",
		},
		{
			name:     "explicit two-arg form still works",
			args:     []string{"jira", "ABC-1"},
			wantType: "jira",
			wantID:   "ABC-1",
		},
		{
			name:     "two-arg jira form without --url builds the issue url",
			args:     []string{"jira", "ABC-1"},
			wantType: "jira",
			wantID:   "ABC-1",
			wantURL:  "https://y.atlassian.net/browse/ABC-1",
			setup:    func(t *testing.T) { jiratest.WriteWatcherAuth(t, "y.atlassian.net") },
		},
		{
			name:     "two-arg form carries the --url flag through",
			args:     []string{"jira", "ABC-1"},
			wantType: "jira",
			wantID:   "ABC-1",
			wantURL:  "https://x.atlassian.net/browse/ABC-1",
			setup: func(t *testing.T) {
				prev := resURL
				resURL = "https://x.atlassian.net/browse/ABC-1"
				t.Cleanup(func() { resURL = prev })
			},
		},
		{
			name:    "unrecognized single arg is an error, not a resource",
			args:    []string{"just-some-text"},
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// No Jira configured unless the case says so.
			t.Setenv("WATCHER_HOME", t.TempDir())
			if tc.setup != nil {
				tc.setup(t)
			}
			gt, gi, gu, err := resolveResourceArgs(tc.args)
			if tc.wantErr {
				if err == nil {
					t.Fatal("want an error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if gt != tc.wantType || gi != tc.wantID || gu != tc.wantURL {
				t.Fatalf("= (%q,%q,%q), want (%q,%q,%q)",
					gt, gi, gu, tc.wantType, tc.wantID, tc.wantURL)
			}
		})
	}
}

func TestWriteResourceLinesAppendsUnreadOnlyWhenNonZero(t *testing.T) {
	rs := []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "http://x/1"},
		{Type: "jira", ID: "RH-2", URL: "http://x/2", Related: true},
	}
	var buf bytes.Buffer
	writeResourceLines(&buf, rs, map[string]int{unread.Key("pr", "o/r#1"): 2})
	out := buf.String()

	if !strings.Contains(out, "  pr:o/r#1 http://x/1 (2 unread)\n") {
		t.Fatalf("unread resource line wrong: %q", out)
	}
	// The read resource keeps the exact pre-existing shape.
	if !strings.Contains(out, "~ jira:RH-2 http://x/2\n") {
		t.Fatalf("read resource line must be unchanged: %q", out)
	}
}

func TestMarkResourceReadDefaultsToTheNewestEvent(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	seedEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "pr", "o/r#1")
	seedEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "pr", "o/r#1")

	var buf bytes.Buffer
	if err := markResourceRead(conn, &buf, "pr", "o/r#1", ""); err != nil {
		t.Fatal(err)
	}
	// Assert the cursor was CREATED and landed on the newest event, not just
	// that the count is zero: a resource with no cursor row at all also
	// counts zero (Counts inner-joins the cursor table), so a count-only
	// assertion would pass against a markResourceRead that wrote nothing.
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := cursors[unread.Key("pr", "o/r#1")]
	if !ok {
		t.Fatal("a bare mark-read must create the resource's cursor")
	}
	if got != "2099-01-02T00:00:00Z" {
		t.Fatalf("cursor = %q, want the newest event's ts", got)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 0 {
		t.Fatalf("unread = %d, want 0 — a bare mark-read clears through the newest event", n)
	}
}

// A bookkeeping event is newer than every rendered one: the CLI default must
// still land on the newest RENDERED event, matching what unread.Counts counts
// and what the timelines show. Marking read through the bookkeeping event's ts
// would silently swallow anything that arrives between them.
func TestMarkResourceReadDefaultSkipsBookkeepingEvents(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	seedEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "pr", "o/r#1")
	seedTypedEvent(t, conn, "e2", "2099-01-05T00:00:00Z", "watcher_error", "pr", "o/r#1")

	var buf bytes.Buffer
	if err := markResourceRead(conn, &buf, "pr", "o/r#1", ""); err != nil {
		t.Fatal(err)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got := cursors[unread.Key("pr", "o/r#1")]; got != "2099-01-01T00:00:00Z" {
		t.Fatalf("cursor = %q, want the newest rendered event, not the watcher_error's ts", got)
	}
}

// A resource whose ONLY event is bookkeeping has nothing the user could have
// seen: the CLI reports that rather than marking read through an invisible ts.
func TestMarkResourceReadWithOnlyBookkeepingEventsReportsNoEvents(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	seedTypedEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "watch_started", "pr", "o/r#1")

	var buf bytes.Buffer
	if err := markResourceRead(conn, &buf, "pr", "o/r#1", ""); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); !strings.Contains(got, "no events for pr:o/r#1") {
		t.Fatalf("output = %q, want the no-events message", got)
	}
}

func TestMarkResourceReadHonoursAnExplicitThrough(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	seedEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "pr", "o/r#1")
	seedEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "pr", "o/r#1")

	var buf bytes.Buffer
	if err := markResourceRead(conn, &buf, "pr", "o/r#1", "2099-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 1 {
		t.Fatalf("unread = %d, want 1", n)
	}
}

func TestMarkResourceReadRejectsSlackWithAPointerToTheThreadView(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	var buf bytes.Buffer
	err = markResourceRead(conn, &buf, "slack", "C1:1.2", "")
	if err == nil {
		t.Fatal("mark-read must reject a slack resource")
	}
	if !strings.Contains(err.Error(), "thread view") {
		t.Fatalf("error %q must point the user at the thread view", err)
	}
}

func TestMarkResourceReadSaysSoWhenThereAreNoEvents(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	var buf bytes.Buffer
	if err := markResourceRead(conn, &buf, "pr", "o/r#9", ""); err != nil {
		t.Fatalf("a resource with no events is not an error: %v", err)
	}
	if !strings.Contains(buf.String(), "no events") {
		t.Fatalf("output %q must say there was nothing to mark", buf.String())
	}
}

// seedEvent inserts one event linked to one resource.
func seedEvent(t *testing.T, conn *sql.DB, id, ts, resType, resID string) {
	t.Helper()
	seedTypedEvent(t, conn, id, ts, "pr_comment", resType, resID)
}

// seedTypedEvent is seedEvent with the event type spelled out, for the
// bookkeeping types the timelines (and unread.Counts) filter out.
func seedTypedEvent(t *testing.T, conn *sql.DB, id, ts, evType, resType, resID string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?, ?, 'github', ?, 'x')`,
		id, ts, evType); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES (?, ?, ?)`,
		id, resType, resID); err != nil {
		t.Fatal(err)
	}
}

func TestResourcesListAll(t *testing.T) {
	live, gone := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	// resources.Add refuses a path that is not a linked worktree, so the
	// second follower is another real one.
	other := testgit.Worktree(t)
	if err := registry.Register(conn, registry.Entry{Path: other, Repo: "odh", RepoRoot: "/r", Branch: "b2", CreatedAt: "2026-08-14T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{live, other} {
		if err := resources.Add(conn, p, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := resources.SetMetaAt(conn, "pr", "o/r#1", "Name", "", "2030-01-02T03:04:05Z"); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	_ = gone

	out, err := runCLI(t, "resources", "list", "--all", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var got []struct {
		ID        string           `json:"id"`
		Worktrees []map[string]any `json:"worktrees"`
	}
	decodeEnvelope(t, out, "resources", &got)
	if len(got) != 1 || got[0].ID != "o/r#1" || len(got[0].Worktrees) != 2 {
		t.Fatalf("resources = %+v", got)
	}

	if out, err := runCLI(t, "resources", "list", "--all", "--worktree", live); err == nil {
		t.Fatalf("--all with --worktree must fail, got %q", out)
	}
}

// agent-handler mirrors custom names newest-wins on updated_at, so that key
// keeps meaning "when the custom name was written"; the resource's own time
// is resource_updated_at.
func TestResourcesListJSONUpdatedAtIsMetaTime(t *testing.T) {
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, live, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	if err := resources.SetMetaAt(conn, "pr", "o/r#1", "Name", "Desc", "2030-01-02T03:04:05Z"); err != nil {
		t.Fatal(err)
	}
	if err := watcherdb.UpsertResourceState(conn, "pr", "o/r#1", `{"title":"T","state":"open"}`, "2026-08-13T00:00:00Z", "2026-08-13T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	conn.Close()

	out, err := runCLI(t, "resources", "list", "--worktree", live, "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var got []map[string]any
	decodeEnvelope(t, out, "resources", &got)
	if len(got) != 1 {
		t.Fatalf("got %v", got)
	}
	r := got[0]
	if r["updated_at"] != "2030-01-02T03:04:05Z" || r["resource_updated_at"] != "2026-08-13T00:00:00Z" ||
		r["custom_name"] != "Name" || r["custom_description"] != "Desc" || r["state"] != "open" {
		t.Fatalf("resource = %v", r)
	}
}
