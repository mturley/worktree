package cmd

import (
	"strings"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/unread"
)

// seedUnreadPRAndSlack follows an unread PR (two events) and an unread Slack
// thread (one reply past Slack's cursor) in the live worktree.
func seedUnreadPRAndSlack(t *testing.T) string {
	t.Helper()
	stubUIProbe(t, false)
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for _, r := range []resources.Resource{
		{Type: "pr", ID: "o/r#1", URL: "https://pr/1"},
		{Type: "slack", ID: "C1:1000.000100", URL: "https://slack/1"},
	} {
		if err := resources.Add(conn, live, r); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Now().UTC().Add(time.Hour)
	for i, id := range []string{"e1", "e2"} {
		ts := base.Add(time.Duration(i) * time.Minute).Format(time.RFC3339)
		if _, err := conn.Exec(`INSERT INTO watcher_events (id, ts, source, type, title) VALUES (?,?,'github','pr_comment','c')`, id, ts); err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id, resource_url) VALUES (?,'pr','o/r#1','u')`, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := conn.Exec(`INSERT INTO watcher_resource_state (resource_type, resource_id, state_json, resource_updated_at, watcher_updated_at)
		VALUES ('slack','C1:1000.000100','{"title":"t","has_unread":true,"last_read":"2000.000000"}','','x')`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO watcher_events (id, ts, external_ts, source, type, title) VALUES ('s1',?, '3000.000000','slack','slack_reply','x')`,
		base.Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id) VALUES ('s1','slack','C1:1000.000100')`); err != nil {
		t.Fatal(err)
	}
	return live
}

func TestUnreadByWorktree(t *testing.T) {
	live := seedUnreadPRAndSlack(t)
	out, err := runCLI(t, "unread", "--json", "--by", "worktree")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var by map[string]int
	decodeEnvelope(t, out, "by", &by)
	if len(by) != 1 || by[live] != 3 {
		t.Fatalf("by = %v, want only %s: 3\n%s", by, live, out)
	}
	var count int
	decodeEnvelope(t, out, "count", &count)
	if count != 3 {
		t.Fatalf("count = %d", count)
	}

	out, err = runCLI(t, "unread", "--json", "--by", "resource")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	by = nil
	decodeEnvelope(t, out, "by", &by)
	if len(by) != 2 || by["pr:o/r#1"] != 2 || by["slack:C1:1000.000100"] != 1 {
		t.Fatalf("by resource = %v", by)
	}

	if _, err := runCLI(t, "unread", "--by", "branch"); err == nil {
		t.Fatal("an unknown --by must be an error")
	}
}

func TestUnreadExitZeroWhenNothing(t *testing.T) {
	stubUIProbe(t, false)
	seedReadFixture(t)
	for _, args := range [][]string{{"unread"}, {"unread", "--json"}, {"unread", "--json", "--by", "worktree"}} {
		out, err := runCLI(t, args...)
		if err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
	}
	out, _ := runCLI(t, "unread", "--json", "--by", "resource")
	var by map[string]int
	decodeEnvelope(t, out, "by", &by)
	if by == nil || len(by) != 0 {
		t.Fatalf("by = %#v, want {}", by)
	}
}

func TestMarkReadWorktreeSkipsSlack(t *testing.T) {
	live := seedUnreadPRAndSlack(t)
	out, err := runCLI(t, "resources", "mark-read", "--worktree", live)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out, "marked 1 resource") || !strings.Contains(out, "skipped 1 Slack thread(s): their read state is Slack's") {
		t.Fatalf("output = %q", out)
	}
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	if n := counts[unread.Key("pr", "o/r#1")]; n != 0 {
		t.Fatalf("pr unread = %d", n)
	}
	cursors, err := unread.Cursors(conn)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := cursors[unread.Key("slack", "C1:1000.000100")]; ok {
		t.Fatal("a slack thread must get no cursor")
	}
	var lastRead string
	if err := conn.QueryRow(`SELECT json_extract(state_json,'$.last_read') FROM watcher_resource_state WHERE resource_type='slack'`).Scan(&lastRead); err != nil || lastRead != "2000.000000" {
		t.Fatalf("slack state touched: %q %v", lastRead, err)
	}

	out, err = runCLI(t, "resources", "mark-read", "--all", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var remaining int
	decodeEnvelope(t, out, "task_events_remaining", &remaining)
	var marked, skipped int
	decodeEnvelope(t, out, "marked", &marked)
	decodeEnvelope(t, out, "skipped_slack", &skipped)
	if marked != 0 || skipped != 1 {
		t.Fatalf("second run marked %d skipped %d\n%s", marked, skipped, out)
	}
}

func TestMarkReadFlagsAreExclusive(t *testing.T) {
	live := seedUnreadPRAndSlack(t)
	for _, args := range [][]string{
		{"resources", "mark-read", "--all", "--worktree", live},
		{"resources", "mark-read", "--all", "pr", "o/r#1"},
		{"resources", "mark-read", "--worktree", live, "pr", "o/r#1"},
		{"resources", "mark-read"},
		{"resources", "mark-read", "--worktree", "/not/registered"},
	} {
		if out, err := runCLI(t, args...); err == nil {
			t.Fatalf("%v should fail\n%s", args, out)
		}
	}
}
