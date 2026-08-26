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
	repoName := repoDirName(repoRoot)
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

// repoDirName is the directory a repo's worktrees are filed under inside the
// worktrees base. repoRoot may be a linked worktree (when `worktree add` is run
// from inside one), so resolve back to the main clone first — otherwise the new
// worktree gets nested under the name of the worktree we were standing in.
func repoDirName(repoRoot string) string {
	if main := MainRoot(repoRoot); main != "" {
		return filepath.Base(main)
	}
	return filepath.Base(repoRoot)
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
	repoName := repoDirName(repoRoot)
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

// ErrNeedsForce is returned by RemoveWorktree when git refuses to remove the
// worktree even with --force (e.g. read-only files left by a build blocking rm,
// or a directory git no longer sees as a valid worktree). The caller can then
// confirm with the user and call ForceRemoveWorktree.
type ErrNeedsForce struct {
	GitOutput string
}

func (e *ErrNeedsForce) Error() string {
	return e.GitOutput
}

// RemoveWorktree removes the worktree at wtPath with `git worktree remove`,
// then `--force`. If git still refuses, it returns *ErrNeedsForce rather than
// forcibly deleting — the caller decides whether to escalate.
func RemoveWorktree(repoRoot, wtPath string) error {
	cmd := exec.Command("git", "-C", repoRoot, "worktree", "remove", wtPath)
	if err := cmd.Run(); err == nil {
		return nil
	}

	cmd = exec.Command("git", "-C", repoRoot, "worktree", "remove", "--force", wtPath)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	return &ErrNeedsForce{GitOutput: strings.TrimSpace(string(out))}
}

// ForceRemoveWorktree replicates the old tool's force_rm fallback: fix
// permissions, then remove the directory, then prune git's worktree list. It
// only removes the directory when wtPath is safely contained in worktreesBase —
// the directory this tool owns — so a bad path can never cause an rm -rf outside
// the managed worktrees area.
func ForceRemoveWorktree(repoRoot, worktreesBase, wtPath string) error {
	if !isContained(worktreesBase, wtPath) {
		return fmt.Errorf("%s is outside the managed worktrees base (%s); refusing to force-remove", wtPath, worktreesBase)
	}
	exec.Command("chmod", "-R", "u+rwx", wtPath).Run()
	if err := os.RemoveAll(wtPath); err != nil {
		return fmt.Errorf("removing worktree directory: %w", err)
	}
	PruneWorktrees(repoRoot)
	return nil
}

// isContained reports whether path is base itself or lies within it, after
// resolving both to absolute, symlink-free paths. Used to guard forced removal.
func isContained(base, path string) bool {
	if base == "" {
		return false
	}
	absBase, err := filepath.Abs(base)
	if err != nil {
		return false
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	// Resolve symlinks where possible so a symlinked base still matches.
	if r, err := filepath.EvalSymlinks(absBase); err == nil {
		absBase = r
	}
	if r, err := filepath.EvalSymlinks(absPath); err == nil {
		absPath = r
	}
	rel, err := filepath.Rel(absBase, absPath)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
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

// DeleteBranch deletes a local branch in repoRoot.
//
// With force=false it uses `git branch -d`, which refuses to delete a branch
// that is not fully merged. That refusal comes back as *ErrNeedsForce carrying
// git's message, so callers escalate it the same way they escalate a worktree
// directory git will not remove — one shape for both confirmations.
//
// Any other failure (no such branch, not a repo) is returned as a plain error:
// forcing would not help.
func DeleteBranch(repoRoot, branch string, force bool) error {
	flag := "-d"
	if force {
		flag = "-D"
	}
	out, err := exec.Command("git", "-C", repoRoot, "branch", flag, branch).CombinedOutput()
	if err == nil {
		return nil
	}
	msg := strings.TrimSpace(string(out))
	if !force && strings.Contains(msg, "not fully merged") {
		return &ErrNeedsForce{GitOutput: msg}
	}
	return fmt.Errorf("git branch %s %s: %s", flag, branch, msg)
}
