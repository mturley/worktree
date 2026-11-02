package cmd

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/attention"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/testgit"
)

const nothingLine = "Nothing needs your attention."

// seedAttention gives the live worktree an open PR requesting review, with
// one unread event, plus a global task due today. It returns the live path.
func seedAttention(t *testing.T) string {
	t.Helper()
	stubUIProbe(t, false)
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := resources.Add(conn, live, resources.Resource{Type: "pr", ID: "o/r#1", URL: "https://pr/1"}); err != nil {
		t.Fatal(err)
	}
	if err := selfid.Set(conn, "github", "101"); err != nil {
		t.Fatal(err)
	}
	if err := watcherdb.UpsertResourceState(conn, "pr", "o/r#1",
		`{"title":"Fix the thing","state":"OPEN","author_id":"202","requested_reviewer_ids":["101"]}`, "x", "x"); err != nil {
		t.Fatal(err)
	}
	ts := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
	if _, err := conn.Exec(`INSERT INTO watcher_events (id, ts, source, type, title, body, author) VALUES ('e1',?,'github','pr_comment','commented','hello','Sam')`, ts); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id, resource_url) VALUES ('e1','pr','o/r#1','u')`); err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.Create(conn, tasks.Actor{Kind: tasks.ActorUser}, tasks.NewTask{
		Title: "Compliance Training", Priority: tasks.PriorityHigh, Due: time.Now().Format(time.DateOnly),
	}); err != nil {
		t.Fatal(err)
	}
	return live
}

func TestAttentionEmptyExit1(t *testing.T) {
	stubUIProbe(t, false)
	seedReadFixture(t)
	out, err := runCLI(t, "attention")
	if !errors.Is(err, ErrNothingFound) {
		t.Fatalf("err = %v, want ErrNothingFound\n%s", err, out)
	}
	// The UI is stubbed as down, so the data is stale: the hint comes first,
	// and cobra adds no usage or "Error:" text.
	if want := staleHint + "\n" + nothingLine + "\n"; out != want {
		t.Fatalf("output = %q, want %q", out, want)
	}

	out, err = runCLI(t, "attention", "--json")
	if !errors.Is(err, ErrNothingFound) {
		t.Fatalf("json err = %v", err)
	}
	var items []map[string]any
	decodeEnvelope(t, out, "items", &items)
	if items == nil || len(items) != 0 {
		t.Fatalf("items = %#v, want []", items)
	}
	var status statusReport
	decodeEnvelope(t, out, "status", &status)
	if status.UIRunning || !status.Stale || len(status.Services) == 0 {
		t.Fatalf("status = %+v\n%s", status, out)
	}
}

func TestAttentionJSON(t *testing.T) {
	live := seedAttention(t)
	out, err := runCLI(t, "attention", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var items []attention.Item
	decodeEnvelope(t, out, "items", &items)
	if len(items) != 2 {
		t.Fatalf("items: %s", out)
	}
	// The task ranks 1; the PR has no rank.
	if items[0].Kind != "task" || items[0].Task.Title != "Compliance Training" || items[0].Rank == nil || *items[0].Rank != 1 {
		t.Fatalf("first = %+v", items[0])
	}
	pr := items[1]
	if pr.Kind != "resource" || pr.Resource.ID != "o/r#1" || pr.Resource.Title != "Fix the thing" {
		t.Fatalf("second = %+v", pr)
	}
	if len(pr.Signals) != 1 || pr.Signals[0] != "review_requested" {
		t.Fatalf("signals = %v", pr.Signals)
	}
	if !pr.Resource.ReviewRequestedFromMe || len(pr.Resource.Worktrees) != 1 || pr.Resource.Worktrees[0] != live {
		t.Fatalf("resource = %+v", pr.Resource)
	}
	if len(pr.Events) != 1 || pr.Events[0].Body != "hello" || pr.Events[0].Author != "Sam" {
		t.Fatalf("events = %+v", pr.Events)
	}
}

func TestAttentionText(t *testing.T) {
	seedAttention(t)
	out, err := runCLI(t, "attention")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if lines[0] != staleHint {
		t.Fatalf("hint not first: %q", out)
	}
	for _, want := range []string{"[1 high]", "Compliance Training", "task_due_soon", "[-]", "Fix the thing", "review_requested", "Sam: commented"} {
		if !strings.Contains(out, want) {
			t.Errorf("no %q in:\n%s", want, out)
		}
	}
}

// With no flag it covers every worktree even from inside one; --worktree .
// narrows to the current one, so the global task drops out.
func TestAttentionScope(t *testing.T) {
	live := seedAttention(t)
	t.Chdir(live)
	count := func(args ...string) int {
		t.Helper()
		out, err := runCLI(t, append([]string{"attention", "--json"}, args...)...)
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		var items []attention.Item
		decodeEnvelope(t, out, "items", &items)
		return len(items)
	}
	if got := count(); got != 2 {
		t.Errorf("no flag = %d items, want 2", got)
	}
	if got := count("--worktree", "."); got != 1 {
		t.Errorf("--worktree . = %d items, want 1", got)
	}
	if got := count("--worktree", live); got != 1 {
		t.Errorf("--worktree <path> = %d items, want 1", got)
	}
}

func TestAttentionHelpGroupAndSilence(t *testing.T) {
	if attentionCmd.GroupID != "worktree" || !attentionCmd.SilenceUsage || !attentionCmd.SilenceErrors {
		t.Fatalf("cmd = group %q, usage %v, errors %v", attentionCmd.GroupID, attentionCmd.SilenceUsage, attentionCmd.SilenceErrors)
	}
}

func TestAttentionTextShowsThreeEventsAndHeaderForms(t *testing.T) {
	rank := 2
	unranked := attention.Item{Kind: "resource", Signals: []string{},
		Resource: &attention.Resource{Type: "slack", ID: "C:1"},
		Events:   []attention.Event{},
	}
	ranked := attention.Item{Kind: "resource", Signals: []string{"ci_failing", "stale_draft"}, Rank: &rank,
		Resource: &attention.Resource{Type: "pr", ID: "o/r#1", Title: "title", CustomName: "custom"},
		Events: []attention.Event{
			{Author: "A", Title: "one", TS: "2026-11-01T00:00:00Z"}, {Title: "two"}, {Title: "three"}, {Title: "four"},
		},
	}
	named := attention.Item{Kind: "resource", Signals: []string{}, Rank: &rank,
		Resource: &attention.Resource{Type: "jira", ID: "J-1", Priority: "Major", Title: "issue"},
		Events:   []attention.Event{},
	}
	var b bytes.Buffer
	printAttention(&b, []attention.Item{ranked, named, unranked}, false)
	out := b.String()
	if strings.Contains(out, staleHint) {
		t.Fatalf("hint on fresh data: %q", out)
	}
	for _, want := range []string{"[2] ", "custom", "ci_failing, stale_draft", "A: one", "two", "three", "[2 Major] ", "[-] ", "C:1"} {
		if !strings.Contains(out, want) {
			t.Errorf("no %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "four") {
		t.Errorf("more than three events:\n%s", out)
	}
}

// unknownWorktreeErr asserts a command rejects a --worktree path no one
// registered, as an error rather than an empty result.
func unknownWorktreeErr(t *testing.T, args ...string) {
	t.Helper()
	bogus := filepath.Join(t.TempDir(), "no-such-worktree")
	out, err := runCLI(t, append(args, "--worktree", bogus)...)
	if err == nil || errors.Is(err, ErrNothingFound) {
		t.Fatalf("err = %v, want an error (exit 2)\n%s", err, out)
	}
	if want := "not a registered worktree: " + bogus; err.Error() != want {
		t.Fatalf("err = %q, want %q", err, want)
	}
	if strings.Contains(out, nothingLine) {
		t.Fatalf("printed an empty result: %q", out)
	}
}

func TestAttentionUnknownWorktreeExit2(t *testing.T) {
	stubUIProbe(t, false)
	seedReadFixture(t)
	unknownWorktreeErr(t, "attention")
	unknownWorktreeErr(t, "attention", "--json")
}

func TestActivityUnknownWorktreeExit2(t *testing.T) {
	seedReadFixture(t)
	unknownWorktreeErr(t, "activity")
	unknownWorktreeErr(t, "activity", "--unread")
}

// The check is the registry, not the filesystem. The path is canonical, as a
// real worktree's is, because a deleted path's symlinks can't be resolved.
func TestAttentionDeletedWorktreeStillWorks(t *testing.T) {
	stubUIProbe(t, false)
	seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wt, err := filepath.EvalSymlinks(testgit.Worktree(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := registry.Register(conn, registry.Entry{Path: wt, Repo: "odh", RepoRoot: "/r", Branch: "del", CreatedAt: "2026-08-14T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#9", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	ts := time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
	if _, err := conn.Exec(`INSERT INTO watcher_events (id, ts, source, type, title) VALUES ('e9',?,'github','pr_comment','c')`, ts); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`INSERT INTO watcher_event_resources (event_id, resource_type, resource_id, resource_url) VALUES ('e9','pr','o/r#9','u')`); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(wt); err != nil {
		t.Fatal(err)
	}
	out, err := runCLI(t, "attention", "--json", "--worktree", wt)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var items []attention.Item
	decodeEnvelope(t, out, "items", &items)
	if len(items) != 1 || items[0].Resource == nil || items[0].Resource.ID != "o/r#9" {
		t.Fatalf("items: %s", out)
	}
}

// A registered path reached through a symlink is the same worktree.
func TestWorktreeFlagComparesCanonically(t *testing.T) {
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(live, link); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveWorktreeFlag(conn, link); err != nil {
		t.Fatal(err)
	}
}
