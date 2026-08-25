package cmd

import (
	"testing"

	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/resources"
)

func TestBuildRegistryEntry(t *testing.T) {
	e := buildRegistryEntry(gitutil.CreateResult{Path: "/wt/a", Branch: "b"}, "/repos/myrepo", "2026-08-11T00:00:00Z")
	if e.Repo != "myrepo" || e.RepoRoot != "/repos/myrepo" || e.Branch != "b" || e.Path != "/wt/a" {
		t.Fatalf("got %+v", e)
	}
}

func TestBuildWorkspaceURLs_UIFirstThenPRThenJira(t *testing.T) {
	res := []resources.Resource{
		{Type: "jira", ID: "X-1", URL: "https://jira/X-1"},
		{Type: "pr", ID: "o/r#1", URL: "https://gh/pr/1"},
	}
	got := buildWorkspaceURLs("http://127.0.0.1:8475/worktree/x", res)
	want := []string{"http://127.0.0.1:8475/worktree/x", "https://gh/pr/1", "https://jira/X-1"}
	assertURLs(t, got, want)
}

func TestBuildWorkspaceURLs_NoRunningUI(t *testing.T) {
	res := []resources.Resource{{Type: "pr", ID: "o/r#1", URL: "https://gh/pr/1"}}
	assertURLs(t, buildWorkspaceURLs("", res), []string{"https://gh/pr/1"})
}

func TestBuildWorkspaceURLs_SkipsRelatedJiraAndEmptyURLs(t *testing.T) {
	res := []resources.Resource{
		{Type: "jira", ID: "X-2", URL: "https://jira/X-2", Related: true},
		{Type: "jira", ID: "X-1", URL: "https://jira/X-1"},
		{Type: "pr", ID: "o/r#1", URL: ""},
		{Type: "slack", ID: "C1:1.2", URL: "https://slack/t"},
	}
	assertURLs(t, buildWorkspaceURLs("", res), []string{"https://jira/X-1"})
}

func TestBuildWorkspaceURLs_Empty(t *testing.T) {
	if got := buildWorkspaceURLs("", nil); len(got) != 0 {
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
