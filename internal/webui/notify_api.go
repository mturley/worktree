package webui

import (
	"encoding/json"
	"net/http"
	"path/filepath"

	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

type setNotifyRequest struct {
	Path string `json:"path"`
	Type string `json:"type,omitempty"` // empty with ID: the worktree-wide toggle
	ID   string `json:"id,omitempty"`
	On   bool   `json:"on"`
	Tab  string `json:"tab,omitempty"` // browser mode: where the test notification goes first
}

// handleSetNotify: POST /api/notify
//
// Stores one toggle; turning one ON also sends a test notification through
// the real delivery path, so the user sees at once that it works where they
// are (or learns that it does not).
func (s *Server) handleSetNotify(w http.ResponseWriter, r *http.Request) {
	var req setNotifyRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	if (req.Type == "") != (req.ID == "") {
		writeError(w, http.StatusBadRequest, "type and id go together")
		return
	}
	if req.Type == "link" {
		writeError(w, http.StatusBadRequest, "links are never polled, so they have no events to notify about")
		return
	}
	entry, err := registry.Get(s.DB, req.Path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if entry == nil {
		writeError(w, http.StatusNotFound, "worktree not registered")
		return
	}

	label := ""
	if req.Type == "" {
		err = notifyprefs.SetAll(s.DB, req.Path, req.On)
	} else {
		rs, lerr := resources.Load(s.DB, req.Path)
		if lerr != nil {
			writeError(w, http.StatusInternalServerError, lerr.Error())
			return
		}
		var hit *resources.Resource
		for i := range rs {
			if rs[i].Type == req.Type && rs[i].ID == req.ID {
				hit = &rs[i]
			}
		}
		if hit == nil {
			writeError(w, http.StatusNotFound, "resource not tracked by this worktree")
			return
		}
		label = notifyResourceLabel(s.newResourceDTO(*hit))
		err = notifyprefs.SetResource(s.DB, req.Path, req.Type, req.ID, req.On)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if req.On {
		name := filepath.Base(req.Path)
		body := "You'll be notified about new events for " + label
		if req.Type == "" {
			body = "You'll be notified about new events for all resources in " + name
		}
		sess, _ := currentSession(r)
		s.deliver(notifyBatch{
			WorktreePath: req.Path, ResourceType: req.Type, ResourceID: req.ID,
			Title: "Notifications on", Subtitle: name, Body: body,
			Tag: notifyTag(req.Path, req.Type, req.ID),
		}, deliverOpts{PreferTab: req.Tab, OnlySession: sess.Handle})
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": s.notifyMode()})
}
