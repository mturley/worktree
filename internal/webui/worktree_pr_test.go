package webui

import (
	"fmt"
	"testing"

	watcherdb "github.com/mturley/watcher/db"

	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

// prWorktree is a linked worktree (branch "feature") following PRs o/r#1 and
// o/r#2, with a "gh" remote for github.com/me/r.
func prWorktree(t *testing.T) (*Server, string) {
	t.Helper()
	wt := testgit.Worktree(t)
	srv, _ := gitTestServer(t, wt, nil)
	gitIn(t, wt, "remote", "add", "gh", "https://github.com/me/r.git")
	for _, id := range []string{"o/r#1", "o/r#2"} {
		must(t, resources.Add(srv.DB, wt, resources.Resource{Type: "pr", ID: id}))
	}
	return srv, wt
}

func trackUpstream(t *testing.T, wt, remote, merge string) {
	t.Helper()
	gitIn(t, wt, "config", "branch.feature.remote", remote)
	gitIn(t, wt, "config", "branch.feature.merge", merge)
}

func TestWorktreePRMatchesTrackedHead(t *testing.T) {
	t.Parallel()
	srv, wt := prWorktree(t)
	seedPRHead(t, srv, "o/r#1", "me", "r", "other")
	seedPRHead(t, srv, "o/r#2", "me", "r", "renamed-upstream")
	trackUpstream(t, wt, "gh", "refs/heads/renamed-upstream")

	got, ok := srv.worktreePR(wt)
	if !ok || got.ID != "o/r#2" || got.Number != 2 || got.BaseSlug != "o/r" || got.HeadSlug != "me/r" ||
		got.HeadRef != "renamed-upstream" || got.BaseRef != "main" {
		t.Fatalf("worktreePR = %+v, %v; want o/r#2", got, ok)
	}
}

func TestWorktreePROldState(t *testing.T) {
	t.Parallel()
	srv, wt := prWorktree(t)
	must(t, watcherdb.UpsertResourceState(srv.DB, "pr", "o/r#1", `{"title":"T"}`, "2026-01-01T00:00:00Z", "x"))
	trackUpstream(t, wt, "gh", "refs/heads/feature")

	if got, ok := srv.worktreePR(wt); ok {
		t.Fatalf("worktreePR = %+v; want no match without cached head fields", got)
	}
}

func TestWorktreePRGarbageState(t *testing.T) {
	t.Parallel()
	srv, wt := prWorktree(t)
	must(t, watcherdb.UpsertResourceState(srv.DB, "pr", "o/r#1", "not json", "2026-01-01T00:00:00Z", "x"))
	trackUpstream(t, wt, "gh", "refs/heads/feature")

	if got, ok := srv.worktreePR(wt); ok {
		t.Fatalf("worktreePR = %+v; want no match for unreadable state", got)
	}
}

func TestWorktreePRNoUpstream(t *testing.T) {
	t.Parallel()
	srv, wt := prWorktree(t)
	seedPRHead(t, srv, "o/r#1", "me", "r", "feature")

	if got, ok := srv.worktreePR(wt); ok {
		t.Fatalf("worktreePR = %+v; want no match with no upstream", got)
	}
}

// seedPRHead writes PR id's cached state as the poller does, with head
// branch ref in owner/repo and base branch main.
func seedPRHead(t *testing.T, srv *Server, id, owner, repo, ref string) {
	t.Helper()
	state := fmt.Sprintf(`{"head_ref_name":%q,"base_ref_name":"main","head_repo_owner":%q,"head_repo_name":%q}`, ref, owner, repo)
	must(t, watcherdb.UpsertResourceState(srv.DB, "pr", id, state, "2026-01-01T00:00:00Z", "x"))
}
