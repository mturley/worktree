package webui

import (
	"encoding/json"
	"net/http"
	"sort"

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
	ReuseBranch  bool   `json:"reuse_branch"`
	ResetToPR    bool   `json:"reset_to_pr"`
	// DeclineReset is "the user was asked to reset and said no", which is a
	// different thing from ResetToPR being false ("not asked yet"). Without
	// it the client cannot decline: re-posting would raise the same question
	// forever, and closing the modal would strand a worktree git has already
	// created — on disk, unregistered, holding no port range.
	DeclineReset bool `json:"decline_reset"`
}

type createWorktreeResponse struct {
	OK      bool                 `json:"ok"`
	Confirm *worktreenew.Confirm `json:"confirm"`
	Steps   []worktreenew.Step   `json:"steps"`
	Path    string               `json:"path,omitempty"`
	Branch  string               `json:"branch,omitempty"`
	Error   string               `json:"error,omitempty"`
}

// handleCreateWorktree: POST /api/worktrees/create
//
// A pending confirmation comes back as 200 with a non-null `confirm`, never an
// error status: "git wants an answer" and "the create broke" are the one
// distinction the flow rests on. A hard failure is also 200 with ok:false, so
// the modal renders the partial step list instead of an error page.
//
// There is no server-side session. The client answers by re-POSTing the whole
// request with the matching flag set, and the runner replays from the top.
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

	cfg, err := config.Load()
	if err != nil {
		writeJSON(w, http.StatusOK, createWorktreeResponse{
			OK: false, Steps: []worktreenew.Step{}, Error: err.Error(),
		})
		return
	}

	res := worktreenew.Run(s.DB, cfg, req.options(), nil)

	out := createWorktreeResponse{
		OK:      res.Err == nil,
		Confirm: res.Confirm,
		Steps:   res.Steps,
		Path:    res.Path,
		Branch:  res.Branch,
	}
	if res.Err != nil {
		out.Error = res.Err.Error()
	}
	writeJSON(w, http.StatusOK, out)
}

func (req createWorktreeRequest) options() worktreenew.Options {
	return worktreenew.Options{
		Input:        req.Input,
		RepoRoot:     req.RepoRoot,
		Pull:         req.Pull,
		CopyDotfiles: req.CopyDotfiles,
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
