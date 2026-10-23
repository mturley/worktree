package webui

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/registry"
)

type openEditorRequest struct {
	Path string `json:"path"`
	// File, when present, is a worktree-relative file to open alongside the
	// worktree. A pointer so an explicit empty string is refused rather than
	// silently treated as "no file".
	File *string `json:"file,omitempty"`
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

	args := []string{entry.Path}
	if req.File != nil {
		abs, status, msg := resolveWorktreeFile(entry.Path, *req.File)
		if status != 0 {
			writeError(w, status, msg)
			return
		}
		// The worktree stays the first argument so the editor opens (or
		// reuses) its window and then focuses the file in it.
		args = append(args, abs)
	}

	run := s.startEditor
	if run == nil {
		run = runEditor
	}
	if err := run(editor, args...); err != nil {
		writeError(w, http.StatusInternalServerError, editor+": "+err.Error())
		return
	}
	s.logger().Printf("opened %s in %s", entry.Path, editor)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// resolveWorktreeFile turns a worktree-relative file from the request into
// the absolute path to hand the editor. On refusal it returns the HTTP status
// and message (status 0 means success). The name comes from the client, so it
// must be relative with no `..`, and after symlinks are resolved it must still
// lie inside the worktree: a tracked symlink pointing out of the tree must not
// let this endpoint open arbitrary files.
func resolveWorktreeFile(worktree, file string) (abs string, status int, msg string) {
	if strings.TrimSpace(file) == "" {
		return "", http.StatusBadRequest, "empty file"
	}
	if filepath.IsAbs(file) {
		return "", http.StatusBadRequest, "file must be relative"
	}
	clean := filepath.Clean(file)
	if clean == "." {
		return "", http.StatusBadRequest, "file must name a file"
	}
	for _, part := range strings.Split(filepath.ToSlash(clean), "/") {
		if part == ".." {
			return "", http.StatusBadRequest, "file must not contain .."
		}
	}
	abs = filepath.Join(worktree, clean)
	root, err := filepath.EvalSymlinks(worktree)
	if err != nil {
		return "", http.StatusInternalServerError, "resolving worktree: " + err.Error()
	}
	real, err := filepath.EvalSymlinks(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return "", http.StatusNotFound, "file not found"
	}
	if err != nil {
		return "", http.StatusInternalServerError, "resolving file: " + err.Error()
	}
	// The trailing separator keeps /a/wt2 from counting as inside /a/wt.
	if !strings.HasPrefix(real+string(filepath.Separator), root+string(filepath.Separator)) {
		return "", http.StatusBadRequest, "file is outside the worktree"
	}
	return abs, 0, ""
}

// editorWaitLimit caps how long the request waits for the editor command.
var editorWaitLimit = 20 * time.Second // a var for tests

// runEditor runs the editor command and waits for it, so the button's
// spinner lasts while a GUI editor's CLI (`code`, `cursor`, `zed`) launches
// the app, and a failure (non-zero exit) comes back as an error. An editor
// that stays in the foreground would hold the request forever, so after
// editorWaitLimit it is left running, reaped whenever it exits, and the open
// counts as done.
func runEditor(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			if msg := strings.TrimSpace(stderr.String()); msg != "" {
				return fmt.Errorf("%w: %s", err, msg)
			}
		}
		return err
	case <-time.After(editorWaitLimit):
		return nil
	}
}
