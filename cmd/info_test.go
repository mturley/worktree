package cmd

import (
	"path/filepath"
	"strings"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
)

func TestResolveWorktreePathRejectsEmpty(t *testing.T) {
	for _, arg := range []string{"", "  "} {
		if p, err := resolveWorktreePath([]string{arg}); err == nil {
			t.Fatalf("resolveWorktreePath(%q) = %q, want an error", arg, p)
		}
	}
}

func TestResolveWorktreePathMakesAbsolute(t *testing.T) {
	p, err := resolveWorktreePath([]string{"some/wt"})
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(p) || filepath.Base(p) != "wt" {
		t.Fatalf("resolveWorktreePath = %q, want an absolute path ending in wt", p)
	}
}

func TestInfoJSONCachedState(t *testing.T) {
	live, _ := seedReadFixture(t)
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := resources.Add(conn, live, resources.Resource{Type: "jira", ID: "J-1", URL: "u1"}); err != nil {
		t.Fatal(err)
	}
	if err := watcherdb.UpsertResourceState(conn, "jira", "J-1",
		`{"summary":"S","status":"In Progress","priority":"Critical"}`, "2026-08-13T00:00:00Z", "2026-08-13T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	conn.Close()

	out, err := runCLI(t, "info", live, "--json")
	if err != nil {
		t.Fatalf("info --json: %v\n%s", err, out)
	}
	var wt struct {
		Path      string            `json:"path"`
		Branch    string            `json:"branch"`
		Env       map[string]string `json:"env"`
		Resources []map[string]any  `json:"resources"`
	}
	decodeEnvelope(t, out, "worktree", &wt)
	if wt.Path != live || wt.Branch == "" || wt.Env["WORKTREE_PATH"] != live {
		t.Fatalf("worktree = %+v", wt)
	}
	if len(wt.Resources) != 1 || wt.Resources[0]["priority"] != "Critical" {
		t.Fatalf("resources = %+v", wt.Resources)
	}

	// Text output shows the cached state after the id.
	text, err := runCLI(t, "info", live)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "Critical") || !strings.Contains(text, "In Progress") {
		t.Fatalf("text info lacks cached jira state:\n%s", text)
	}
}

func TestInfoJSONMissingWorktree(t *testing.T) {
	_, gone := seedReadFixture(t)
	out, err := runCLI(t, "info", gone, "--json")
	if err != nil {
		t.Fatalf("info on a worktree that is not on disk must succeed: %v\n%s", err, out)
	}
	var wt map[string]any
	decodeEnvelope(t, out, "worktree", &wt)
	for _, k := range []string{"branch", "upstream", "ahead", "behind"} {
		if _, ok := wt[k]; ok {
			t.Fatalf("%s must be omitted when not on disk: %v", k, wt)
		}
	}
}

func TestJiraJSONUsesCachedStateOnly(t *testing.T) {
	live, _ := seedReadFixture(t)
	// No Jira credentials anywhere: the command must still work.
	t.Setenv("WATCHER_HOME", t.TempDir())
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range []resources.Resource{
		{Type: "jira", ID: "J-1", URL: "u1"},
		{Type: "pr", ID: "o/r#1", URL: "u2"},
	} {
		if err := resources.Add(conn, live, r); err != nil {
			t.Fatal(err)
		}
	}
	if err := watcherdb.UpsertResourceState(conn, "jira", "J-1",
		`{"summary":"Fix it","status":"Open","priority":"High"}`, "2026-08-13T00:00:00Z", "2026-08-13T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	conn.Close()

	out, err := runCLI(t, "jira", live, "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var got []map[string]any
	decodeEnvelope(t, out, "issues", &got)
	if len(got) != 1 || got[0]["id"] != "J-1" || got[0]["priority"] != "High" {
		t.Fatalf("issues = %v", got)
	}
	text, err := runCLI(t, "jira", live)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "J-1") || !strings.Contains(text, "Open") || !strings.Contains(text, "Fix it") {
		t.Fatalf("text = %q", text)
	}
}

// A DB failure is not "no resources": info reports it.
func TestInfoReportsDBFailures(t *testing.T) {
	for _, table := range []string{"watcher_subscriptions", "worktrees"} {
		t.Run(table, func(t *testing.T) {
			live, _ := seedReadFixture(t)
			conn, err := wdb.Open()
			if err != nil {
				t.Fatal(err)
			}
			if _, err := conn.Exec(`DROP TABLE ` + table); err != nil {
				t.Fatal(err)
			}
			conn.Close()
			for _, args := range [][]string{{"info", live, "--json"}, {"info", live}} {
				out, err := runCLI(t, args...)
				if err == nil || !strings.Contains(err.Error(), "no such table") {
					t.Errorf("%v: err = %v, want the DB failure\n%s", args, err, out)
				}
			}
		})
	}
}

// Bare `worktree` shows help above the info, and help still has to work
// with no DB at all.
func TestBareWorktreeSurvivesAnInfoFailure(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "absent.db"))
	r := runCLIProcess(t, t.TempDir(), nil)
	if r.code != 0 {
		t.Fatalf("exit %d, stderr: %s", r.code, r.stderr)
	}
	if !strings.Contains(r.stdout, "Usage:") {
		t.Errorf("no help in: %s", r.stdout)
	}
}
