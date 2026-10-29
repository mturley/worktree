package gitutil

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	PRWorktreeCreated      PRWorktreeStatus = iota // new branch + new worktree
	PRWorktreeExistingDir                          // worktree directory already exists
	PRWorktreeBranchExists                         // branch exists but no worktree dir
)

type PRWorktreeResult struct {
	CreateResult
	Status     PRWorktreeStatus
	LocalHead  string // current HEAD of existing branch
	RemoteHead string // latest PR commit (refs/pr-review/N)
	FetchRef   string // the ref name used for the PR
}

// PRBranchName is the branch a PR worktree gets unless the user picks another:
// the PR's head branch, as `gh pr checkout` names it, so the branch and the one
// SetPRTracking makes it track share a name and a plain `git push` updates the
// PR. A head branch named main or master (a PR from a fork's default branch)
// gets the head repo's owner as a prefix, or pr-<N> when that is unknown, so it
// can't collide with the local default branch.
func PRBranchName(prNumber int, headOwner, headRef string) string {
	if headRef != "main" && headRef != "master" {
		return headRef
	}
	if headOwner == "" {
		headOwner = fmt.Sprintf("pr-%d", prNumber)
	}
	return headOwner + "/" + headRef
}

// ValidBranchName reports whether git would accept name as a new branch.
func ValidBranchName(name string) bool {
	return exec.Command("git", "check-ref-format", "--branch", name).Run() == nil
}

// CreatePRWorktree creates the worktree for a PR on branchName (see
// PRBranchName for the default). The directory is always pr-<N>-<slug>,
// whatever the branch is called, so a re-run on the same PR finds the existing
// worktree.
func CreatePRWorktree(repoRoot, worktreesBase, remote string, prNumber int, slug, branchName string) (PRWorktreeResult, error) {
	repoName := repoDirName(repoRoot)
	dirName := fmt.Sprintf("pr-%d-%s", prNumber, slug)
	wtPath := filepath.Join(worktreesBase, repoName, dirName)

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

// PRHead locates a pull request's head branch, for SetPRTracking.
type PRHead struct {
	Number     int
	BaseRemote string // the remote for the PR's base repository
	// Owner and Repo name the repository the head branch lives in: the base
	// repo for a same-repo PR, the fork otherwise. Both are empty when GitHub
	// no longer has it (a deleted fork).
	Owner, Repo string
	Ref         string // the head branch's name
}

// prNumberKey is the branch config variable SetPRTracking records the PR
// number in, since the upstream (the PR's head branch) doesn't carry it.
const prNumberKey = "worktree-pr"

// SetPRTracking makes branchName track the PR's head branch as a real
// remote-tracking branch, <remote>/<head>, so git reports ahead/behind and
// `git pull` follows new commits pushed to the PR. A head repo that isn't one
// of repoRoot's remotes yet (someone else's fork) is added as one, named after
// its owner. When the head repo is gone, the branch tracks the base repo's
// refs/pull/<N>/head instead: the only place the PR's commits still live.
// Either way the PR number is recorded for TrackedPRNumber.
func SetPRTracking(repoRoot, branchName string, head PRHead) error {
	setConfig := func(key, val string) error {
		_, err := git(repoRoot, "config", key, val)
		return err
	}
	if err := setConfig("branch."+branchName+"."+prNumberKey, strconv.Itoa(head.Number)); err != nil {
		return err
	}
	remote, merge := head.BaseRemote, fmt.Sprintf("refs/pull/%d/head", head.Number)
	if head.Owner != "" && head.Repo != "" {
		var err error
		if remote, err = EnsureRemoteForRepo(repoRoot, head.Owner, head.Repo, head.BaseRemote); err != nil {
			return err
		}
		// An explicit refspec, so the remote-tracking branch exists even when
		// the remote's own fetch refspec is narrower than refs/heads/*.
		refspec := fmt.Sprintf("+refs/heads/%s:refs/remotes/%s/%s", head.Ref, remote, head.Ref)
		if err := Fetch(repoRoot, remote, refspec); err != nil {
			return fmt.Errorf("fetching %s from %s: %w", head.Ref, remote, err)
		}
		merge = "refs/heads/" + head.Ref
	}
	if err := setConfig("branch."+branchName+".remote", remote); err != nil {
		return err
	}
	return setConfig("branch."+branchName+".merge", merge)
}

// EnsureRemoteForRepo returns the remote for owner/repo, adding one named
// owner when there is none. The new remote's URL is likeRemote's with the
// owner/repo swapped, so it uses the same host and protocol (ssh or https).
func EnsureRemoteForRepo(repoRoot, owner, repo, likeRemote string) (string, error) {
	if remote, err := FindRemoteForRepo(repoRoot, owner, repo); err == nil {
		return remote, nil
	}
	if url := RemoteURL(repoRoot, owner); url != "" {
		return "", fmt.Errorf("remote %q already exists and points at %s, not %s/%s", owner, url, owner, repo)
	}
	url := siblingRepoURL(RemoteURL(repoRoot, likeRemote), owner, repo)
	if url == "" {
		return "", fmt.Errorf("can't derive a URL for %s/%s from remote %q", owner, repo, likeRemote)
	}
	if _, err := git(repoRoot, "remote", "add", owner, url); err != nil {
		return "", err
	}
	return owner, nil
}

// siblingRepoURL replaces the owner/repo at the end of a repository URL,
// keeping everything before it (scheme, host, ssh user) and any .git suffix.
// It handles both "https://host/o/r.git" and scp-like "git@host:o/r.git".
func siblingRepoURL(url, owner, repo string) string {
	trimmed := strings.TrimSuffix(url, ".git")
	suffix := url[len(trimmed):]
	i := strings.LastIndexAny(trimmed, "/:") // before the repo
	if i <= 0 {
		return ""
	}
	j := strings.LastIndexAny(trimmed[:i], "/:") // before the owner
	if j < 0 {
		return ""
	}
	return trimmed[:j+1] + owner + "/" + repo + suffix
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
