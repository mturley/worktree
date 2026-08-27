package cmd

import (
	"testing"

	"github.com/mturley/worktree/internal/resources"
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
