package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	watcher "github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
)

// seedSlackThreads follows two threads whose titles share "rollout", and gives
// the first a root message and a reply.
func seedSlackThreads(t *testing.T) {
	t.Helper()
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for i, th := range []struct{ id, title string }{
		{"C1:1700000000.000100", "Rollout plan"},
		{"C1:1700000001.000100", "Rollout retro"},
	} {
		if err := resources.Add(conn, live, resources.Resource{Type: "slack", ID: th.id,
			URL: "https://x.slack.com/archives/C1/p170000000" + string(rune('0'+i)) + "000100"}); err != nil {
			t.Fatal(err)
		}
		state := `{"title":"` + th.title + `","author":"Ann","channel_name":"dev","reply_count":1}`
		if err := watcherdb.UpsertResourceState(conn, "slack", th.id, state, "2026-02-01T00:00:00Z", "x"); err != nil {
			t.Fatal(err)
		}
	}
	for i, m := range []struct{ typ, ts, ext, body string }{
		{"slack_thread_root", "2026-01-01T00:00:00Z", "1700000000.000100", "Ann: hello *world*"},
		{"slack_reply", "2026-01-01T00:01:00Z", "1700000000.000200", "Bob: sure"},
	} {
		a, aid, body, ext := "Ann", "UAnn", m.body, m.ext
		if i == 1 {
			a, aid = "Bob", "UBob"
		}
		e := watcher.Event{ID: "se" + string(rune('a'+i)), TS: m.ts, ExternalTS: &ext, Source: "slack",
			Type: watcher.EventType(m.typ), Title: "t", Body: &body, Author: &a, AuthorID: &aid}
		if err := watcherdb.InsertEvent(conn, e, watcher.Resource{Type: "slack", ID: "C1:1700000000.000100"}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSlackThreadJSONSummaryOnly(t *testing.T) {
	seedSlackThreads(t)
	out, err := runCLI(t, "slack", "thread", "plan", "--json")
	if err != nil {
		t.Fatalf("err = %v\n%s", err, out)
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal([]byte(out), &env); err != nil {
		t.Fatal(err)
	}
	if _, ok := env["messages"]; ok {
		t.Fatalf("messages present without --messages: %s", out)
	}
	var th map[string]any
	if err := json.Unmarshal(env["thread"], &th); err != nil || th["id"] != "C1:1700000000.000100" {
		t.Fatalf("thread = %s", env["thread"])
	}
}

func TestSlackThreadMessagesJSON(t *testing.T) {
	seedSlackThreads(t)
	out, err := runCLI(t, "slack", "thread", "plan", "--messages", "--json")
	if err != nil {
		t.Fatalf("err = %v\n%s", err, out)
	}
	var msgs []map[string]any
	decodeEnvelope(t, out, "messages", &msgs)
	if len(msgs) != 2 || msgs[0]["text"] != "hello *world*" || msgs[1]["author"] != "Bob" {
		t.Fatalf("messages = %v", msgs)
	}
	out, err = runCLI(t, "slack", "thread", "plan", "--messages")
	if err != nil || !strings.Contains(out, "Ann · ") || !strings.Contains(out, "hello *world*") {
		t.Fatalf("human = %q, %v", out, err)
	}
}

func TestSlackThreadAmbiguousExit2(t *testing.T) {
	seedSlackThreads(t)
	var stderr bytes.Buffer
	out, err := runCLI(t, "slack", "thread", "rollout", "--json")
	if err == nil || !errors.Is(err, ErrPrinted) {
		t.Fatalf("err = %v, want ErrPrinted", err)
	}
	if got := exitCode(err, &stderr); got != 2 {
		t.Fatalf("exit = %d", got)
	}
	if want := `ambiguous: 2 threads match "rollout"` + "\n"; stderr.String() != want {
		t.Fatalf("stderr = %q, want %q", stderr.String(), want)
	}
	var obj struct {
		Ambiguous  bool             `json:"ambiguous"`
		Candidates []map[string]any `json:"candidates"`
	}
	if err := json.Unmarshal([]byte(out), &obj); err != nil || !obj.Ambiguous || len(obj.Candidates) != 2 {
		t.Fatalf("stdout = %q (%v)", out, err)
	}
}

func TestSlackThreadNotFoundExit1(t *testing.T) {
	seedSlackThreads(t)
	_, err := runCLI(t, "slack", "thread", "no-such-thread")
	if !errors.Is(err, ErrNothingFound) {
		t.Fatalf("err = %v", err)
	}
	if got := exitCode(err, &bytes.Buffer{}); got != 1 {
		t.Fatalf("exit = %d", got)
	}
}
