package cmd

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
)

// seedSearchFixture registers a worktree following a PR and a link, with one
// PR event whose title and body say "flaky".
func seedSearchFixture(t *testing.T) string {
	t.Helper()
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for _, r := range []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "https://github.com/o/r/pull/1"},
		{Type: "link", ID: "https://example.com/zebra", URL: "https://example.com/zebra"},
	} {
		if err := resources.Add(conn, live, r); err != nil {
			t.Fatal(err)
		}
	}
	ts := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
	if _, err := conn.Exec(`INSERT INTO watcher_events (id, ts, source, type, title, body) VALUES (?,?,?,?,?,?)`,
		"e1", ts, "github", "pr_comment", "flaky login test", "SECRET-BODY-TEXT flaky"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id, resource_url) VALUES (?,?,?,?)`,
		"e1", "pr", "o/r#1", "https://github.com/o/r/pull/1"); err != nil {
		t.Fatal(err)
	}
	return live
}

func TestSearchJSONShape(t *testing.T) {
	live := seedSearchFixture(t)
	out, err := runCLI(t, "search", "flaky", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"schema_version", "query", "terms", "scope", "worktrees", "resources", "tasks", "events"} {
		if _, ok := env[k]; !ok {
			t.Errorf("missing key %q\n%s", k, out)
		}
	}
	if string(env["scope"]) != `"all"` {
		t.Errorf("scope = %s", env["scope"])
	}
	if strings.Contains(strings.ToLower(out), `"body"`) || strings.Contains(out, "SECRET-BODY-TEXT") {
		t.Errorf("output carries an event body:\n%s", out)
	}
	var evs []map[string]any
	decodeEnvelope(t, out, "events", &evs)
	if len(evs) != 1 || evs[0]["id"] != "e1" {
		t.Fatalf("events = %v", evs)
	}
	_ = live
}

func TestSearchScopedOmitsGroups(t *testing.T) {
	live := seedSearchFixture(t)
	out, err := runCLI(t, "search", "flaky", "--worktree", live, "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"worktrees", "tasks"} {
		if _, ok := env[k]; ok {
			t.Errorf("scoped output has %q\n%s", k, out)
		}
	}
	if string(env["scope"]) != `"`+live+`"` {
		t.Errorf("scope = %s, want %q", env["scope"], live)
	}
	if _, err := runCLI(t, "search", "flaky", "--worktree", live, "--archived"); err == nil {
		t.Error("--archived with --worktree accepted")
	}
}

func TestSearchNothingFoundExit1(t *testing.T) {
	seedSearchFixture(t)
	out, err := runCLI(t, "search", "qqqnomatchqqq")
	if !errors.Is(err, ErrNothingFound) {
		t.Fatalf("err = %v\n%s", err, out)
	}
	if code := exitCode(err, &strings.Builder{}); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	out, err = runCLI(t, "search", "qqqnomatchqqq", "--json")
	if !errors.Is(err, ErrNothingFound) {
		t.Fatalf("json err = %v", err)
	}
	var evs []map[string]any
	decodeEnvelope(t, out, "events", &evs)
	if evs == nil || len(evs) != 0 {
		t.Fatalf("events = %#v, want []", evs)
	}
}

func TestSearchEmptyQueryExit2(t *testing.T) {
	seedSearchFixture(t)
	for _, args := range [][]string{{"search", "   "}, {"search"}} {
		out, err := runCLI(t, args...)
		if err == nil || errors.Is(err, ErrNothingFound) {
			t.Fatalf("%v: err = %v\n%s", args, err, out)
		}
		if code := exitCode(err, &strings.Builder{}); code != 2 {
			t.Fatalf("%v: exit = %d, want 2", args, code)
		}
	}
}

func TestSearchSourceLinks(t *testing.T) {
	seedSearchFixture(t)
	out, err := runCLI(t, "search", "zebra", "--source", "links", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var rs []map[string]any
	decodeEnvelope(t, out, "resources", &rs)
	if len(rs) != 1 || rs[0]["type"] != "link" {
		t.Fatalf("resources = %v", rs)
	}
	if _, err := runCLI(t, "search", "zebra", "--source", "github"); !errors.Is(err, ErrNothingFound) {
		t.Fatalf("github source still found the link: %v", err)
	}
	if _, err := runCLI(t, "search", "zebra", "--source", "email"); err == nil || errors.Is(err, ErrNothingFound) {
		t.Fatalf("unknown source: %v", err)
	}
}

func TestSearchHumanOutputHasNoANSI(t *testing.T) {
	seedSearchFixture(t)
	out, err := runCLI(t, "search", "flaky")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if strings.Contains(out, "\x1b") || !strings.Contains(out, "Activity") || !strings.Contains(out, "flaky login test") {
		t.Fatalf("output = %q", out)
	}
}
