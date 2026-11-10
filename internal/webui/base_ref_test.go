package webui

import (
	"fmt"
	"path/filepath"
	"testing"

	watcherdb "github.com/mturley/watcher/db"

	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

// twoRemoteWorktree is a linked worktree on `feature` (one commit past
// upstream/main) of a repo with remotes origin (mturley/repo) and upstream
// (org/repo). origin/main is one commit behind upstream/main, which has a
// sibling upstream/feature/x; local main tracks origin/main, so
// MainUpstream is origin/main. `feature` tracks origin/feature.
func twoRemoteWorktree(t *testing.T) string {
	t.Helper()
	return filepath.Join(testgit.Template(t, "twoRemoteWorktree", buildTwoRemote), "wt")
}

func buildTwoRemote(t *testing.T, base string) {
	t.Helper()
	repo := filepath.Join(base, "repo")
	gitIn(t, base, "init", "-b", "main", repo)
	commitFile(t, repo, "base", "0")
	gitIn(t, repo, "remote", "add", "origin", "https://github.com/mturley/repo.git")
	gitIn(t, repo, "remote", "add", "upstream", "https://github.com/org/repo.git")
	gitIn(t, repo, "update-ref", "refs/remotes/origin/main", "HEAD")
	gitIn(t, repo, "config", "branch.main.remote", "origin")
	gitIn(t, repo, "config", "branch.main.merge", "refs/heads/main")
	commitFile(t, repo, "up", "1")
	gitIn(t, repo, "update-ref", "refs/remotes/upstream/main", "HEAD")
	commitFile(t, repo, "x", "2")
	gitIn(t, repo, "update-ref", "refs/remotes/upstream/feature/x", "HEAD")
	gitIn(t, repo, "reset", "--hard", "upstream/main")
	gitIn(t, repo, "worktree", "add", "-b", "feature", filepath.Join(base, "wt"), "upstream/main")
	wt := filepath.Join(base, "wt")
	commitFile(t, wt, "f1", "1")
	gitIn(t, wt, "config", "branch.feature.remote", "origin")
	gitIn(t, wt, "config", "branch.feature.merge", "refs/heads/feature")
}

// followPR follows id in wt and caches state saying its head is branch
// feature of mturley/repo and its base is baseRef.
func followPR(t *testing.T, srv *Server, wt, id, baseRef string) {
	t.Helper()
	must(t, resources.Add(srv.DB, wt, resources.Resource{Type: "pr", ID: id}))
	state := fmt.Sprintf(`{"head_ref_name":"feature","base_ref_name":%q,"head_repo_owner":"mturley","head_repo_name":"repo"}`, baseRef)
	must(t, watcherdb.UpsertResourceState(srv.DB, "pr", id, state, "2026-01-01T00:00:00Z", "x"))
}

func TestMergeBaseRefFromPR(t *testing.T) {
	t.Parallel()
	wt := twoRemoteWorktree(t)
	srv, _ := gitTestServer(t, wt, nil)
	followPR(t, srv, wt, "org/repo#7", "main")
	ref, pr, ok := srv.mergeBaseRef(wt)
	if !ok || ref != "upstream/main" || pr == nil || pr.ID != "org/repo#7" {
		t.Fatalf("mergeBaseRef = %q, %+v, %v", ref, pr, ok)
	}
}

func TestMergeBaseRefSlashBranch(t *testing.T) {
	t.Parallel()
	wt := twoRemoteWorktree(t)
	srv, _ := gitTestServer(t, wt, nil)
	followPR(t, srv, wt, "org/repo#7", "feature/x")
	ref, pr, ok := srv.mergeBaseRef(wt)
	if !ok || ref != "upstream/feature/x" || pr == nil {
		t.Fatalf("mergeBaseRef = %q, %+v, %v", ref, pr, ok)
	}
}

func TestMergeBaseRefNoBaseRemote(t *testing.T) {
	t.Parallel()
	wt := twoRemoteWorktree(t)
	srv, _ := gitTestServer(t, wt, nil)
	followPR(t, srv, wt, "someone/else#7", "main")
	ref, pr, ok := srv.mergeBaseRef(wt)
	if !ok || ref != "origin/main" || pr == nil || pr.ID != "someone/else#7" {
		t.Fatalf("mergeBaseRef = %q, %+v, %v", ref, pr, ok)
	}
}

func TestMergeBaseRefUnfetchedBase(t *testing.T) {
	t.Parallel()
	wt := twoRemoteWorktree(t)
	srv, _ := gitTestServer(t, wt, nil)
	followPR(t, srv, wt, "org/repo#7", "gone")
	ref, pr, ok := srv.mergeBaseRef(wt)
	if !ok || ref != "origin/main" || pr == nil {
		t.Fatalf("mergeBaseRef = %q, %+v, %v", ref, pr, ok)
	}
}

func TestMergeBaseRefNoPR(t *testing.T) {
	t.Parallel()
	wt := twoRemoteWorktree(t)
	srv, _ := gitTestServer(t, wt, nil)
	followPR(t, srv, wt, "org/repo#7", "main")
	// Unrelated: the branch now tracks a different head branch.
	gitIn(t, wt, "config", "branch.feature.merge", "refs/heads/other")
	ref, pr, ok := srv.mergeBaseRef(wt)
	if !ok || ref != "origin/main" || pr != nil {
		t.Fatalf("mergeBaseRef = %q, %+v, %v", ref, pr, ok)
	}
}
