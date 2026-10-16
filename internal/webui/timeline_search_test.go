package webui

import (
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"testing"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

// searchFixture: one worktree following a PR and a Jira issue, with events
// whose text, author, resource id, custom name and cached title each carry a
// distinct word.
func searchFixture(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	wt := testgit.Worktree(t)
	must(t, registry.Register(conn, registry.Entry{Path: wt, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"}))
	must(t, resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, resources.Add(conn, wt, resources.Resource{Type: "jira", ID: "PROJ-7", URL: "u2"}))
	must(t, watcherdb.UpsertResourceState(conn, "jira", "PROJ-7", `{"summary":"Migrate kumquat proxy","status":"New"}`, "2026-01-01T00:00:00Z", "x"))
	must(t, watcherdb.SetResourceMeta(conn, watcher.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}, "Persimmon work", ""))
	insertEvent(t, conn, "e1", "2026-09-01T00:00:05Z", "github", "pr_comment", "New comment", "pr", "o/r#1", "u1")
	_, err = conn.Exec(`UPDATE watcher_events SET body = 'the oauth cookie is cleared', author = 'andrew' WHERE id = 'e1'`)
	must(t, err)
	insertEvent(t, conn, "e2", "2026-09-01T00:00:04Z", "jira", "jira_status_changed", "Status changed", "jira", "PROJ-7", "u2")
	insertEvent(t, conn, "e3", "2026-09-01T00:00:03Z", "github", "ci_failed", "CI 100% broken", "pr", "o/r#1", "u1")
	insertEvent(t, conn, "e4", "2026-09-01T00:00:02Z", "github", "ci_failed", "CI 1000 broken", "pr", "o/r#1", "u1")
	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, wt
}

func TestGlobalTimelineSearch(t *testing.T) {
	ts, _ := searchFixture(t)
	get := func(q string, extra string) []TimelineEvent {
		return getTimeline(t, ts.URL, "/api/timeline?limit=50&q="+url.QueryEscape(q)+extra).Events
	}
	cases := []struct {
		q    string
		want []string
	}{
		{"oauth", []string{"e1"}},                 // body
		{"ANDREW", []string{"e1"}},                // author, case-insensitive
		{"persimmon", []string{"e1", "e3", "e4"}}, // custom name
		{"kumquat", []string{"e2"}},               // cached Jira summary
		{"proj-7", []string{"e2"}},                // resource id
		{"oauth persimmon", []string{"e1"}},       // AND across fields
		{"oauth kumquat", nil},                    // AND, no event has both
		{"100%", []string{"e3"}},                  // % is literal
		{"ci_", nil},                              // _ is literal; no title contains "ci_"
		{"   ", []string{"e1", "e2", "e3", "e4"}}, // blank = no filter
	}
	for _, c := range cases {
		got := eventIDs(get(c.q, ""))
		if !slices.Equal(got, c.want) && !(len(got) == 0 && len(c.want) == 0) {
			t.Errorf("q=%q: got %v want %v", c.q, got, c.want)
		}
	}
	// Combines with other filters.
	if got := eventIDs(get("persimmon", "&event_types=ci_*")); !slices.Equal(got, []string{"e3", "e4"}) {
		t.Errorf("q + event_types: %v", got)
	}
	// Pagination: before excludes e3 and newer.
	if got := eventIDs(get("persimmon", "&before=2026-09-01T00:00:03Z")); !slices.Equal(got, []string{"e4"}) {
		t.Errorf("q + before: %v", got)
	}
	// match is set with q and absent without.
	evs := get("oauth", "")
	if evs[0].Match == nil || evs[0].Match.Field != "body" || evs[0].Match.Snippet != "the oauth cookie is cleared" {
		t.Errorf("match = %+v", evs[0].Match)
	}
	if evs := get("kumquat", ""); evs[0].Match == nil || evs[0].Match.Field != "resource" {
		t.Errorf("resource match = %+v", evs[0].Match)
	}
	for _, e := range getTimeline(t, ts.URL, "/api/timeline?limit=50").Events {
		if e.Match != nil {
			t.Errorf("no q must mean no match, got %+v on %s", e.Match, e.ID)
		}
	}
}

// A malformed cached state must not fail the whole search: json_extract
// raises on invalid JSON, so the SQL guards it with json_valid.
func TestGlobalTimelineSearchMalformedResourceState(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wt := testgit.Worktree(t)
	must(t, registry.Register(conn, registry.Entry{Path: wt, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"}))
	must(t, resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#1", `{not json`, "2026-01-01T00:00:00Z", "x"))
	insertEvent(t, conn, "e1", "2026-09-01T00:00:02Z", "github", "ci_failed", "build broke", "pr", "o/r#1", "u1")
	insertEvent(t, conn, "e2", "2026-09-01T00:00:01Z", "github", "ci_failed", "unrelated", "pr", "o/r#1", "u1")

	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()
	got := getTimeline(t, ts.URL, "/api/timeline?limit=50&q=broke")
	if ids := eventIDs(got.Events); !slices.Equal(ids, []string{"e1"}) {
		t.Errorf("malformed state: got %v want [e1]", ids)
	}
}
