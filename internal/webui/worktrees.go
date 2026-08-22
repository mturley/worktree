package webui

import (
	"net/http"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

type worktreeSummary struct {
	Path          string         `json:"path"`
	Repo          string         `json:"repo"`
	Branch        string         `json:"branch"`
	OnDisk        bool           `json:"on_disk"`
	ResourceCount int            `json:"resource_count"`
	PrimaryCount  int            `json:"primary_count"`
	PrimaryByType map[string]int `json:"primary_by_type"`
	RelatedCount  int            `json:"related_count"`
	LatestEventTS string         `json:"latest_event_ts"`
	// FocusResources are the primary (non-related) resources, enriched from
	// watcher_resource_state, so the worktree list can show what each
	// worktree is actually about instead of bare counts.
	FocusResources []resourceDTO `json:"focus_resources"`
}

func (s *Server) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	entries, err := registry.List(s.DB)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]worktreeSummary, 0, len(entries))
	for _, e := range entries {
		rs, err := resources.Load(s.DB, e.Path)
		if err != nil {
			if s.Logger != nil {
				s.Logger.Printf("resources.Load(%s): %v", e.Path, err)
			}
			// continue with rs (nil) — a degraded row is better than aborting the whole list
		}
		primary := 0
		primaryByType := make(map[string]int)
		relatedCount := 0
		// Sized for the common case; make(...) (not nil) so it marshals as [].
		focus := make([]resourceDTO, 0, len(rs))
		for _, res := range rs {
			if !res.Related {
				primary++
				primaryByType[res.Type]++
				focus = append(focus, s.newResourceDTO(res))
			} else {
				relatedCount++
			}
		}
		_, statErr := os.Stat(e.Path)
		out = append(out, worktreeSummary{
			Path:           e.Path,
			Repo:           e.Repo,
			Branch:         e.Branch,
			OnDisk:         statErr == nil,
			ResourceCount:  len(rs),
			PrimaryCount:   primary,
			PrimaryByType:  primaryByType,
			RelatedCount:   relatedCount,
			LatestEventTS:  latestEventTSForSubscriber(s.DB, wdb.Subscriber(e.Path)),
			FocusResources: focus,
		})
	}
	writeJSON(w, http.StatusOK, out)
}
