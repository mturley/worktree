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

	base := DefaultBranch(repoRoot)
	Fetch(repoRoot, strings.Split(base, "/")[0])

	cmd := exec.Command("git", "-C", repoRoot, "worktree", "add", "-b", branchName, "--no-track", wtPath, base)
	if out, err := cmd.CombinedOutput(); err != nil {
		cmd2 := exec.Command("git", "-C", repoRoot, "worktree", "add", wtPath, branchName)
		if out2, err2 := cmd2.CombinedOutput(); err2 != nil {
			return CreateResult{}, fmt.Errorf("creating worktree: %s\n%s", string(out), string(out2))
		}
		return CreateResult{Path: wtPath, Branch: branchName, Created: false}, nil
	}

	return CreateResult{Path: wtPath, Branch: branchName, Created: true}, nil
}

func CreatePRWorktree(repoRoot, worktreesBase, remote string, prNumber int, headRef, slug string) (CreateResult, error) {
	repoName := filepath.Base(repoRoot)
	dirName := fmt.Sprintf("pr-%d-%s", prNumber, slug)
	wtPath := filepath.Join(worktreesBase, repoName, dirName)

	if _, err := os.Stat(wtPath); err == nil {
		branch := currentBranch(wtPath)
		return CreateResult{Path: wtPath, Branch: branch, Created: false}, nil
	}

	if err := os.MkdirAll(filepath.Dir(wtPath), 0755); err != nil {
		return CreateResult{}, fmt.Errorf("creating directory: %w", err)
	}

	fetchRef := fmt.Sprintf("refs/pr-review/%d", prNumber)
	err := Fetch(repoRoot, remote, fmt.Sprintf("pull/%d/head:%s", prNumber, fetchRef))
	if err != nil {
		return CreateResult{}, fmt.Errorf("fetching PR from %s: %w", remote, err)
	}

	branchName := fmt.Sprintf("review/pr-%d-%s", prNumber, slug)

	cmd := exec.Command("git", "-C", repoRoot, "worktree", "add", "-b", branchName, wtPath, fetchRef)
	if _, err := cmd.CombinedOutput(); err == nil {
		return CreateResult{Path: wtPath, Branch: branchName, Created: true}, nil
	}

	// Branch already exists — reuse it with the existing branch
	cmd2 := exec.Command("git", "-C", repoRoot, "worktree", "add", wtPath, branchName)
	if out, err := cmd2.CombinedOutput(); err != nil {
		return CreateResult{}, fmt.Errorf("creating worktree with existing branch: %s", strings.TrimSpace(string(out)))
	}

	return CreateResult{Path: wtPath, Branch: branchName, Created: false}, nil
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
	if out, err := cmd.CombinedOutput(); err != nil {
		cmd2 := exec.Command("git", "-C", repoRoot, "worktree", "remove", "--force", wtPath)
		if out2, err2 := cmd2.CombinedOutput(); err2 != nil {
			return fmt.Errorf("removing worktree: %s\n%s", string(out), string(out2))
		}
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
