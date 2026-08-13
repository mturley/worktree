package webui

import (
	"net/http"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

type worktreeSummary struct {
	Path          string `json:"path"`
	Repo          string `json:"repo"`
	Branch        string `json:"branch"`
	OnDisk        bool   `json:"on_disk"`
	ResourceCount int    `json:"resource_count"`
	PrimaryCount  int    `json:"primary_count"`
	LatestEventTS string `json:"latest_event_ts"`
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
		for _, res := range rs {
			if !res.Related {
				primary++
			}
		}
		_, statErr := os.Stat(e.Path)
		out = append(out, worktreeSummary{
			Path:          e.Path,
			Repo:          e.Repo,
			Branch:        e.Branch,
			OnDisk:        statErr == nil,
			ResourceCount: len(rs),
			PrimaryCount:  primary,
			LatestEventTS: latestEventTSForSubscriber(s.DB, wdb.Subscriber(e.Path)),
		})
	}
	writeJSON(w, http.StatusOK, out)
}
