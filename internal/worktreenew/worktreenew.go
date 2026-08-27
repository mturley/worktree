// Package worktreenew runs the worktree creation sequence.
//
// It exists so the CLI and the web UI share one sequence rather than two
// copies, exactly as internal/worktreedel does for deletion. The steps used to
// live inline across cmd/root.go (handleBranch, handleJiraIssue, handlePR,
// finalizeWorktree); a second copy in the HTTP handler would drift silently,
// and the symptom — a web-created worktree that never allocated a port range —
// stays invisible until the range runs out.
//
// Every run is complete and idempotent. There is no server-side session: a
// confirmation is answered by replaying the whole request with the answer set,
// so each step must tolerate having already been done and report `skipped`
// rather than failing.
package worktreenew

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/dotfiles"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

type StepKey string

const (
	StepPull           StepKey = "pull"
	StepCreateWorktree StepKey = "create_worktree"
	StepAllocatePorts  StepKey = "allocate_ports"
	StepRegister       StepKey = "register"
	StepKubeconfig     StepKey = "kubeconfig"
	StepResources      StepKey = "resources"
	StepDotfiles       StepKey = "dotfiles"
	StepCmuxWorkspace  StepKey = "cmux_workspace"
)

type Status string

const (
	StatusDone    Status = "done"
	StatusSkipped Status = "skipped"
	StatusFailed  Status = "failed"
	StatusPending Status = "pending"
)

type Step struct {
	Key    StepKey `json:"key"`
	Label  string  `json:"label"`
	Status Status  `json:"status"`
	Detail string  `json:"detail,omitempty"`
}

// ConfirmKey names a pending question. It is its own type rather than a
// StepKey because both questions arise inside create_worktree, so a step key
// could not tell them apart.
type ConfirmKey string

const (
	ConfirmReuseBranch ConfirmKey = "reuse_branch"
	ConfirmResetToPR   ConfirmKey = "reset_to_pr"
)

// Confirm carries what a caller needs in order to answer. LocalHead and
// RemoteHead are empty when the branch is already synced.
type Confirm struct {
	Key        ConfirmKey `json:"key"`
	Branch     string     `json:"branch"`
	LocalHead  string     `json:"local_head,omitempty"`
	RemoteHead string     `json:"remote_head,omitempty"`
}

type Options struct {
	Input        string // branch name, Jira key/URL, PR number, or PR URL
	RepoRoot     string
	Pull         bool
	CopyDotfiles bool

	// Answers carried on the replay.
	ReuseBranch bool
	ResetToPR   bool
}

type Result struct {
	Steps   []Step   `json:"steps"`
	Confirm *Confirm `json:"confirm"`
	Path    string   `json:"path,omitempty"`
	Branch  string   `json:"branch,omitempty"`
	Err     error    `json:"-"`
}

var labels = map[StepKey]string{
	StepPull:           "Pull latest",
	StepCreateWorktree: "Create worktree",
	StepAllocatePorts:  "Allocate port range",
	StepRegister:       "Register worktree",
	StepKubeconfig:     "Seed kubeconfig",
	StepResources:      "Track resources",
	StepDotfiles:       "Copy dotfiles",
	StepCmuxWorkspace:  "cmux workspace",
}

// order is the full sequence, used to fill in `pending` for steps a stopped
// run never reached — the stepper greys them rather than pretending they were
// skipped.
var order = []StepKey{
	StepPull, StepCreateWorktree, StepAllocatePorts, StepRegister,
	StepKubeconfig, StepResources, StepDotfiles,
}

type runner struct {
	conn    *sql.DB
	cfg     config.Config
	opts    Options
	observe func(Step)
	steps   []Step
}

func (r *runner) record(key StepKey, status Status, detail string) {
	s := Step{Key: key, Label: labels[key], Status: status, Detail: detail}
	r.steps = append(r.steps, s)
	if r.observe != nil {
		r.observe(s)
	}
}

// finish pads the step list with `pending` entries for everything the run
// never reached.
func (r *runner) finish() []Step {
	seen := make(map[StepKey]bool, len(r.steps))
	for _, s := range r.steps {
		seen[s.Key] = true
	}
	out := r.steps
	for _, k := range order {
		if !seen[k] {
			out = append(out, Step{Key: k, Label: labels[k], Status: StatusPending})
		}
	}
	return out
}

// Run executes the creation sequence, reporting each step to observe as it
// completes. observe may be nil.
func Run(conn *sql.DB, cfg config.Config, opts Options, observe func(Step)) Result {
	r := &runner{conn: conn, cfg: cfg, opts: opts, observe: observe}

	if info, err := os.Stat(opts.RepoRoot); err != nil || !info.IsDir() {
		return Result{Steps: r.finish(), Err: fmt.Errorf("repo root not found: %s", opts.RepoRoot)}
	}

	// Pull first, so the new worktree branches from current upstream.
	if opts.Pull {
		if err := gitutil.Pull(opts.RepoRoot); err != nil {
			// A failed pull is not fatal — the worktree is still creatable
			// from whatever the local clone has.
			r.record(StepPull, StatusFailed, err.Error())
		} else {
			r.record(StepPull, StatusDone, "")
		}
	} else {
		r.record(StepPull, StatusSkipped, "not requested")
	}

	branch, primary := resolveInput(opts.Input)

	existed := false
	if _, err := os.Stat(filepath.Join(cfg.WorktreesBase, repoDirName(opts.RepoRoot), branch)); err == nil {
		existed = true
	}

	created, err := gitutil.CreateBranchWorktree(opts.RepoRoot, cfg.WorktreesBase, branch)
	if err != nil {
		r.record(StepCreateWorktree, StatusFailed, err.Error())
		return Result{Steps: r.finish(), Err: err}
	}
	if existed || !created.Created {
		r.record(StepCreateWorktree, StatusSkipped, "already exists")
	} else {
		r.record(StepCreateWorktree, StatusDone, created.Path)
	}

	r.finalize(created, primary)

	return Result{Steps: r.finish(), Path: created.Path, Branch: created.Branch}
}

// resolveInput turns the polymorphic input into a branch name and, for a Jira
// issue, the resource to record as primary. PR inputs are handled by the
// caller before reaching here (see Task 9).
func resolveInput(input string) (branch string, primary *resources.Resource) {
	if jira.IsJiraURL(input) {
		if key, ok := jira.ParseJiraURL(input); ok {
			return strings.ToLower(key), &resources.Resource{Type: "jira", ID: key, URL: input}
		}
	}
	if key, ok := jira.ParseKey(input); ok {
		return strings.ToLower(key), &resources.Resource{Type: "jira", ID: key}
	}
	return input, nil
}

func repoDirName(repoRoot string) string {
	if main := gitutil.MainRoot(repoRoot); main != "" {
		return filepath.Base(main)
	}
	return filepath.Base(repoRoot)
}

// finalize runs the post-creation sequence. Every step here is best-effort:
// a failure is recorded and the run continues, because stopping would leave
// more mess than proceeding — the same choice worktreedel makes for cleanup.
func (r *runner) finalize(created gitutil.CreateResult, primary *resources.Resource) {
	mainRoot := gitutil.MainRoot(r.opts.RepoRoot)
	if mainRoot == "" {
		mainRoot = r.opts.RepoRoot
	}
	repoName := filepath.Base(mainRoot)
	wtName := filepath.Base(created.Path)

	if r.conn == nil {
		r.record(StepAllocatePorts, StatusSkipped, "no database")
		r.record(StepRegister, StatusSkipped, "no database")
	} else {
		if _, err := ports.Allocate(r.conn, wtName); err != nil {
			r.record(StepAllocatePorts, StatusFailed, err.Error())
		} else {
			r.record(StepAllocatePorts, StatusDone, "")
		}
		entry := registry.Entry{
			Path: created.Path, Repo: repoName, RepoRoot: mainRoot,
			Branch: created.Branch, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		}
		if err := registry.Register(r.conn, entry); err != nil {
			r.record(StepRegister, StatusFailed, err.Error())
		} else {
			r.record(StepRegister, StatusDone, "")
		}
	}

	kubePath := env.KubeconfigPath(repoName, wtName)
	if _, err := os.Stat(kubePath); err == nil {
		r.record(StepKubeconfig, StatusSkipped, "already present")
	} else if err := env.SeedKubeconfig(kubePath); err != nil {
		r.record(StepKubeconfig, StatusFailed, err.Error())
	} else {
		r.record(StepKubeconfig, StatusDone, kubePath)
	}

	if primary == nil || r.conn == nil {
		r.record(StepResources, StatusSkipped, "nothing to track")
	} else if err := resources.Add(r.conn, created.Path, *primary); err != nil {
		r.record(StepResources, StatusFailed, err.Error())
	} else {
		r.record(StepResources, StatusDone, primary.ID)
	}

	if !r.opts.CopyDotfiles {
		r.record(StepDotfiles, StatusSkipped, "not requested")
		return
	}
	dfs, err := dotfiles.Discover(mainRoot)
	if err != nil || len(dfs) == 0 {
		r.record(StepDotfiles, StatusSkipped, "none found")
		return
	}
	var failed []string
	for _, df := range dfs {
		if err := dotfiles.Copy(df.Path, created.Path, df); err != nil {
			failed = append(failed, df.Name)
		}
	}
	if len(failed) > 0 {
		r.record(StepDotfiles, StatusFailed, "failed: "+strings.Join(failed, ", "))
	} else {
		r.record(StepDotfiles, StatusDone, fmt.Sprintf("%d copied", len(dfs)))
	}
}
