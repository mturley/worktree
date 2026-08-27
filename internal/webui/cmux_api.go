package webui

import (
	"encoding/json"
	"net/http"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/registry"
)

type cmuxWorkspaceDTO struct {
	Ref      string `json:"ref"`
	Title    string `json:"title"`
	Color    string `json:"color,omitempty"` // hex, empty when unset
	Selected bool   `json:"selected"`
}

type cmuxResponse struct {
	Available bool                          `json:"available"`
	Matches   map[string][]cmuxWorkspaceDTO `json:"matches,omitempty"`
}

// handleCmux: GET /api/cmux
//
// Returns availability plus a path -> workspaces map keyed by exactly the
// paths the UI already holds, so the client does no path logic. Matching runs
// in Go because it resolves symlinks, which TypeScript cannot do.
//
// Every failure degrades to available:false rather than an error status: the
// section simply does not render, which is the same thing the UI does when
// cmux is not running at all. A 5xx here would break a page over a missing
// terminal multiplexer.
func (s *Server) handleCmux(w http.ResponseWriter, r *http.Request) {
	if !cmux.IsAvailable() {
		writeJSON(w, http.StatusOK, cmuxResponse{Available: false})
		return
	}
	workspaces, err := cmux.ListWorkspaces()
	if err != nil {
		writeJSON(w, http.StatusOK, cmuxResponse{Available: false})
		return
	}

	var paths []string
	if s.DB != nil {
		if entries, err := registry.List(s.DB); err == nil {
			for _, e := range entries {
				paths = append(paths, e.Path)
			}
		}
	}

	matches := make(map[string][]cmuxWorkspaceDTO)
	for path, hits := range cmux.Match(workspaces, paths) {
		dtos := make([]cmuxWorkspaceDTO, 0, len(hits))
		for _, ws := range hits {
			dto := cmuxWorkspaceDTO{
				Ref:      ws.Ref,
				Title:    ws.DisplayTitle(),
				Selected: ws.Selected,
			}
			if ws.CustomColor != nil {
				dto.Color = *ws.CustomColor
			}
			dtos = append(dtos, dto)
		}
		matches[path] = dtos
	}

	writeJSON(w, http.StatusOK, cmuxResponse{Available: true, Matches: matches})
}

type cmuxGroupDTO struct {
	Ref  string `json:"ref"`
	Name string `json:"name"`
}

type cmuxColorDTO struct {
	Name string `json:"name"`
	Hex  string `json:"hex"`
}

type cmuxGroupsResponse struct {
	Groups []cmuxGroupDTO `json:"groups"`
	Colors []cmuxColorDTO `json:"colors"`
}

// handleCmuxGroups: GET /api/cmux-groups
//
// Fetched only when a modal opens, which keeps the polled /api/cmux endpoint
// to a single exec. Colours come from cmux.NamedColors rather than a
// duplicated TS constant, so the swatches have one source of truth.
func (s *Server) handleCmuxGroups(w http.ResponseWriter, r *http.Request) {
	out := cmuxGroupsResponse{Groups: []cmuxGroupDTO{}, Colors: []cmuxColorDTO{}}
	for _, c := range cmux.NamedColors {
		out.Colors = append(out.Colors, cmuxColorDTO{Name: c.Name, Hex: c.Hex})
	}
	if cmux.IsAvailable() {
		if groups, err := cmux.ListGroups(); err == nil {
			for _, g := range groups {
				out.Groups = append(out.Groups, cmuxGroupDTO{Ref: g.Ref, Name: g.Name})
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type cmuxSelectRequest struct {
	Ref string `json:"ref"`
}

type cmuxActionResponse struct {
	OK    bool   `json:"ok"`
	Ref   string `json:"ref,omitempty"`
	Error string `json:"error,omitempty"`
}

// handleCmuxSelect: POST /api/cmux/select
//
// Always activates after a successful select: harmless when cmux is already
// frontmost, and essential when the click came from an external browser rather
// than a cmux browser pane. Activation failure is not a select failure.
func (s *Server) handleCmuxSelect(w http.ResponseWriter, r *http.Request) {
	var req cmuxSelectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Ref == "" {
		writeError(w, http.StatusBadRequest, "missing ref")
		return
	}
	if err := cmux.SelectWorkspace(req.Ref); err != nil {
		writeJSON(w, http.StatusOK, cmuxActionResponse{OK: false, Error: err.Error()})
		return
	}
	cmux.Activate()
	writeJSON(w, http.StatusOK, cmuxActionResponse{OK: true, Ref: req.Ref})
}
