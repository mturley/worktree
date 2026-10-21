package cmd

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/tasks"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

func TestActorFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	cases := []struct {
		name    string
		asAgent bool
		env     map[string]string
		want    tasks.Actor
	}{
		{"plain user", false, map[string]string{}, tasks.Actor{Kind: tasks.ActorUser}},
		{"claude code", false, map[string]string{"CLAUDECODE": "1"}, tasks.Actor{Kind: tasks.ActorAgent}},
		{"handler session", false, map[string]string{"HANDLER_SESSION_ID": "abc"}, tasks.Actor{Kind: tasks.ActorAgent, Session: "abc"}},
		{"both", false, map[string]string{"CLAUDECODE": "1", "HANDLER_SESSION_ID": "abc"}, tasks.Actor{Kind: tasks.ActorAgent, Session: "abc"}},
		{"as-agent flag", true, map[string]string{}, tasks.Actor{Kind: tasks.ActorAgent}},
	}
	for _, c := range cases {
		if got := actorFromEnv(c.asAgent, env(c.env)); got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestParseTaskID(t *testing.T) {
	for _, s := range []string{"T42", "t42", "42"} {
		got, err := parseTaskID(s)
		if err != nil || got != 42 {
			t.Errorf("parseTaskID(%q) = %d, %v; want 42", s, got, err)
		}
	}
	for _, s := range []string{"", "T", "x1", "-3", "T-3", "0", "T4x"} {
		if _, err := parseTaskID(s); err == nil {
			t.Errorf("parseTaskID(%q) should fail", s)
		}
	}
	if formatTaskID(42) != "T42" {
		t.Errorf("formatTaskID(42) = %q", formatTaskID(42))
	}
}

func TestParseLinkRef(t *testing.T) {
	got, err := parseLinkRef("https://github.com/o/r/pull/1")
	if err != nil || got.Kind != tasks.LinkResource || got.ResourceType != "pr" || got.ResourceID == "" {
		t.Errorf("pr url: %+v, %v", got, err)
	}
	got, err = parseLinkRef("jira:RHOAIENG-1")
	if err != nil || got != (tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: "jira", ResourceID: "RHOAIENG-1"}) {
		t.Errorf("jira ref: %+v, %v", got, err)
	}
	got, err = parseLinkRef("slack:C069KSM8T9N:1787257539.775119")
	if err != nil || got.ResourceType != "slack" || got.ResourceID != "C069KSM8T9N:1787257539.775119" {
		t.Errorf("slack ref: %+v, %v", got, err)
	}
	got, err = parseLinkRef("wt:/tmp/x")
	if err != nil || got != (tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: "/tmp/x"}) {
		t.Errorf("wt ref: %+v, %v", got, err)
	}
	for _, s := range []string{"nonsense", "", "jira:", ":x", "wt:"} {
		if _, err := parseLinkRef(s); err == nil {
			t.Errorf("parseLinkRef(%q) should fail", s)
		}
	}
}

func TestTaskJSONContract(t *testing.T) {
	task := tasks.Task{
		ID: 7, Title: "t", State: tasks.StateNotStarted, Priority: tasks.PriorityNone,
		CreatedAt: "2026-10-21T00:00:00Z", UpdatedAt: "2026-10-21T00:00:00Z",
	}
	b, err := json.Marshal(toTaskJSON(task))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got["id"] != "T7" {
		t.Errorf("id = %v", got["id"])
	}
	for _, k := range []string{"links", "implicit_worktrees", "subtasks"} {
		if arr, ok := got[k].([]any); !ok || len(arr) != 0 {
			t.Errorf("%s = %#v, want []", k, got[k])
		}
	}
	var keys []string
	for k := range got {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := []string{"archived", "created_at", "description", "id", "implicit_worktrees", "links",
		"priority", "starred", "state", "subtasks", "title", "updated_at"}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Errorf("keys = %v\nwant   %v", keys, want)
	}
}

func TestTaskJSONLinksAndSubtasks(t *testing.T) {
	task := tasks.Task{
		ID: 1, Due: "2026-10-24", StartedAt: "2026-10-21T00:00:00Z",
		Links: []tasks.Link{
			{ID: 1, LinkTarget: tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: "pr", ResourceID: "o/r#1"}, Primary: true},
			{ID: 2, LinkTarget: tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: "/w/a"}, Archived: true},
		},
		Implicit: []string{"/w/b"},
		Subtasks: []tasks.Subtask{{ID: 3, TaskID: 1, Text: "s", Checked: true, Position: 0}},
	}
	b, _ := json.Marshal(toTaskJSON(task))
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if got["due"] != "2026-10-24" || got["started_at"] == nil {
		t.Errorf("due/started_at: %v", got)
	}
	if _, ok := got["completed_at"]; ok {
		t.Errorf("completed_at should be omitted")
	}
	links := got["links"].([]any)
	l0 := links[0].(map[string]any)
	if l0["kind"] != "resource" || l0["resource_type"] != "pr" || l0["focus"] != true || l0["archived"] != false {
		t.Errorf("link0 = %v", l0)
	}
	if _, ok := l0["worktree"]; ok {
		t.Errorf("link0 should omit worktree: %v", l0)
	}
	l1 := links[1].(map[string]any)
	if l1["worktree"] != "/w/a" || l1["focus"] != false || l1["archived"] != true {
		t.Errorf("link1 = %v", l1)
	}
	st := got["subtasks"].([]any)[0].(map[string]any)
	if len(st) != 3 || st["text"] != "s" || st["checked"] != true || st["id"] != float64(3) {
		t.Errorf("subtask = %v", st)
	}
}

func TestTaskLine(t *testing.T) {
	task := tasks.Task{
		ID: 42, Title: "Title", State: tasks.StateInProgress, Priority: tasks.PriorityHigh, Starred: true,
		Due: "2026-10-24",
		Links: []tasks.Link{
			{LinkTarget: tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: "jira", ResourceID: "X-1"}},
			{LinkTarget: tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: "pr", ResourceID: "o/r#1"}, Primary: true},
			{LinkTarget: tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: "/w/feat"}},
		},
		Subtasks: []tasks.Subtask{{Checked: true}, {Checked: true}, {}, {}, {}},
	}
	want := "T42 ◩ ★ !!! Title  [due 2026-10-24] [2/5] [pr:o/r#1 +2]"
	if got := taskLine(task); got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}

	plain := tasks.Task{ID: 1, Title: "Plain", State: tasks.StateNotStarted, Priority: tasks.PriorityNone}
	if got := taskLine(plain); got != "T1 ☐       Plain" {
		t.Errorf("plain: %q", got)
	}

	related := tasks.Task{ID: 2, Title: "R", State: tasks.StateDone, Priority: tasks.PriorityLow,
		Links: []tasks.Link{
			{LinkTarget: tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: "/w/a"}},
			{LinkTarget: tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: "jira", ResourceID: "X-1"}},
		}}
	if got := taskLine(related); got != "T2 ☑   !   R  [2 linked]" {
		t.Errorf("related: %q", got)
	}

	wtFocus := tasks.Task{ID: 3, Title: "W", State: tasks.StateNotStarted, Priority: tasks.PriorityMedium,
		Links: []tasks.Link{{LinkTarget: tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: "/w/feat"}, Primary: true}}}
	if got := taskLine(wtFocus); got != "T3 ☐   !!  W  [wt:feat]" {
		t.Errorf("wt focus: %q", got)
	}
}

// resetTasksFlags returns every tasks flag to its default so one in-process
// rootCmd run cannot leak a flag into the next.
func resetTasksFlags(t *testing.T) {
	t.Helper()
	for _, c := range append([]*cobra.Command{tasksCmd}, tasksCmd.Commands()...) {
		for _, fs := range []*pflag.FlagSet{c.Flags(), c.PersistentFlags()} {
			fs.VisitAll(func(f *pflag.Flag) {
				if sv, ok := f.Value.(pflag.SliceValue); ok {
					_ = sv.Replace(nil)
				} else {
					_ = f.Value.Set(f.DefValue)
				}
				f.Changed = false
			})
		}
	}
}

func runTasks(t *testing.T, args ...string) (string, error) {
	t.Helper()
	resetTasksFlags(t)
	var out bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&out)
	rootCmd.SetArgs(append([]string{"tasks"}, args...))
	err := rootCmd.Execute()
	rootCmd.SetOut(nil)
	rootCmd.SetErr(nil)
	rootCmd.SetArgs(nil)
	return out.String(), err
}

func TestTasksAddListShowRoundTrip(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))

	out, err := runTasks(t, "add", "Write repro", "--priority", "high", "--star", "--global", "--json")
	if err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	var added map[string]any
	if err := json.Unmarshal([]byte(out), &added); err != nil {
		t.Fatalf("add json: %v\n%s", err, out)
	}
	if added["id"] != "T1" {
		t.Fatalf("added id = %v", added["id"])
	}

	out, err = runTasks(t, "list", "--all", "--json")
	if err != nil {
		t.Fatalf("list: %v\n%s", err, out)
	}
	var list []map[string]any
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		t.Fatalf("list json: %v\n%s", err, out)
	}
	if len(list) != 1 || list[0]["priority"] != "high" || list[0]["starred"] != true || list[0]["title"] != "Write repro" {
		t.Fatalf("list = %v", list)
	}

	out, err = runTasks(t, "show", "T1", "--json")
	if err != nil {
		t.Fatalf("show: %v\n%s", err, out)
	}
	var shown map[string]any
	if err := json.Unmarshal([]byte(out), &shown); err != nil {
		t.Fatalf("show json: %v\n%s", err, out)
	}
	events, ok := shown["events"].([]any)
	if !ok || len(events) == 0 || events[0].(map[string]any)["type"] != "task_created" {
		t.Fatalf("events = %v", shown["events"])
	}
}

func TestTasksEditStateStarDelete(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	if out, err := runTasks(t, "add", "A", "--global", "--due", "2026-10-24", "--focus", "jira:X-1"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	steps := [][]string{
		{"edit", "t1", "--title", "B", "--due", ""},
		{"state", "1", "in_progress"},
		{"star", "T1"},
	}
	for _, s := range steps {
		if out, err := runTasks(t, s...); err != nil {
			t.Fatalf("%v: %v\n%s", s, err, out)
		}
	}
	out, err := runTasks(t, "show", "T1", "--json")
	if err != nil {
		t.Fatalf("show: %v", err)
	}
	var got map[string]any
	_ = json.Unmarshal([]byte(out), &got)
	if got["title"] != "B" || got["state"] != "in_progress" || got["starred"] != true || got["priority"] != "none" {
		t.Fatalf("after edits: %v", got)
	}
	if _, ok := got["due"]; ok {
		t.Fatalf("due should be cleared: %v", got["due"])
	}
	links := got["links"].([]any)
	if len(links) != 1 || links[0].(map[string]any)["focus"] != true {
		t.Fatalf("links = %v", links)
	}

	if out, err := runTasks(t, "unstar", "T1"); err != nil {
		t.Fatalf("unstar: %v\n%s", err, out)
	}
	if _, err := runTasks(t, "state", "T1", "bogus"); err == nil {
		t.Fatal("bogus state should fail")
	}
	if out, err := runTasks(t, "delete", "T1"); err != nil {
		t.Fatalf("delete: %v\n%s", err, out)
	}
	_, err = runTasks(t, "show", "T1")
	if err == nil || err.Error() != "task T1 not found" {
		t.Fatalf("show deleted: %v", err)
	}
}
