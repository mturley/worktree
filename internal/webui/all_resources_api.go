package webui

import (
	"net/http"

	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/selfid"
)

// resourceWorktree names one worktree following a resource.
type resourceWorktree struct {
	Path   string `json:"path"`
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
}

// allResourceDTO is one resource on the home page's Resources tab: the same
// enriched resourceDTO the cards use, once per resource however many
// worktrees follow it, with those worktrees in registry order — the first
// is where "Details" goes.
type allResourceDTO struct {
	resourceDTO
	Worktrees []resourceWorktree `json:"worktrees"`
	// Mine: a PR the user opened, or a Jira issue assigned to or reported by
	// the user. Always false until selfid has resolved the source.
	Mine bool `json:"mine,omitempty"`
}

// handleAllResources lists every resource followed by any registered
// worktree. Primary is the per-worktree Focus flag and means nothing across
// worktrees, so it is true when ANY follower has the resource in focus.
func (s *Server) handleAllResources(w http.ResponseWriter, r *http.Request) {
	entries, err := registry.List(s.DB)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	self, err := selfid.Load(s.DB)
	if err != nil && s.Logger != nil {
		s.Logger.Printf("selfid.Load: %v", err)
	}
	ix := s.newUnreadIndex()
	counts := s.openTaskCountsPriming(ix)
	blocks := s.resourceBlockCounts()
	type key struct{ typ, id string }
	byKey := map[key]int{}
	out := make([]allResourceDTO, 0)
	for _, e := range entries {
		rs, err := resources.Load(s.DB, e.Path)
		if err != nil {
			if s.Logger != nil {
				s.Logger.Printf("resources.Load(%s): %v", e.Path, err)
			}
			continue
		}
		wt := resourceWorktree{Path: e.Path, Repo: e.Repo, Branch: e.Branch}
		for _, res := range rs {
			k := key{res.Type, res.ID}
			if i, ok := byKey[k]; ok {
				out[i].Worktrees = append(out[i].Worktrees, wt)
				out[i].Primary = out[i].Primary || !res.Related
				continue
			}
			dto := s.newResourceDTO(res)
			ix.fill(&dto)
			dto.OpenTaskCount = resourceTaskCount(counts, dto.Type, dto.ID)
			dto.BlocksCount = blocks[dto.Type+":"+dto.ID]
			byKey[k] = len(out)
			out = append(out, allResourceDTO{
				resourceDTO: dto,
				Worktrees:   []resourceWorktree{wt},
				Mine:        isMine(dto, self),
			})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func isMine(dto resourceDTO, self map[string]string) bool {
	switch dto.Type {
	case "pr":
		return selfid.IsMine(self, "github", dto.authorID)
	case "jira":
		return selfid.IsMine(self, "jira", dto.assigneeID) || selfid.IsMine(self, "jira", dto.reporterID)
	}
	return false
}
