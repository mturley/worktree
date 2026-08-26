// Package worktreedel runs the worktree deletion sequence.
//
// It exists so the CLI and the web UI share one sequence rather than two
// copies. The steps used to live inline in cmd/delete.go; a second copy in the
// HTTP handler would drift silently, and the symptom — a worktree deleted from
// the UI that still holds its port range — stays invisible until the range
// runs out.
package worktreedel

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

type StepKey string

const (
	StepRemoveDirectory  StepKey = "remove_directory"
	StepReleasePorts     StepKey = "release_ports"
	StepUnregister       StepKey = "unregister"
	StepRemoveResources  StepKey = "remove_resources"
	StepRemoveKubeconfig StepKey = "remove_kubeconfig"
	StepPrune            StepKey = "prune"
	StepDeleteBranch     StepKey = "delete_branch"
)

type Status string

const (
	StatusDone       Status = "done"
	StatusSkipped    Status = "skipped"
	StatusFailed     Status = "failed"
	StatusNeedsForce Status = "needs_force"
	StatusPending    Status = "pending"
)

type Step struct {
	Key    StepKey `json:"key"`
	Label  string  `json:"label"`
	Status Status  `json:"status"`
	Detail string  `json:"detail,omitempty"`
}

type Options struct {
	Path           string
	DeleteBranch   bool
	ForceDirectory bool
	ForceBranch    bool
}

type Result struct {
	Steps      []Step  `json:"steps"`
	NeedsForce StepKey `json:"needs_force,omitempty"`
	Err        error   `json:"-"`
}

var labels = map[StepKey]string{
	StepRemoveDirectory:  "Remove worktree directory",
	StepReleasePorts:     "Release port range",
	StepUnregister:       "Unregister worktree",
	StepRemoveResources:  "Remove tracked resources",
	StepRemoveKubeconfig: "Remove kubeconfig",
	StepPrune:            "Prune git worktree list",
	StepDeleteBranch:     "Delete branch",
}

// Run executes the deletion sequence, reporting each step to observe (which may
// be nil) as it completes.
//
// Every run starts from the top: there is no session. Granting a force
// re-invokes Run with that force set, so each step tolerates work already done
// and reports it as skipped rather than failing.
func Run(conn *sql.DB, cfg config.Config, opts Options, observe func(Step)) Result {
	res := Result{}
	keys := []StepKey{StepRemoveDirectory}
	if opts.DeleteBranch {
		// Deleting the branch must happen before Unregister: the branch name
		// and repo root live in the registry row, and Unregister deletes that
		// row. A needs-force branch delete has to be retryable, which means
		// the row (and thus this information) must still exist on the retry.
		keys = append(keys, StepDeleteBranch)
	}
	keys = append(keys, StepReleasePorts, StepUnregister, StepRemoveResources, StepRemoveKubeconfig, StepPrune)
	for _, k := range keys {
		res.Steps = append(res.Steps, Step{Key: k, Label: labels[k], Status: StatusPending})
	}

	set := func(key StepKey, status Status, detail string) {
		for i := range res.Steps {
			if res.Steps[i].Key == key {
				res.Steps[i].Status = status
				res.Steps[i].Detail = detail
				if observe != nil {
					observe(res.Steps[i])
				}
				return
			}
		}
	}

	repoRoot, repo, branch, err := resolve(conn, cfg, opts.Path)
	if err != nil {
		res.Err = err
		return res
	}
	name := filepath.Base(opts.Path)

	// 1. The directory. A hard failure here aborts: unregistering a worktree
	// still on disk strands it — invisible to the tool, still holding its ports.
	switch _, statErr := os.Stat(opts.Path); {
	case os.IsNotExist(statErr):
		set(StepRemoveDirectory, StatusSkipped, "already removed")
	default:
		var rmErr error
		if opts.ForceDirectory {
			rmErr = gitutil.ForceRemoveWorktree(repoRoot, cfg.WorktreesBase, opts.Path)
		} else {
			rmErr = gitutil.RemoveWorktree(repoRoot, opts.Path)
		}
		var needsForce *gitutil.ErrNeedsForce
		switch {
		case rmErr == nil:
			set(StepRemoveDirectory, StatusDone, "")
		case errors.As(rmErr, &needsForce):
			set(StepRemoveDirectory, StatusNeedsForce, needsForce.GitOutput)
			res.NeedsForce = StepRemoveDirectory
			return res
		default:
			set(StepRemoveDirectory, StatusFailed, rmErr.Error())
			res.Err = rmErr
			return res
		}
	}

	// 2. The branch, only when asked, and before any cleanup that would wipe
	// the registry row this needs. Unmerged is the common case for a worktree
	// branch, so its refusal (needs_force) escalates like the directory's and
	// aborts before Unregister so a retry can still resolve the branch name.
	// A hard (non-needs-force) failure does NOT abort — see below.
	if opts.DeleteBranch {
		if branch == "" {
			// A green checkmark here would tell the user their explicit
			// request to delete the branch was honored when nothing
			// happened — e.g. a detached HEAD, or a worktree we could not
			// inspect before it was removed. An honest failure beats that.
			set(StepDeleteBranch, StatusFailed, "could not determine which branch to delete")
		} else {
			err := gitutil.DeleteBranch(repoRoot, branch, opts.ForceBranch)
			var needsForce *gitutil.ErrNeedsForce
			switch {
			case err == nil:
				set(StepDeleteBranch, StatusDone, branch)
			case errors.As(err, &needsForce):
				set(StepDeleteBranch, StatusNeedsForce, needsForce.GitOutput)
				res.NeedsForce = StepDeleteBranch
				return res
			default:
				// A hard failure here (e.g. branch already gone) must not
				// abort: forcing wouldn't help, so there's nothing an abort
				// would preserve. Continuing lets cleanup finish instead of
				// stranding the registry row and port range forever on retry.
				set(StepDeleteBranch, StatusFailed, err.Error())
			}
		}
	}

	// 3-6. Cleanup. These do NOT abort on failure: the CLI has always warned
	// and carried on, and stopping would leave more mess than continuing. The
	// difference is the failure is now visible instead of scrolling past.
	if err := ports.Release(conn, name); err != nil {
		set(StepReleasePorts, StatusFailed, err.Error())
	} else {
		set(StepReleasePorts, StatusDone, "")
	}

	if err := registry.Unregister(conn, opts.Path); err != nil {
		set(StepUnregister, StatusFailed, err.Error())
	} else {
		set(StepUnregister, StatusDone, "")
	}

	if err := resources.RemoveAll(conn, opts.Path); err != nil {
		set(StepRemoveResources, StatusFailed, err.Error())
	} else {
		set(StepRemoveResources, StatusDone, "")
	}

	kubePath := env.KubeconfigPath(repo, name)
	switch err := os.Remove(kubePath); {
	case err == nil:
		set(StepRemoveKubeconfig, StatusDone, kubePath)
	case os.IsNotExist(err):
		set(StepRemoveKubeconfig, StatusSkipped, "none found")
	default:
		set(StepRemoveKubeconfig, StatusFailed, err.Error())
	}

	if repoRoot == "" {
		// The worktree was already fully removed and unregistered by a prior
		// run; there is no repo root left to prune from.
		set(StepPrune, StatusSkipped, "no repo information available")
	} else if err := gitutil.PruneWorktrees(repoRoot); err != nil {
		set(StepPrune, StatusFailed, err.Error())
	} else {
		set(StepPrune, StatusDone, "")
	}

	return res
}

// resolve finds the repo root, repo name and branch for a worktree.
//
// The registry comes first because it still answers after the directory is
// gone — which is the state every force retry is in. Inspecting the directory
// is the fallback for a worktree that was never registered but still exists
// on disk.
//
// If neither source has anything AND the path sits under the configured
// WorktreesBase, this is most likely a worktree a previous run already
// finished deleting (directory gone, registry row gone) rather than a bogus
// path — Run needs to tolerate that as an idempotent no-op rather than
// erroring, so resolve reports it as "nothing known" (empty strings, nil
// error) instead of a hard failure. A path outside WorktreesBase with no
// record anywhere is rejected as unknown.
func resolve(conn *sql.DB, cfg config.Config, path string) (repoRoot, repo, branch string, err error) {
	if e, gErr := registry.Get(conn, path); gErr == nil && e != nil {
		return e.RepoRoot, e.Repo, e.Branch, nil
	}
	// No registry row — inspect the directory while it still exists (this
	// runs at the top of Run, before anything is deleted).
	//
	// gitutil.RepoRoot runs `git rev-parse --show-toplevel`, which for a
	// LINKED worktree returns the worktree's own path, not the main
	// repository — using that as repoRoot would later point `git worktree
	// prune` at the directory this run is about to delete. MainRoot (via
	// --git-common-dir) looks past the linked worktree to the main checkout,
	// same as cmd/delete.go already does; fall back to RepoRoot only when
	// there is no common dir to find (e.g. path is itself a plain repo).
	if root := gitutil.MainRoot(path); root != "" {
		return root, filepath.Base(root), currentBranchOf(path), nil
	}
	if root, rErr := gitutil.RepoRoot(path); rErr == nil && root != "" {
		return root, filepath.Base(root), currentBranchOf(path), nil
	}
	if cfg.WorktreesBase != "" {
		if rel, relErr := filepath.Rel(cfg.WorktreesBase, path); relErr == nil &&
			rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", "", "", nil
		}
	}
	return "", "", "", fmt.Errorf("%s is neither a registered worktree nor a readable git worktree", path)
}

// currentBranchOf returns the branch checked out at dir, or "" if dir has no
// branch to report (detached HEAD, or the git command failed). Used only on
// the unregistered-worktree fallback path, so it must run before the
// directory is removed.
func currentBranchOf(dir string) string {
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return ""
	}
	branch := strings.TrimSpace(string(out))
	if branch == "HEAD" {
		return ""
	}
	return branch
}
