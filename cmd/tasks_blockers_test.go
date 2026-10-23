package cmd

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/tasks"
)

func mustRunTasks(t *testing.T, args ...string) string {
	t.Helper()
	out, err := runTasks(t, args...)
	if err != nil {
		t.Fatalf("%v: %v\n%s", args, err, out)
	}
	return out
}

func listJSON(t *testing.T, args ...string) map[string]map[string]any {
	t.Helper()
	out := mustRunTasks(t, append([]string{"list", "--json"}, args...)...)
	var rows []map[string]any
	if err := json.Unmarshal([]byte(out), &rows); err != nil {
		t.Fatalf("list json: %v\n%s", err, out)
	}
	byID := map[string]map[string]any{}
	for _, r := range rows {
		byID[r["id"].(string)] = r
	}
	return byID
}

func strs(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

func TestTasksBlockEachKindAndShow(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	mustRunTasks(t, "add", "Main", "--global")
	mustRunTasks(t, "add", "Dep", "--global")

	// Each kind prints the new blocker's id.
	if out := strings.TrimSpace(mustRunTasks(t, "block", "T1", "--task", "T2")); out != "1" {
		t.Fatalf("block --task printed %q, want 1", out)
	}
	if out := strings.TrimSpace(mustRunTasks(t, "block", "T1", "--resource", "https://github.com/o/r/pull/4498")); out != "2" {
		t.Fatalf("block --resource printed %q, want 2", out)
	}
	out := mustRunTasks(t, "block", "T1", "--other", "legal sign-off", "--json")
	var b map[string]any
	if err := json.Unmarshal([]byte(out), &b); err != nil {
		t.Fatalf("block --json: %v\n%s", err, out)
	}
	if b["id"] != float64(3) || b["kind"] != "other" || b["label"] != "legal sign-off" || b["resolved"] != false {
		t.Fatalf("block --json = %v", b)
	}

	got := showJSON(t, "T1")
	if got["blocked"] != true || got["blocker_count"] != float64(3) {
		t.Fatalf("show blocked/count = %v %v", got["blocked"], got["blocker_count"])
	}
	if l := strs(got["blocker_labels"]); strings.Join(l, "|") != "T2 Dep|pr:o/r#4498|legal sign-off" {
		t.Fatalf("blocker_labels = %q", l)
	}
	bs := got["blockers"].([]any)
	if len(bs) != 3 {
		t.Fatalf("blockers = %v", bs)
	}
	tb, pr := bs[0].(map[string]any), bs[1].(map[string]any)
	if tb["kind"] != "task" || tb["task_id"] != "T2" || tb["manual_resolvable"] != false {
		t.Fatalf("task blocker = %v", tb)
	}
	if pr["resource_type"] != "pr" || pr["resource_id"] != "o/r#4498" || pr["url"] != "https://github.com/o/r/pull/4498" {
		t.Fatalf("pr blocker = %v", pr)
	}
	if bl, ok := got["blocks"].([]any); !ok || len(bl) != 0 {
		t.Fatalf("T1 blocks = %v, want []", got["blocks"])
	}
	dep := showJSON(t, "T2")
	if bl := dep["blocks"].([]any); len(bl) != 1 || bl[0].(map[string]any)["id"] != "T1" || bl[0].(map[string]any)["title"] != "Main" {
		t.Fatalf("T2 blocks = %v", dep["blocks"])
	}
	if bs, ok := dep["blockers"].([]any); !ok || len(bs) != 0 || dep["blocked"] != false {
		t.Fatalf("T2 blockers = %v blocked %v", dep["blockers"], dep["blocked"])
	}

	// Text output names both sides.
	text := mustRunTasks(t, "show", "T1")
	for _, want := range []string{"Blocked by:", "[ ] (#1) T2 Dep", "[ ] (#2) pr:o/r#4498", "[ ] (#3) legal sign-off"} {
		if !strings.Contains(text, want) {
			t.Errorf("show T1 missing %q:\n%s", want, text)
		}
	}
	if text := mustRunTasks(t, "show", "T2"); !strings.Contains(text, "Blocks:") || !strings.Contains(text, "T1 Main") {
		t.Errorf("show T2 missing Blocks:\n%s", text)
	}

	// The list carries the same fields.
	rows := listJSON(t, "--all")
	if r := rows["T1"]; r["blocked"] != true || r["blocker_count"] != float64(3) || len(strs(r["blocker_labels"])) != 3 {
		t.Fatalf("list T1 = %v", r)
	}
	if r := rows["T2"]; r["blocked"] != false || r["blocker_count"] != float64(0) {
		t.Fatalf("list T2 = %v", r)
	}
	if _, ok := rows["T2"]["blockers"]; ok {
		t.Fatalf("list rows must not carry blockers: %v", rows["T2"])
	}
}

func TestTasksBlockResolvesTaskKindAtOnce(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	mustRunTasks(t, "add", "Main", "--global")
	mustRunTasks(t, "add", "Dep", "--global")
	mustRunTasks(t, "state", "T2", "done")
	mustRunTasks(t, "block", "T1", "--task", "T2")
	got := showJSON(t, "T1")
	b := got["blockers"].([]any)[0].(map[string]any)
	if b["resolved"] != true || b["resolved_auto"] != true || b["resolved_reason"] != "done" || got["blocked"] != false {
		t.Fatalf("blocker = %v, blocked %v", b, got["blocked"])
	}
	// And a later CLI state change resolves at once too.
	mustRunTasks(t, "state", "T2", "in_progress")
	if showJSON(t, "T1")["blocked"] != true {
		t.Fatal("reopening the blocking task did not re-block")
	}
	mustRunTasks(t, "state", "T2", "done")
	if showJSON(t, "T1")["blocked"] != false {
		t.Fatal("finishing the blocking task did not unblock")
	}
}

func TestTasksUnblockAndResolve(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	mustRunTasks(t, "add", "Main", "--global")
	mustRunTasks(t, "block", "T1", "--other", "legal")
	mustRunTasks(t, "block", "T1", "--resource", "pr:o/r#1")

	if out := mustRunTasks(t, "resolve", "1"); strings.TrimSpace(out) != "resolved blocker 1" {
		t.Fatalf("resolve printed %q", out)
	}
	if got := showJSON(t, "T1"); got["blocker_count"] != float64(1) {
		t.Fatalf("after resolve, count = %v", got["blocker_count"])
	}
	out := mustRunTasks(t, "resolve", "1", "--unresolve", "--json")
	var r map[string]any
	_ = json.Unmarshal([]byte(out), &r)
	if r["id"] != float64(1) || r["resolved"] != false {
		t.Fatalf("resolve --unresolve --json = %s", out)
	}
	if got := showJSON(t, "T1"); got["blocker_count"] != float64(2) {
		t.Fatalf("after unresolve, count = %v", got["blocker_count"])
	}
	// Any other URL is a link blocker, resolved by hand.
	mustRunTasks(t, "block", "T1", "--resource", "https://example.com/doc")
	if got := showJSON(t, "T1")["blockers"].([]any); got[2].(map[string]any)["resource_type"] != "link" ||
		got[2].(map[string]any)["manual_resolvable"] != true {
		t.Fatalf("link blocker = %v", got[2])
	}
	mustRunTasks(t, "unblock", "3")
	// A PR blocker is the resolver's, not the user's.
	if _, err := runTasks(t, "resolve", "2"); err == nil || !strings.Contains(err.Error(), "resolved by hand") {
		t.Fatalf("resolve pr = %v", err)
	}

	if out := mustRunTasks(t, "unblock", "1"); strings.TrimSpace(out) != "removed blocker 1" {
		t.Fatalf("unblock printed %q", out)
	}
	out = mustRunTasks(t, "unblock", "2", "--json")
	if !strings.Contains(out, `"removed":true`) {
		t.Fatalf("unblock --json = %s", out)
	}
	if got := showJSON(t, "T1"); len(got["blockers"].([]any)) != 0 || got["blocked"] != false {
		t.Fatalf("after unblock = %v", got)
	}
}

func TestTasksBlockErrors(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	mustRunTasks(t, "add", "Main", "--global")
	mustRunTasks(t, "add", "Dep", "--global")
	mustRunTasks(t, "block", "T1", "--task", "T2")
	cases := []struct {
		want string
		args []string
	}{
		{"pass exactly one of --task, --resource or --other", []string{"block", "T1"}},
		{"pass exactly one of --task, --resource or --other", []string{"block", "T1", "--task", "T2", "--other", "x"}},
		{"would create a blocking cycle", []string{"block", "T2", "--task", "T1"}},
		{"task T9 not found", []string{"block", "T9", "--other", "x"}},
		{"a blocker's resource must be a URL or <type>:<id>, not a worktree", []string{"block", "T1", "--resource", "wt:/x"}},
		{"invalid link", []string{"block", "T1", "--resource", "nonsense"}},
		{"blocker 99 not found", []string{"unblock", "99"}},
		{"blocker 99 not found", []string{"resolve", "99"}},
		{"invalid blocker id", []string{"unblock", "x"}},
	}
	for _, c := range cases {
		_, err := runTasks(t, c.args...)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: got %v, want %q", c.args, err, c.want)
		}
	}
}

// A done task is never blocked, in the CLI as in the web UI.
func TestTasksDoneTaskShowsUnblocked(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	mustRunTasks(t, "add", "Main", "--global")
	mustRunTasks(t, "block", "T1", "--other", "legal")
	mustRunTasks(t, "state", "T1", "done")
	got := showJSON(t, "T1")
	if got["blocked"] != false || got["blocker_count"] != float64(0) || len(strs2(got["blocker_labels"])) != 0 {
		t.Fatalf("done task = blocked %v count %v labels %v", got["blocked"], got["blocker_count"], got["blocker_labels"])
	}
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if bs, _ := tasks.Blockers(conn, 1); len(bs) != 1 {
		t.Fatalf("blockers = %+v", bs)
	}
}

// strs2 is strs that also accepts an empty array.
func strs2(v any) []string {
	a, _ := v.([]any)
	out := []string{}
	for _, x := range a {
		out = append(out, x.(string))
	}
	return out
}
