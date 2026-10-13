package webui

import (
	"encoding/json"
	"net/http"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/config"
)

// cmuxReachable reports whether this server can drive cmux at all
// (IsAvailable, not InPane: the server drives cmux from wherever it runs).
// s.cmuxAvailable is the test seam.
func (s *Server) cmuxReachable() bool {
	if s.cmuxAvailable != nil {
		return s.cmuxAvailable()
	}
	return cmux.IsAvailable()
}

// cmuxEnabled is the gate for every cmux feature: reachable, and not turned
// off in Settings. With it false the server behaves as if cmux were not
// running — every cmux endpoint reports unavailable, so the UI hides its
// cmux controls through the checks it already makes.
func (s *Server) cmuxEnabled() bool {
	return s.cmuxReachable() && !s.cmuxDisabled.Load()
}

// SetCmuxFeaturesDisabled sets the gate's initial state from config, before
// the server starts.
func (s *Server) SetCmuxFeaturesDisabled(disabled bool) {
	s.cmuxDisabled.Store(disabled)
}

type settingsDTO struct {
	// InCmux is whether the server can reach cmux, regardless of the toggle;
	// the toggle is greyed out without it.
	InCmux              bool `json:"in_cmux"`
	CmuxFeaturesEnabled bool `json:"cmux_features_enabled"`
}

type settingsUpdate struct {
	CmuxFeaturesEnabled *bool `json:"cmux_features_enabled"`
}

func (s *Server) settings() settingsDTO {
	return settingsDTO{InCmux: s.cmuxReachable(), CmuxFeaturesEnabled: !s.cmuxDisabled.Load()}
}

// handleSettings: GET /api/settings
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.settings())
}

// handleSettingsUpdate: PUT /api/settings
//
// Persists to the config file first and only then flips the live gate, so a
// failed write never leaves the server disagreeing with what it will load on
// restart.
func (s *Server) handleSettingsUpdate(w http.ResponseWriter, r *http.Request) {
	var req settingsUpdate
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.CmuxFeaturesEnabled == nil {
		writeError(w, http.StatusBadRequest, "missing cmux_features_enabled")
		return
	}
	if !s.cmuxReachable() {
		writeError(w, http.StatusConflict, "cmux is not available to this server")
		return
	}
	disabled := !*req.CmuxFeaturesEnabled
	if disabled != s.cmuxDisabled.Load() {
		path := s.ConfigPath
		if path == "" {
			path = config.ConfigPath()
		}
		if err := config.SetCmuxFeaturesDisabled(path, disabled); err != nil {
			writeError(w, http.StatusInternalServerError, "saving config: "+err.Error())
			return
		}
		s.cmuxDisabled.Store(disabled)
		if disabled {
			// The gate is already shut, so no unread pass can put the 📬
			// prefixes back after this takes them off.
			s.cmuxUnreadStrip()
		}
		s.logger().Printf("settings: cmux features %s", map[bool]string{true: "disabled", false: "enabled"}[disabled])
	}
	writeJSON(w, http.StatusOK, s.settings())
}
