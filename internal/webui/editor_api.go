package webui

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/registry"
)

type openEditorRequest struct {
	Path string `json:"path"`
}

// handleOpenEditor: POST /api/worktrees/open-editor
//
// Runs the configured editor command with the worktree's path, as
// `worktree open` does. Only the config's `editor` counts, not $EDITOR: the
// server has no terminal to give a terminal editor, so the UI disables its
// button until one is set in Settings → General.
//
// The path must be a registered worktree, so the endpoint cannot be used to
// hand the editor an arbitrary argument.
func (s *Server) handleOpenEditor(w http.ResponseWriter, r *http.Request) {
	var req openEditorRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	// Read per request, like GET /api/settings, so an edit in the Settings
	// modal or by hand applies at once.
	e, _, err := config.ReadEditable(s.configPath())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading config: "+err.Error())
		return
	}
	editor := strings.TrimSpace(e.Editor)
	if editor == "" {
		writeError(w, http.StatusConflict, "no editor configured")
		return
	}
	entry, err := registry.Get(s.DB, req.Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if entry == nil {
		writeError(w, http.StatusNotFound, "not a registered worktree")
		return
	}

	start := s.startEditor
	if start == nil {
		start = startDetached
	}
	if err := start(editor, entry.Path); err != nil {
		writeError(w, http.StatusInternalServerError, "starting "+editor+": "+err.Error())
		return
	}
	s.logger().Printf("opened %s in %s", entry.Path, editor)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// startDetached starts a command without waiting for it: a GUI editor's CLI
// usually returns at once, but one that stays in the foreground must not hold
// the request open. The goroutine reaps it whenever it exits.
func startDetached(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
