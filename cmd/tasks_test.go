package cmd

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
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

func showJSON(t *testing.T, id string) map[string]any {
	t.Helper()
	out, err := runTasks(t, "show", id, "--json")
	if err != nil {
		t.Fatalf("show %s: %v\n%s", id, err, out)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("show json: %v\n%s", err, out)
	}
	return got
}

func TestTasksLinkFocusMoveCLI(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	for _, title := range []string{"A", "B"} {
		if out, err := runTasks(t, "add", title, "--global"); err != nil {
			t.Fatalf("add: %v\n%s", err, out)
		}
	}
	if out, err := runTasks(t, "link", "T1", "jira:RH-1"); err != nil {
		t.Fatalf("link: %v\n%s", err, out)
	}
	if l := showJSON(t, "T1")["links"].([]any); len(l) != 1 || l[0].(map[string]any)["focus"] != false {
		t.Fatalf("links after link = %v", l)
	}
	if out, err := runTasks(t, "focus", "T1", "jira:RH-1"); err != nil {
		t.Fatalf("focus: %v\n%s", err, out)
	}
	if l := showJSON(t, "T1")["links"].([]any); l[0].(map[string]any)["focus"] != true {
		t.Fatalf("links after focus = %v", l)
	}
	if out, err := runTasks(t, "unfocus", "T1", "jira:RH-1"); err != nil {
		t.Fatalf("unfocus: %v\n%s", err, out)
	}
	if l := showJSON(t, "T1")["links"].([]any); l[0].(map[string]any)["focus"] != false {
		t.Fatalf("links after unfocus = %v", l)
	}
	if out, err := runTasks(t, "link", "T1", "jira:RH-2", "--focus"); err != nil {
		t.Fatalf("link --focus: %v\n%s", err, out)
	}
	if out, err := runTasks(t, "unlink", "T1", "jira:RH-2"); err != nil {
		t.Fatalf("unlink: %v\n%s", err, out)
	}
	if l := showJSON(t, "T1")["links"].([]any); len(l) != 1 {
		t.Fatalf("links after unlink = %v", l)
	}

	if out, err := runTasks(t, "move", "T2", "--top"); err != nil {
		t.Fatalf("move: %v\n%s", err, out)
	}
	out, _ := runTasks(t, "list", "--all", "--json")
	var list []map[string]any
	_ = json.Unmarshal([]byte(out), &list)
	if len(list) != 2 || list[0]["id"] != "T2" || list[1]["id"] != "T1" {
		t.Fatalf("order = %v", list)
	}
	if _, err := runTasks(t, "move", "T1", "--after", "T2"); err != nil {
		t.Fatalf("move after: %v", err)
	}
	if _, err := runTasks(t, "move", "T1", "--before", "T2"); err != nil {
		t.Fatalf("move before: %v", err)
	}
	if _, err := runTasks(t, "move", "T1", "--bottom"); err != nil {
		t.Fatalf("move bottom: %v", err)
	}
	if _, err := runTasks(t, "move", "T1", "--top", "--bottom"); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("two flags: %v", err)
	}
	if _, err := runTasks(t, "move", "T1"); err == nil || !strings.Contains(err.Error(), "exactly one") {
		t.Fatalf("no flags: %v", err)
	}
}

func TestTasksSubtaskCLI(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	if out, err := runTasks(t, "add", "A", "--global"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	out, err := runTasks(t, "subtask", "add", "T1", "a")
	if err != nil {
		t.Fatalf("subtask add: %v\n%s", err, out)
	}
	aID := strings.TrimSpace(out)
	if aID != "1" {
		t.Fatalf("subtask id output = %q", out)
	}
	out, err = runTasks(t, "subtask", "add", "T1", "b", "--json")
	if err != nil {
		t.Fatalf("subtask add: %v\n%s", err, out)
	}
	var added map[string]any
	_ = json.Unmarshal([]byte(out), &added)
	f, _ := added["id"].(float64)
	bID := strconv.FormatInt(int64(f), 10)
	if _, err := runTasks(t, "subtask", "check", aID); err != nil {
		t.Fatalf("check: %v", err)
	}
	st := showJSON(t, "T1")["subtasks"].([]any)
	if len(st) != 2 || st[0].(map[string]any)["text"] != "a" || st[0].(map[string]any)["checked"] != true ||
		st[1].(map[string]any)["checked"] != false {
		t.Fatalf("subtasks = %v", st)
	}
	if _, err := runTasks(t, "subtask", "uncheck", aID); err != nil {
		t.Fatalf("uncheck: %v", err)
	}
	if _, err := runTasks(t, "subtask", "edit", aID, "a2"); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if _, err := runTasks(t, "subtask", "order", "T1", bID, aID); err != nil {
		t.Fatalf("order: %v", err)
	}
	st = showJSON(t, "T1")["subtasks"].([]any)
	if st[0].(map[string]any)["text"] != "b" || st[1].(map[string]any)["text"] != "a2" {
		t.Fatalf("after order = %v", st)
	}
	if _, err := runTasks(t, "subtask", "remove", bID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if st = showJSON(t, "T1")["subtasks"].([]any); len(st) != 1 {
		t.Fatalf("after remove = %v", st)
	}
}

func TestTasksNotFoundMessages(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	if out, err := runTasks(t, "add", "A", "--global"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	cases := []struct {
		want string
		args []string
	}{
		{"task T1 has no link jira:X-9", []string{"unlink", "T1", "jira:X-9"}},
		{"task T1 has no link jira:X-9", []string{"focus", "T1", "jira:X-9"}},
		{"task T1 has no link jira:X-9", []string{"unfocus", "T1", "jira:X-9"}},
		{"task T5 not found", []string{"unlink", "T5", "jira:X-9"}},
		{"task T5 not found", []string{"link", "T5", "jira:X-9"}},
		{"task T5 not found", []string{"subtask", "add", "T5", "x"}},
		{"task T5 not found", []string{"move", "T5", "--top"}},
		{"subtask 99 not found", []string{"subtask", "check", "99"}},
		{"subtask 99 not found", []string{"subtask", "uncheck", "99"}},
		{"subtask 99 not found", []string{"subtask", "edit", "99", "x"}},
		{"subtask 99 not found", []string{"subtask", "remove", "99"}},
	}
	for _, c := range cases {
		_, err := runTasks(t, c.args...)
		if err == nil || err.Error() != c.want {
			t.Errorf("%v: got %v, want %q", c.args, err, c.want)
		}
	}
}

func registerTempWorktree(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := registry.Register(conn, registry.Entry{Path: dir, Repo: "r", RepoRoot: dir, Branch: "b"}); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	return canonicalWorktree(dir)
}

func TestTasksDefaultContextInRegisteredWorktree(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	wt := registerTempWorktree(t)

	if out, err := runTasks(t, "add", "linked"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	if out, err := runTasks(t, "add", "global", "--global"); err != nil {
		t.Fatalf("add --global: %v\n%s", err, out)
	}
	links := showJSON(t, "T1")["links"].([]any)
	if len(links) != 1 {
		t.Fatalf("T1 links = %v", links)
	}
	l := links[0].(map[string]any)
	if l["kind"] != "worktree" || l["worktree"] != wt || l["focus"] != true {
		t.Fatalf("T1 link = %v, want Focus wt:%s", l, wt)
	}
	if l := showJSON(t, "T2")["links"].([]any); len(l) != 0 {
		t.Fatalf("--global should not link: %v", l)
	}

	out, err := runTasks(t, "list", "--json")
	if err != nil {
		t.Fatalf("list: %v\n%s", err, out)
	}
	var list []map[string]any
	_ = json.Unmarshal([]byte(out), &list)
	if len(list) != 1 || list[0]["id"] != "T1" {
		t.Fatalf("default list should be scoped to the worktree: %v", list)
	}
	out, _ = runTasks(t, "list", "--all", "--json")
	_ = json.Unmarshal([]byte(out), &list)
	if len(list) != 2 {
		t.Fatalf("--all list = %v", list)
	}
}

// listIDs runs `tasks list --all --json` with extra args and returns the
// listed IDs in order.
func listIDs(t *testing.T, args ...string) []string {
	t.Helper()
	out, err := runTasks(t, append([]string{"list", "--all", "--json"}, args...)...)
	if err != nil {
		t.Fatalf("list %v: %v\n%s", args, err, out)
	}
	var list []map[string]any
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		t.Fatalf("list json: %v\n%s", err, out)
	}
	ids := []string{}
	for _, r := range list {
		ids = append(ids, r["id"].(string))
	}
	return ids
}

func TestTasksListStateArchivedAndPriorityFlags(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	// T1 open; T2 in progress; T3 done and global; T4 done with only an
	// unfollowed (so archived) link.
	steps := [][]string{
		{"add", "open", "--global", "--priority", "high"},
		{"add", "doing", "--global"},
		{"add", "done", "--global"},
		{"add", "archived", "--focus", "jira:X-1"},
		{"state", "T2", "in_progress"},
		{"state", "T3", "done"},
		{"state", "T4", "done"},
	}
	for _, s := range steps {
		if out, err := runTasks(t, s...); err != nil {
			t.Fatalf("%v: %v\n%s", s, err, out)
		}
	}
	cases := []struct {
		args []string
		want string
	}{
		{nil, "T1,T2"},
		{[]string{"--completed"}, "T1,T2,T3"},
		{[]string{"--archived"}, "T1,T2,T3,T4"},
		{[]string{"--state", "in_progress"}, "T2"},
		{[]string{"--state", "not_started", "--state", "in_progress"}, "T1,T2"},
		{[]string{"--state", "done"}, "T3"},
		{[]string{"--state", "done", "--archived"}, "T3,T4"},
		{[]string{"--priority", "high"}, "T1"},
	}
	for _, c := range cases {
		if got := strings.Join(listIDs(t, c.args...), ","); got != c.want {
			t.Errorf("list %v = %s, want %s", c.args, got, c.want)
		}
	}
	for _, bad := range [][]string{{"--priority", "hgh"}, {"--state", "finished"}} {
		if out, err := runTasks(t, append([]string{"list", "--all"}, bad...)...); err == nil {
			t.Errorf("list %v should fail; got\n%s", bad, out)
		}
	}
}

func TestTasksShowPrintsSubtaskIDs(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	for _, s := range [][]string{
		{"add", "A", "--global"},
		{"subtask", "add", "T1", "first"},
		{"subtask", "add", "T1", "second"},
		{"subtask", "check", "2"},
	} {
		if out, err := runTasks(t, s...); err != nil {
			t.Fatalf("%v: %v\n%s", s, err, out)
		}
	}
	out, err := runTasks(t, "show", "T1")
	if err != nil {
		t.Fatalf("show: %v\n%s", err, out)
	}
	for _, want := range []string{"[ ] (#1) first", "[x] (#2) second"} {
		if !strings.Contains(out, want) {
			t.Errorf("show output missing %q:\n%s", want, out)
		}
	}
}
