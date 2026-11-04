package cmd

import (
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/unread"
)

func prUnread(t *testing.T) int {
	t.Helper()
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	counts, err := unread.Counts(conn)
	if err != nil {
		t.Fatal(err)
	}
	return counts[unread.Key("pr", "o/r#1")]
}

func TestActivityMarkReadAndUndo(t *testing.T) {
	seedUnreadPRAndSlack(t)
	if n := prUnread(t); n != 2 {
		t.Fatalf("unread before = %d", n)
	}
	out, err := runCLI(t, "activity", "mark-read", "e2")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out, "marked e2 read") {
		t.Fatalf("output = %q", out)
	}
	if n := prUnread(t); n != 1 {
		t.Fatalf("unread after mark = %d", n)
	}
	out, err = runCLI(t, "activity", "mark-read", "e2", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var changed bool
	decodeEnvelope(t, out, "changed", &changed)
	if changed {
		t.Fatal("a second mark changed something")
	}
	out, err = runCLI(t, "activity", "mark-read", "e2", "--undo", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	decodeEnvelope(t, out, "changed", &changed)
	if !changed {
		t.Fatal("undo reported no change")
	}
	if n := prUnread(t); n != 2 {
		t.Fatalf("unread after undo = %d", n)
	}
}

func TestActivityMarkReadRefusals(t *testing.T) {
	seedUnreadPRAndSlack(t)
	out, err := runCLI(t, "activity", "mark-read", "s1")
	if err == nil || !strings.Contains(err.Error(), "Slack") {
		t.Fatalf("slack event: err = %v, out = %q", err, out)
	}
	if _, err := runCLI(t, "activity", "mark-read", "nope"); err == nil || !strings.Contains(err.Error(), "no such event") {
		t.Fatalf("unknown event: err = %v", err)
	}
	if _, err := runCLI(t, "activity", "mark-read"); err == nil {
		t.Fatal("no event id must fail")
	}
}

// The human-readable feed has to show the id the command takes.
func TestActivityShowsEventIDs(t *testing.T) {
	seedUnreadPRAndSlack(t)
	out, err := runCLI(t, "activity", "--source", "github")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out, "e2") {
		t.Fatalf("output = %q, want the event id", out)
	}
}

func TestActivityMarkUnread(t *testing.T) {
	seedUnreadPRAndSlack(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	var newest string
	if err := conn.QueryRow(`SELECT MAX(ts) FROM watcher_events WHERE id IN ('e1','e2')`).Scan(&newest); err != nil {
		t.Fatal(err)
	}
	if err := unread.MarkRead(conn, "pr", "o/r#1", newest); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if n := prUnread(t); n != 0 {
		t.Fatalf("unread before = %d", n)
	}

	out, err := runCLI(t, "activity", "mark-unread", "e1")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out, "marked e1 unread") {
		t.Fatalf("output = %q", out)
	}
	if n := prUnread(t); n != 1 {
		t.Fatalf("unread after = %d", n)
	}
	out, err = runCLI(t, "activity", "mark-unread", "e1", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var changed bool
	decodeEnvelope(t, out, "changed", &changed)
	if changed {
		t.Fatal("a second mark changed something")
	}
	// mark-read takes it off again.
	if out, err := runCLI(t, "activity", "mark-read", "e1"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if n := prUnread(t); n != 0 {
		t.Fatalf("unread after mark-read = %d", n)
	}
}

func TestActivityMarkUnreadRefusals(t *testing.T) {
	seedUnreadPRAndSlack(t)
	if _, err := runCLI(t, "activity", "mark-unread", "s1"); err == nil || !strings.Contains(err.Error(), "Slack") {
		t.Fatalf("slack event: err = %v", err)
	}
	if _, err := runCLI(t, "activity", "mark-unread", "nope"); err == nil || !strings.Contains(err.Error(), "no such event") {
		t.Fatalf("unknown event: err = %v", err)
	}
}
