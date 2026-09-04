package webui

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
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
	list := cmux.ListWorkspaces
	if s.cmuxList != nil {
		list = s.cmuxList
	}
	workspaces, err := list()
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
		listGroups := cmux.ListGroups
		if s.cmuxListGroups != nil {
			listGroups = s.cmuxListGroups
		}
		if groups, err := listGroups(); err == nil {
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

// worktreeDetailURL builds the worktree detail page URL for a given path.
// The route is a path SEGMENT (/worktree/:path*), not a query parameter —
// see ui/src/App.tsx and cmd/ui.go's equivalent construction. Uses 127.0.0.1
// to match what Server.Start() actually binds.
func worktreeDetailURL(port int, path string) string {
	// ?home=<path> marks the tab as belonging to this worktree, so the UI can
	// offer a way back once you navigate elsewhere in it. The CLI's equivalent
	// lives in cmd's detailPathForToplevel; both are "open the UI for THIS
	// worktree", and a workspace pane is the case where wandering off is most
	// likely — and the case where a sleeping pane loses everything but its URL.
	return fmt.Sprintf("http://127.0.0.1:%d/worktree/%s?home=%s",
		port, url.PathEscape(path), url.QueryEscape(path))
}

type cmuxCreateRequest struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	GroupRef string `json:"group_ref"`
	Color    string `json:"color"`
}

// handleCmuxCreate: POST /api/cmux/create
//
// Builds the same layout `worktree new` does, but from the worktree's
// resources AS THEY ARE NOW — usually better than at creation time, since
// resources get added later. The server knows its own port, so the pinned UI
// tab is easier here than in the CLI, where runningUIDetailURL has to probe
// for a listener.
func (s *Server) handleCmuxCreate(w http.ResponseWriter, r *http.Request) {
	var req cmuxCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	if !cmux.IsAvailable() {
		writeJSON(w, http.StatusOK, cmuxActionResponse{OK: false, Error: "cmux is not running"})
		return
	}

	var urls []string
	if s.DB != nil {
		if res, err := resources.Load(s.DB, req.Path); err == nil {
			for _, x := range resources.OfType(res, "pr") {
				if x.URL != "" {
					urls = append(urls, x.URL)
				}
			}
			for _, x := range resources.OfType(res, "jira") {
				if !x.Related && x.URL != "" {
					urls = append(urls, x.URL)
				}
			}
		}
	}

	uiURL := worktreeDetailURL(s.Port, req.Path)

	opts := cmux.NewWorkspaceOptions{
		Name:     req.Name,
		Cwd:      req.Path,
		Focus:    true,
		GroupRef: req.GroupRef,
		Layout:   cmux.BuildLayout(uiURL, urls),
	}
	ref, err := cmux.NewWorkspace(opts)
	if err != nil {
		writeJSON(w, http.StatusOK, cmuxActionResponse{OK: false, Error: err.Error()})
		return
	}

	// Everything past creation is best-effort: a workspace that exists but
	// missed its colour is still a usable workspace.
	if req.Color != "" {
		cmux.SetWorkspaceColor(ref, req.Color)
	}
	cmux.PinBrowserTabs(ref)
	cmux.FocusFirstBrowserTab(ref)
	cmux.Activate()

	writeJSON(w, http.StatusOK, cmuxActionResponse{OK: true, Ref: ref})
}
