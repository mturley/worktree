package cmd

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
)

func TestParseSince(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	got, err := parseSince(now, "24h")
	if err != nil || got != "2026-10-30T12:00:00Z" {
		t.Fatalf("24h = %q, %v", got, err)
	}
	got, err = parseSince(now, "2026-10-01T08:30:00Z")
	if err != nil || got != "2026-10-01T08:30:00Z" {
		t.Fatalf("RFC 3339 = %q, %v", got, err)
	}
	if _, err := parseSince(now, "x"); err == nil {
		t.Fatal("parseSince(x) = nil error")
	}
}

func TestActivitySourceMapping(t *testing.T) {
	got, err := sourceTypes([]string{"github", "jira", "slack", "tasks"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"pr", "jira", "slack", "task"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if _, err := sourceTypes([]string{"email"}); err == nil {
		t.Fatal("unknown source accepted")
	}
}

func TestActivityUnreadEmptyExit1(t *testing.T) {
	seedReadFixture(t)
	out, err := runCLI(t, "activity", "--unread")
	if !errors.Is(err, ErrNothingFound) {
		t.Fatalf("err = %v, want ErrNothingFound\n%s", err, out)
	}
	if !strings.Contains(out, "Nothing unread.") {
		t.Fatalf("output = %q", out)
	}
	out, err = runCLI(t, "activity", "--unread", "--json")
	if !errors.Is(err, ErrNothingFound) {
		t.Fatalf("json err = %v", err)
	}
	var evs []map[string]any
	decodeEnvelope(t, out, "events", &evs)
	if evs == nil || len(evs) != 0 {
		t.Fatalf("events = %#v, want []", evs)
	}
}

func TestActivityRejectsBadFlags(t *testing.T) {
	seedReadFixture(t)
	for _, args := range [][]string{
		{"activity", "--resource", "pr:o/r#1", "--source", "github"},
		{"activity", "--resource", "task:T1"},
		{"activity", "--resource", "nonsense"},
		{"activity", "--source", "email"},
		{"activity", "--since", "x"},
	} {
		if out, err := runCLI(t, args...); err == nil || errors.Is(err, ErrNothingFound) {
			t.Errorf("%v: err = %v\n%s", args, err, out)
		}
	}
}

func TestActivityListsAndFilters(t *testing.T) {
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, live, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	ins := func(id, ts, src, rtype, rid, title string) {
		if _, err := conn.Exec(`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?,?,?,?,?)`, id, ts, src, "pr_comment", title); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id, resource_url) VALUES (?,?,?,?)`, id, rtype, rid, "u"); err != nil {
			t.Fatal(err)
		}
	}
	ins("e1", now.Add(-time.Hour).Format(time.RFC3339), "github", "pr", "o/r#1", "recent")
	ins("e2", now.Add(-72*time.Hour).Format(time.RFC3339), "github", "pr", "o/r#1", "old")
	conn.Close()

	var evs []map[string]any
	out, err := runCLI(t, "activity", "--json")
	if err != nil {
		t.Fatal(err)
	}
	decodeEnvelope(t, out, "events", &evs)
	if len(evs) != 2 {
		t.Fatalf("got %d events: %s", len(evs), out)
	}
	out, err = runCLI(t, "activity", "--json", "--since", "24h", "--source", "github", "--worktree", live)
	if err != nil {
		t.Fatal(err)
	}
	decodeEnvelope(t, out, "events", &evs)
	if len(evs) != 1 || evs[0]["title"] != "recent" {
		t.Fatalf("filtered = %v", evs)
	}
	out, err = runCLI(t, "activity", "--resource", "pr:o/r#1", "--limit", "1")
	if err != nil || !strings.Contains(out, "recent") || strings.Contains(out, "old") {
		t.Fatalf("text = %q, %v", out, err)
	}
}
