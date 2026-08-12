package cmd

import (
	"testing"

	"github.com/mturley/worktree/internal/gitutil"
)

func TestBuildRegistryEntry(t *testing.T) {
	e := buildRegistryEntry(gitutil.CreateResult{Path: "/wt/a", Branch: "b"}, "/repos/myrepo", "2026-08-11T00:00:00Z")
	if e.Repo != "myrepo" || e.RepoRoot != "/repos/myrepo" || e.Branch != "b" || e.Path != "/wt/a" {
		t.Fatalf("got %+v", e)
	}
}
