package cmd

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/ui"
	"github.com/mturley/worktree/internal/worktreenew"
)

func TestBuildWorkspaceURLs_PRThenJira(t *testing.T) {
	res := []resources.Resource{
		{Type: "jira", ID: "X-1", URL: "https://jira/X-1"},
		{Type: "pr", ID: "o/r#1", URL: "https://gh/pr/1"},
	}
	assertURLs(t, buildWorkspaceURLs(res), []string{"https://gh/pr/1", "https://jira/X-1"})
}

func TestBuildWorkspaceURLs_SkipsRelatedJiraAndEmptyURLs(t *testing.T) {
	res := []resources.Resource{
		{Type: "jira", ID: "X-2", URL: "https://jira/X-2", Related: true},
		{Type: "jira", ID: "X-1", URL: "https://jira/X-1"},
		{Type: "pr", ID: "o/r#1", URL: ""},
		{Type: "slack", ID: "C1:1.2", URL: "https://slack/t"},
	}
	assertURLs(t, buildWorkspaceURLs(res), []string{"https://jira/X-1"})
}

func TestBuildWorkspaceURLs_Empty(t *testing.T) {
	if got := buildWorkspaceURLs(nil); len(got) != 0 {
		t.Fatalf("got %v, want empty", got)
	}
}

func assertURLs(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// TestAnswerConfirmDeclinedResetReplays is the CLI half of the guard against
// stranding a worktree. The runner has already created the directory when it
// asks about resetting to the PR head, so a "no" must carry DeclineReset into
// a replay — never return out of runCreate, which would leave the worktree
// unregistered and without a port range.
func TestAnswerConfirmDeclinedResetReplays(t *testing.T) {
	var opts worktreenew.Options
	proceed := answerConfirm(&worktreenew.Confirm{Key: worktreenew.ConfirmResetToPR}, false, &opts)

	if !proceed {
		t.Fatal("declining the reset aborted the run — the worktree would be stranded")
	}
	if !opts.DeclineReset {
		t.Fatal("DeclineReset not set — the replay would ask the same question forever")
	}
	if opts.ResetToPR {
		t.Fatal("ResetToPR set despite the user declining")
	}
}

func TestAnswerConfirmAcceptedResetSetsTheFlag(t *testing.T) {
	var opts worktreenew.Options
	if !answerConfirm(&worktreenew.Confirm{Key: worktreenew.ConfirmResetToPR}, true, &opts) {
		t.Fatal("accepting the reset aborted the run")
	}
	if !opts.ResetToPR || opts.DeclineReset {
		t.Fatalf("opts = %+v, want ResetToPR only", opts)
	}
}

// TestAnswerConfirmDeclinedReuseAborts is the other side of the asymmetry:
// nothing has been created when the reuse question is asked, so "no" is a
// legitimate abort.
func TestAnswerConfirmDeclinedReuseAborts(t *testing.T) {
	var opts worktreenew.Options
	if answerConfirm(&worktreenew.Confirm{Key: worktreenew.ConfirmReuseBranch}, false, &opts) {
		t.Fatal("declining branch reuse should abort — no worktree exists yet")
	}
	if opts.ReuseBranch {
		t.Fatal("ReuseBranch set despite the user declining")
	}
}

func TestAnswerConfirmAcceptedReuseSetsTheFlag(t *testing.T) {
	var opts worktreenew.Options
	if !answerConfirm(&worktreenew.Confirm{Key: worktreenew.ConfirmReuseBranch}, true, &opts) {
		t.Fatal("accepting branch reuse aborted the run")
	}
	if !opts.ReuseBranch {
		t.Fatal("ReuseBranch not set")
	}
}

func TestCdHintUsesShortPath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	got := cdHint(filepath.Join(home, ".worktrees", "my-branch"))
	if !strings.Contains(got, "cd ~/.worktrees/my-branch") {
		t.Fatalf("cdHint() = %q, want it to contain cd ~/.worktrees/my-branch", got)
	}
}

func TestCdHintKeepsPathsOutsideHomeAbsolute(t *testing.T) {
	got := cdHint("/srv/worktrees/my-branch")
	if !strings.Contains(got, "cd /srv/worktrees/my-branch") {
		t.Fatalf("cdHint() = %q, want it to contain cd /srv/worktrees/my-branch", got)
	}
}

// Not parallel: swaps os.Stdout and the ui color switch.
func TestListOutputHasNoEscapesWhenPiped(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	t.Setenv("NO_COLOR", "")
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	err = registry.Register(conn, registry.Entry{
		Path: filepath.Join(t.TempDir(), "gone"), Repo: "repo", RepoRoot: "/r", Branch: "b", CreatedAt: "2026-01-01T00:00:00Z",
	})
	conn.Close()
	if err != nil {
		t.Fatal(err)
	}

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdout := os.Stdout
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = oldStdout; ui.SetColor(true) })

	rootCmd.PersistentPreRun(rootCmd, nil)
	runErr := runList(listCmd, nil)
	w.Close()
	os.Stdout = oldStdout
	out, _ := io.ReadAll(r)
	if runErr != nil {
		t.Fatal(runErr)
	}
	if !bytes.Contains(out, []byte("repo")) {
		t.Fatalf("list printed no entries: %q", out)
	}
	if bytes.Contains(out, []byte("\x1b[")) {
		t.Fatalf("piped list output has ANSI escapes: %q", out)
	}
}

// Cobra skips PersistentPreRun for --help, so color has to be decided before
// it runs. A subprocess, because only Execute does that and stdout must really
// be a pipe.
func TestHelpHasNoEscapesWhenPiped(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	for _, tt := range []struct {
		name string
		env  []string
		args []string
	}{
		{"piped", nil, []string{"--help"}},
		{"NO_COLOR", []string{"NO_COLOR=1"}, []string{"--help"}},
		{"subcommand", nil, []string{"list", "--help"}},
		{"bad flag", nil, []string{"--nope"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := runCLIProcess(t, t.TempDir(), tt.env, tt.args...)
			if strings.Contains(r.stdout+r.stderr, "\x1b[") {
				t.Errorf("output has ANSI escapes: %q", r.stdout+r.stderr)
			}
		})
	}
}

// Each error reaches stderr exactly once, from exitCode: no "Error:" copy from
// cobra and no usage dump.
func TestErrorsPrintOnce(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "absent.db"))
	for _, tt := range []struct {
		name string
		args []string
		want string
	}{
		{"status", []string{"status"}, wdb.ErrNoDatabase.Error()},
		{"list", []string{"list"}, wdb.ErrNoDatabase.Error()},
		{"info", []string{"info", "/nope"}, wdb.ErrNoDatabase.Error()},
		{"jira", []string{"jira", "/nope"}, wdb.ErrNoDatabase.Error()},
		{"ports", []string{"ports"}, wdb.ErrNoDatabase.Error()},
		{"unread", []string{"unread"}, wdb.ErrNoDatabase.Error()},
		{"unread bad by", []string{"unread", "--by", "x"}, `unknown --by "x"`},
		{"notes", []string{"notes", "show"}, wdb.ErrNoDatabase.Error()},
		{"review-comments", []string{"review-comments", "list"}, wdb.ErrNoDatabase.Error()},
		{"resources", []string{"resources", "list", "--all"}, "--all requires --json"},
		{"unknown flag", []string{"status", "--nope"}, "unknown flag: --nope"},
		{"unknown command", []string{"nope"}, `unknown command "nope"`},
		{"bad args", []string{"status", "extra"}, "unknown command"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := runCLIProcess(t, t.TempDir(), nil, tt.args...)
			if r.code != 2 {
				t.Errorf("exit %d, want 2", r.code)
			}
			if n := strings.Count(r.stderr, tt.want); n != 1 {
				t.Errorf("%q appears %d times, want once in:\n%s", tt.want, n, r.stderr)
			}
			if strings.Contains(r.stderr, "Usage:") || strings.Contains(r.stderr, "Error:") {
				t.Errorf("noise in stderr:\n%s", r.stderr)
			}
		})
	}
}
