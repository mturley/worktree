package gitutil

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type CreateResult struct {
	Path    string
	Branch  string
	Created bool
}

func CreateBranchWorktree(repoRoot, worktreesBase, branchName string) (CreateResult, error) {
	repoName := filepath.Base(repoRoot)
	wtPath := filepath.Join(worktreesBase, repoName, branchName)

	if _, err := os.Stat(wtPath); err == nil {
		branch := currentBranch(wtPath)
		return CreateResult{Path: wtPath, Branch: branch, Created: false}, nil
	}

	if err := os.MkdirAll(filepath.Dir(wtPath), 0755); err != nil {
		return CreateResult{}, fmt.Errorf("creating directory: %w", err)
	}

	cmd := exec.Command("git", "-C", repoRoot, "worktree", "add", "-b", branchName, wtPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		cmd2 := exec.Command("git", "-C", repoRoot, "worktree", "add", wtPath, branchName)
		if out2, err2 := cmd2.CombinedOutput(); err2 != nil {
			return CreateResult{}, fmt.Errorf("creating worktree: %s\n%s", string(out), string(out2))
		}
		return CreateResult{Path: wtPath, Branch: branchName, Created: false}, nil
	}

	return CreateResult{Path: wtPath, Branch: branchName, Created: true}, nil
}

type PRWorktreeStatus int

const (
	PRWorktreeCreated          PRWorktreeStatus = iota // new branch + new worktree
	PRWorktreeExistingDir                              // worktree directory already exists
	PRWorktreeBranchExists                             // branch exists but no worktree dir
)

type PRWorktreeResult struct {
	CreateResult
	Status      PRWorktreeStatus
	LocalHead   string // current HEAD of existing branch
	RemoteHead  string // latest PR commit (refs/pr-review/N)
	FetchRef    string // the ref name used for the PR
}

func CreatePRWorktree(repoRoot, worktreesBase, remote string, prNumber int, headRef, slug string) (PRWorktreeResult, error) {
	repoName := filepath.Base(repoRoot)
	dirName := fmt.Sprintf("pr-%d-%s", prNumber, slug)
	wtPath := filepath.Join(worktreesBase, repoName, dirName)
	branchName := fmt.Sprintf("review/pr-%d-%s", prNumber, slug)

	fetchRef := fmt.Sprintf("refs/pr-review/%d", prNumber)
	err := Fetch(repoRoot, remote, fmt.Sprintf("+pull/%d/head:%s", prNumber, fetchRef))
	if err != nil {
		return PRWorktreeResult{}, fmt.Errorf("fetching PR from %s: %w", remote, err)
	}
	remoteHead := RevParse(repoRoot, fetchRef)

	if _, err := os.Stat(wtPath); err == nil {
		branch := currentBranch(wtPath)
		localHead := RevParse(wtPath, "HEAD")
		return PRWorktreeResult{
			CreateResult: CreateResult{Path: wtPath, Branch: branch, Created: false},
			Status:       PRWorktreeExistingDir,
			LocalHead:    localHead,
			RemoteHead:   remoteHead,
			FetchRef:     fetchRef,
		}, nil
	}

	if err := os.MkdirAll(filepath.Dir(wtPath), 0755); err != nil {
		return PRWorktreeResult{}, fmt.Errorf("creating directory: %w", err)
	}

	cmd := exec.Command("git", "-C", repoRoot, "worktree", "add", "-b", branchName, wtPath, fetchRef)
	if _, err := cmd.CombinedOutput(); err == nil {
		return PRWorktreeResult{
			CreateResult: CreateResult{Path: wtPath, Branch: branchName, Created: true},
			Status:       PRWorktreeCreated,
			RemoteHead:   remoteHead,
			FetchRef:     fetchRef,
		}, nil
	}

	// Branch exists but worktree dir does not — don't create yet, let caller confirm
	localHead := RevParse(repoRoot, branchName)
	return PRWorktreeResult{
		CreateResult: CreateResult{Path: wtPath, Branch: branchName, Created: false},
		Status:       PRWorktreeBranchExists,
		LocalHead:    localHead,
		RemoteHead:   remoteHead,
		FetchRef:     fetchRef,
	}, nil
}

func CreateWorktreeFromExistingBranch(repoRoot, wtPath, branchName string) error {
	cmd := exec.Command("git", "-C", repoRoot, "worktree", "add", wtPath, branchName)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("creating worktree: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// SetPRTracking configures branchName so `git pull` fetches the PR's head ref
// from the given remote and merges it. This lets a reviewer pull new commits
// pushed to the PR — even from a fork whose head branch isn't a local remote —
// by pointing branch.<name>.merge at refs/pull/<N>/head.
func SetPRTracking(repoRoot, branchName, remote string, prNumber int) error {
	setConfig := func(key, val string) error {
		cmd := exec.Command("git", "-C", repoRoot, "config", key, val)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("git config %s: %s", key, strings.TrimSpace(string(out)))
		}
		return nil
	}
	if err := setConfig(fmt.Sprintf("branch.%s.remote", branchName), remote); err != nil {
		return err
	}
	if err := setConfig(fmt.Sprintf("branch.%s.merge", branchName), fmt.Sprintf("refs/pull/%d/head", prNumber)); err != nil {
		return err
	}
	return nil
}

func RevParse(dir, ref string) string {
	cmd := exec.Command("git", "-C", dir, "rev-parse", ref)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func ResetHard(dir, ref string) error {
	cmd := exec.Command("git", "-C", dir, "reset", "--hard", ref)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git reset: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func RemoveWorktree(repoRoot, wtPath string) error {
	cmd := exec.Command("git", "-C", repoRoot, "worktree", "remove", wtPath)
	if err := cmd.Run(); err == nil {
		return nil
	}

	cmd = exec.Command("git", "-C", repoRoot, "worktree", "remove", "--force", wtPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s\n\n  To resolve: delete the directory manually, then reconcile.\n    rm -rf %s\n    git worktree prune\n    worktree cleanup", strings.TrimSpace(string(out)), wtPath)
	}
	return nil
}

func PruneWorktrees(repoRoot string) error {
	cmd := exec.Command("git", "-C", repoRoot, "worktree", "prune")
	return cmd.Run()
}

func currentBranch(dir string) string {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
