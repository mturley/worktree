package webui

import (
	"net/http"
	"strings"

	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/shellenv"
)

type envVarDTO struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type worktreeInfoDTO struct {
	Env []envVarDTO     `json:"env"`
	Git *gitutil.Status `json:"git,omitempty"`
}

// handleWorktreeInfo: GET /api/worktree-info?path=<path>
//
// The detail page's header card shows the same environment `worktree info`
// prints, plus a short git status. Deliberately a per-worktree endpoint rather
// than fields on the worktree LIST: git status costs a git subprocess, and the
// home page renders every worktree — one call for the worktree being viewed is
// cheap, N calls per page load is not.
func (s *Server) handleWorktreeInfo(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}

	out := worktreeInfoDTO{Env: []envVarDTO{}}

	lines, err := shellenv.Lines(s.DB, path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, line := range lines {
		if kv, ok := parseExportLine(line); ok {
			out.Env = append(out.Env, kv)
		}
	}

	// A worktree can be registered but gone from disk; missing status is a
	// normal state the UI omits, not an error.
	if st, ok := gitutil.ShortStatus(path); ok {
		out.Git = &st
	}

	writeJSON(w, http.StatusOK, out)
}

// parseExportLine splits shellenv's `export KEY=VALUE` (VALUE possibly
// %q-quoted) into a key and an unquoted value.
func parseExportLine(line string) (envVarDTO, bool) {
	rest, ok := strings.CutPrefix(line, "export ")
	if !ok {
		return envVarDTO{}, false
	}
	key, value, ok := strings.Cut(rest, "=")
	if !ok {
		return envVarDTO{}, false
	}
	// shellenv writes some values with %q; show the value, not its quoting.
	if len(value) >= 2 && strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
		value = value[1 : len(value)-1]
	}
	return envVarDTO{Key: key, Value: value}, true
}
