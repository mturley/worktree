package cmd

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/unread"
)

func TestResourcesJSONContract(t *testing.T) {
	rs := []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "http://x/1", Related: false},
		{Type: "jira", ID: "RH-2", URL: "http://x/2", Related: true},
	}
	b, err := resourcesJSON(rs, nil)
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d", len(got))
	}
	if got[0]["type"] != "pr" || got[0]["id"] != "o/r#1" || got[0]["primary"] != true {
		t.Fatalf("row0: %+v", got[0])
	}
	if got[1]["primary"] != false {
		t.Fatalf("related resource must be primary=false: %+v", got[1])
	}
	// exact field set — the contract handler binds to
	for _, k := range []string{"type", "id", "url", "primary"} {
		if _, ok := got[0][k]; !ok {
			t.Fatalf("missing field %q", k)
		}
	}
}

func TestResourcesJSONIncludesMetaFields(t *testing.T) {
	rs := []resources.Resource{
		{Type: "slack", ID: "C1:1.2", URL: "http://x", CustomName: "Release blocker",
			CustomDescription: "e2e regression", UpdatedAt: "2030-01-02T03:04:05Z"},
	}
	b, err := resourcesJSON(rs, nil)
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got[0]["custom_name"] != "Release blocker" ||
		got[0]["custom_description"] != "e2e regression" ||
		got[0]["updated_at"] != "2030-01-02T03:04:05Z" {
		t.Fatalf("meta fields missing/wrong: %+v", got[0])
	}
}

func TestResourcesJSONOmitsEmptyMeta(t *testing.T) {
	b, err := resourcesJSON([]resources.Resource{{Type: "pr", ID: "o/r#1", URL: "u"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"custom_name", "custom_description", "updated_at"} {
		if _, ok := got[0][k]; ok {
			t.Fatalf("empty meta field %q should be omitted, got %+v", k, got[0])
		}
	}
}

func TestResourcesJSONEmptyIsArray(t *testing.T) {
	b, err := resourcesJSON(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "[]" {
		t.Fatalf("empty must serialize to [], got %s", b)
	}
}

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

func TestResourcesJSONCarriesUnreadCount(t *testing.T) {
	rs := []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "http://x/1"},
		{Type: "jira", ID: "RH-2", URL: "http://x/2"},
	}
	counts := map[string]int{unread.Key("pr", "o/r#1"): 3}
	b, err := resourcesJSON(rs, counts)
	if err != nil {
		t.Fatal(err)
	}
	var got []map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got[0]["unread_count"] != float64(3) {
		t.Fatalf("unread_count = %v, want 3", got[0]["unread_count"])
	}
	// omitempty: a fully read resource's object must stay byte-identical to
	// what this command emitted before the field existed, because
	// agent-handler parses it.
	if _, present := got[1]["unread_count"]; present {
		t.Fatalf("a read resource must omit unread_count entirely: %+v", got[1])
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
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 0 {
		t.Fatalf("unread = %d, want 0 — a bare mark-read clears through the newest event", n)
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
	if _, err := conn.Exec(
		`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?, ?, 'github', 'pr_comment', 'x')`,
		id, ts); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES (?, ?, ?)`,
		id, resType, resID); err != nil {
		t.Fatal(err)
	}
}
