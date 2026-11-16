package webui

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/mturley/worktree/internal/addcheck"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/dotfiles"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/slackurl"
	"github.com/mturley/worktree/internal/worktreenew"
)

type createWorktreeRequest struct {
	Input        string `json:"input"`
	RepoRoot     string `json:"repo_root"`
	Pull         bool   `json:"pull"`
	CopyDotfiles bool   `json:"copy_dotfiles"`
	// Branch is the user's chosen branch for a PR or Jira input; empty means
	// the default the modal fetched from /api/worktrees/default-branch.
	Branch      string `json:"branch"`
	ReuseBranch bool   `json:"reuse_branch"`
	ResetToPR   bool   `json:"reset_to_pr"`
	// DeclineReset is "the user was asked to reset and said no", which is a
	// different thing from ResetToPR being false ("not asked yet"). Without
	// it the client cannot decline: re-posting would raise the same question
	// forever, and closing the modal would strand a worktree git has already
	// created — on disk, unregistered, holding no port range.
	DeclineReset bool `json:"decline_reset"`
}

// handleCreateWorktree: POST /api/worktrees/create
//
// The create runs as a background job: this route only validates the request
// and starts one, so a closed tab or a slept machine cannot strand a run
// half-finished. Everything the client needs afterwards comes from
// /api/jobs and the `job` stream events.
//
// What the route still rejects itself is what no job should ever exist for: a
// request too incomplete to name a worktree, and an input that was never a
// branch to begin with.
func (s *Server) handleCreateWorktree(w http.ResponseWriter, r *http.Request) {
	var req createWorktreeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Input == "" {
		writeError(w, http.StatusBadRequest, "missing input")
		return
	}
	if req.RepoRoot == "" {
		writeError(w, http.StatusBadRequest, "missing repo_root")
		return
	}
	// Mirror the CLI's rejection so neither surface can create a branch named
	// after a URL that only ever named a resource.
	if _, _, ok := slackurl.Parse(req.Input); ok {
		writeError(w, http.StatusBadRequest,
			"Slack threads are tracked as a resource, not a worktree — add it from the worktree's resource list")
		return
	}
	if addcheck.ExistingWorktreeDir(req.Input) {
		writeError(w, http.StatusBadRequest,
			"that path is already a worktree — open it from the worktree list instead")
		return
	}

	// The target dedupes: a second request for the same input in the same
	// repo attaches to the job already running rather than starting a rival
	// one. A NUL joins the two halves because no path and no branch name can
	// contain one, so no pair of (repo, input) can collide on it.
	input := strings.TrimSpace(req.Input)
	s.startJob(w, jobKindCreate, "New worktree "+input, req.RepoRoot+"\x00"+input, req)
}

// createConfig is the config a creation runs under. The live gates are what
// this server does; a PR-based create must not reach GitHub while its watcher
// is off here.
func (s *Server) createConfig() (config.Config, error) {
	cfg, err := config.Load()
	if err != nil {
		return cfg, err
	}
	for _, svc := range config.Services {
		cfg.Watchers.SetEnabled(svc, s.WatcherEnabled(svc))
	}
	return cfg, nil
}

type defaultBranchResponse struct {
	Branch string `json:"branch"`
	Error  string `json:"error,omitempty"`
}

// handleDefaultBranch: GET /api/worktrees/default-branch?input=...&repo_root=...
//
// The branch a PR or Jira input would get, so the modal can offer it for
// editing. Empty for a plain branch name, which is already the branch. A PR's
// default needs its title from GitHub; a failure comes back as 200 with
// `error` set, since the create itself will report the same problem.
func (s *Server) handleDefaultBranch(w http.ResponseWriter, r *http.Request) {
	input := r.URL.Query().Get("input")
	if input == "" {
		writeError(w, http.StatusBadRequest, "missing input")
		return
	}
	cfg, err := s.createConfig()
	if err != nil {
		writeJSON(w, http.StatusOK, defaultBranchResponse{Error: err.Error()})
		return
	}
	branch, err := worktreenew.DefaultBranch(cfg, input, r.URL.Query().Get("repo_root"))
	if err != nil {
		writeJSON(w, http.StatusOK, defaultBranchResponse{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, defaultBranchResponse{Branch: branch})
}

func (req createWorktreeRequest) options() worktreenew.Options {
	return worktreenew.Options{
		Input:        req.Input,
		RepoRoot:     req.RepoRoot,
		Pull:         req.Pull,
		CopyDotfiles: req.CopyDotfiles,
		Branch:       req.Branch,
		ReuseBranch:  req.ReuseBranch,
		ResetToPR:    req.ResetToPR,
		DeclineReset: req.DeclineReset,
	}
}

type repoDTO struct {
	Name     string `json:"name"`
	RepoRoot string `json:"repo_root"`
}

// handleRepos: GET /api/repos
//
// The CLI takes the repo from the current directory; a server has none, so the
// list comes from the registry. Sorted by each repo's most recently created
// worktree, so the repo you are actually working in leads the list.
//
// Known limitation: a repo with no registered worktrees does not appear. Its
// first worktree is still created from the CLI.
func (s *Server) handleRepos(w http.ResponseWriter, r *http.Request) {
	out := []repoDTO{}
	if s.DB == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}
	entries, err := registry.List(s.DB)
	if err != nil {
		writeJSON(w, http.StatusOK, out)
		return
	}

	newest := map[string]string{}
	name := map[string]string{}
	for _, e := range entries {
		if e.RepoRoot == "" {
			continue
		}
		if e.CreatedAt > newest[e.RepoRoot] {
			newest[e.RepoRoot] = e.CreatedAt
		}
		name[e.RepoRoot] = e.Repo
	}
	for root := range newest {
		out = append(out, repoDTO{Name: name[root], RepoRoot: root})
	}
	sort.Slice(out, func(i, j int) bool {
		return newest[out[i].RepoRoot] > newest[out[j].RepoRoot]
	})
	writeJSON(w, http.StatusOK, out)
}

// handleRepoDotfiles: GET /api/repo-dotfiles?repo_root=...
//
// Feeds the modal's dotfiles checkbox, which lists what it would copy.
// Unchecked by default: copying .env files nobody asked for is exactly the
// surprise the CLI's prompt exists to prevent.
func (s *Server) handleRepoDotfiles(w http.ResponseWriter, r *http.Request) {
	root := r.URL.Query().Get("repo_root")
	if root == "" {
		writeError(w, http.StatusBadRequest, "missing repo_root")
		return
	}
	names := []string{}
	if dfs, err := dotfiles.Discover(root); err == nil {
		for _, d := range dfs {
			names = append(names, d.Name)
		}
	}
	writeJSON(w, http.StatusOK, names)
}
