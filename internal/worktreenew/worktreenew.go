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
	"strconv"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/dotfiles"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/github"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/resourceurl"
)

// The two calls on the PR path that reach the network — `gh pr view` and the
// `git fetch` inside CreatePRWorktree. They are vars so tests can exercise the
// confirmation state machine without a network or a GitHub account;
// production never reassigns them.
var (
	fetchPRInfo      = github.FetchPRByRepo
	createPRWorktree = gitutil.CreatePRWorktree
	setPRTracking    = gitutil.SetPRTracking
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

	// DeclineReset records that the user was asked to reset to the PR's latest
	// commit and said no. It is distinct from ResetToPR being false, which only
	// means "not asked yet" — without it, a decline would replay into the same
	// question forever, and the caller's only escape would be to abandon a
	// worktree that git has already created.
	DeclineReset bool
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

// record files a step's outcome. Recording a key twice REPLACES the earlier
// entry rather than appending a second one: the step list is keyed by StepKey
// downstream (React renders `key={s.key}`, and streaming consumers upsert by
// key), so a duplicate means a console warning, unreliable reconciliation, and
// — worse — the later entry silently overwriting the earlier one's detail. One
// entry per key makes that class of bug unrepresentable instead of merely
// absent. The observer still fires on a replace, so a streaming consumer
// converges on the same final value the list holds.
func (r *runner) record(key StepKey, status Status, detail string) {
	s := Step{Key: key, Label: labels[key], Status: status, Detail: detail}
	replaced := false
	for i := range r.steps {
		if r.steps[i].Key == key {
			r.steps[i] = s
			replaced = true
			break
		}
	}
	if !replaced {
		r.steps = append(r.steps, s)
	}
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
		// Pending is recorded BEFORE the work, not only after: pull and
		// create_worktree block on the network, and an observer that hears
		// about a step only when it finishes cannot show that anything is
		// happening. record replaces by key, so the pending entry is
		// overwritten by the outcome and the step list stays one-per-key —
		// the observer simply fires twice for these two steps.
		r.record(StepPull, StatusPending, "")
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

	pr, err := parsePRInput(opts.Input, opts.RepoRoot)
	if err != nil {
		return Result{Steps: r.finish(), Err: err}
	}

	var created gitutil.CreateResult
	var primary *resources.Resource
	var prTitle, prBody string

	// Creation reaches the network on the PR path (the `gh` fetch and the
	// `git fetch` inside CreatePRWorktree), so it announces itself first too.
	r.record(StepCreateWorktree, StatusPending, "")

	if pr != nil {
		out, prErr := r.runPR(pr)
		if prErr != nil {
			r.record(StepCreateWorktree, StatusFailed, prErr.Error())
			return Result{Steps: r.finish(), Err: prErr}
		}
		if out.Confirm != nil {
			// Stop: later steps stay pending so the stepper greys them.
			return Result{Steps: r.finish(), Confirm: out.Confirm}
		}
		created, primary = out.Created, out.Primary
		prTitle, prBody = out.Title, out.Body
		// One record for the step, with any non-fatal warning folded into the
		// detail — runPR deliberately records nothing itself.
		detail := created.Path
		if out.Warn != "" {
			detail = created.Path + " (" + out.Warn + ")"
		}
		r.record(StepCreateWorktree, StatusDone, detail)
	} else {
		branch, p := resolveInput(opts.Input)
		primary = p
		existed := false
		if _, statErr := os.Stat(filepath.Join(
			cfg.WorktreesBase, repoDirName(opts.RepoRoot), branch)); statErr == nil {
			existed = true
		}
		created, err = gitutil.CreateBranchWorktree(opts.RepoRoot, cfg.WorktreesBase, branch)
		if err != nil {
			r.record(StepCreateWorktree, StatusFailed, err.Error())
			return Result{Steps: r.finish(), Err: err}
		}
		if existed || !created.Created {
			r.record(StepCreateWorktree, StatusSkipped, "already exists")
		} else {
			r.record(StepCreateWorktree, StatusDone, created.Path)
		}
	}

	r.finalize(created, primary, prTitle, prBody)

	return Result{Steps: r.finish(), Path: created.Path, Branch: created.Branch}
}

// PRInput identifies a pull request to build a worktree from.
type PRInput struct {
	Owner  string
	Repo   string
	Number int
}

// parsePRInput recognizes a PR URL or a bare PR number. For a bare number the
// repo comes from repoRoot's remotes — the web UI passes an explicitly chosen
// repo, where the CLI used to depend on the current directory. A non-PR input
// (branch name, Jira key) yields (nil, nil).
func parsePRInput(input, repoRoot string) (*PRInput, error) {
	if m := resourceurl.PRURLPattern.FindStringSubmatch(input); m != nil {
		n, _ := strconv.Atoi(m[3])
		return &PRInput{Owner: m[1], Repo: m[2], Number: n}, nil
	}
	n, err := strconv.Atoi(input)
	if err != nil {
		return nil, nil
	}
	if repoRoot == "" {
		return nil, fmt.Errorf("a repo is required to resolve PR #%d", n)
	}
	slug := gitutil.RepoSlug(repoRoot)
	parts := strings.SplitN(slug, "/", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("cannot determine repo owner/name from remotes of %s", repoRoot)
	}
	return &PRInput{Owner: parts[0], Repo: parts[1], Number: n}, nil
}

// prOutcome is what the PR path produced. A non-nil Confirm means the run must
// stop and wait for an answer. Warn carries a non-fatal diagnostic for Run to
// fold into its single create_worktree record — runPR never records a step
// itself, because two records under one key would collide downstream.
type prOutcome struct {
	Created gitutil.CreateResult
	Primary *resources.Resource
	Confirm *Confirm
	Warn    string

	// Title and Body are the pull request's, carried through so the resources
	// step can detect Jira keys mentioned in them. runPR already fetched the
	// PR, so threading them here avoids a second `gh` call.
	Title string
	Body  string
}

// runPR creates a worktree from a pull request, pausing for confirmation when
// git needs an answer. Both questions replay: the caller re-invokes Run with
// the matching Options flag set, and the sequence reaches the same point with
// the answer already in hand.
func (r *runner) runPR(pr *PRInput) (prOutcome, error) {
	info, err := fetchPRInfo(pr.Owner, pr.Repo, pr.Number)
	if err != nil {
		return prOutcome{}, err
	}
	if !gitutil.MatchesRemote(r.opts.RepoRoot, pr.Owner, pr.Repo) {
		return prOutcome{},
			fmt.Errorf("%s is not a clone of %s/%s", r.opts.RepoRoot, pr.Owner, pr.Repo)
	}
	remote, err := gitutil.FindRemoteForRepo(r.opts.RepoRoot, pr.Owner, pr.Repo)
	if err != nil {
		return prOutcome{}, err
	}

	res, err := createPRWorktree(
		r.opts.RepoRoot, r.cfg.WorktreesBase, remote, pr.Number, info.HeadRef,
		github.Slugify(info.Title))
	if err != nil {
		return prOutcome{}, err
	}

	switch res.Status {
	case gitutil.PRWorktreeBranchExists:
		if !r.opts.ReuseBranch {
			return prOutcome{Confirm: &Confirm{
				Key: ConfirmReuseBranch, Branch: res.Branch,
				LocalHead: res.LocalHead, RemoteHead: res.RemoteHead,
			}}, nil
		}
		if err := gitutil.CreateWorktreeFromExistingBranch(
			r.opts.RepoRoot, res.Path, res.Branch); err != nil {
			return prOutcome{}, err
		}
		// A reused branch still needs the sync check below.
		fallthrough
	case gitutil.PRWorktreeExistingDir:
		if res.LocalHead != "" && res.RemoteHead != "" && res.LocalHead != res.RemoteHead {
			switch {
			case r.opts.ResetToPR:
				if err := gitutil.ResetHard(res.Path, res.FetchRef); err != nil {
					return prOutcome{}, err
				}
			case r.opts.DeclineReset:
				// Asked and declined. Carry on: the worktree is perfectly
				// usable at its current commit, and re-asking would loop.
			default:
				return prOutcome{Confirm: &Confirm{
					Key: ConfirmResetToPR, Branch: res.Branch,
					LocalHead: res.LocalHead, RemoteHead: res.RemoteHead,
				}}, nil
			}
		}
	}

	var warn string
	if err := setPRTracking(r.opts.RepoRoot, res.Branch, remote, pr.Number); err != nil {
		// Tracking is a convenience (it makes `git pull` follow the PR head),
		// not the deliverable — the worktree is fully usable without it, so
		// the step stays `done` and the failure surfaces as a detail rather
		// than a `failed` status that would imply the creation itself broke.
		warn = "tracking not set: " + err.Error()
	}

	return prOutcome{
		Created: res.CreateResult,
		Primary: &resources.Resource{
			Type: "pr",
			ID:   fmt.Sprintf("%s/%s#%d", pr.Owner, pr.Repo, pr.Number),
			URL:  info.URL,
		},
		Warn:  warn,
		Title: info.Title,
		Body:  info.Body,
	}, nil
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
func (r *runner) finalize(created gitutil.CreateResult, primary *resources.Resource, prTitle, prBody string) {
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

	r.trackResources(created, primary, prTitle, prBody)

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

// trackResources records the primary resource and any Jira issues mentioned in
// the branch name or the PR's title/body.
//
// The Jira detection used to live in cmd/root.go (detectAndSaveJiraIssues), so
// it worked from the terminal only. Keeping it there while the web UI drove
// this runner would have made the two surfaces disagree about which issues a
// worktree tracks — precisely the divergence this package exists to prevent.
// It reports through the step's detail rather than stdout: an HTTP request
// drives this code too, and the runner must never print.
func (r *runner) trackResources(created gitutil.CreateResult, primary *resources.Resource, prTitle, prBody string) {
	if r.conn == nil {
		r.record(StepResources, StatusSkipped, "no database")
		return
	}

	var tracked, failures []string
	if primary != nil {
		if err := resources.Add(r.conn, created.Path, *primary); err != nil {
			failures = append(failures, primary.ID+": "+err.Error())
		} else {
			tracked = append(tracked, primary.ID)
		}
	}

	if len(r.cfg.Jira.Projects) > 0 {
		// Load AFTER adding the primary, so an issue that is already tracked —
		// including the one just added — is not added a second time.
		existing, _ := resources.Load(r.conn, created.Path)
		seen := make(map[string]bool, len(existing))
		for _, res := range existing {
			if res.Type == "jira" {
				seen[res.ID] = true
			}
		}
		host := jira.HostFromWatcherConfig()
		for _, key := range jira.DetectKeys(created.Branch, prTitle, prBody, r.cfg.Jira.Projects) {
			if seen[key] {
				continue
			}
			seen[key] = true
			res := resources.Resource{Type: "jira", ID: key, URL: jira.IssueURL(host, key)}
			if err := resources.Add(r.conn, created.Path, res); err != nil {
				failures = append(failures, key+": "+err.Error())
			} else {
				tracked = append(tracked, key)
			}
		}
	}

	switch {
	case len(failures) > 0:
		r.record(StepResources, StatusFailed, strings.Join(failures, "; "))
	case len(tracked) == 0:
		r.record(StepResources, StatusSkipped, "nothing to track")
	default:
		r.record(StepResources, StatusDone, strings.Join(tracked, ", "))
	}
}
