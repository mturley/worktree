package webui

import (
	"database/sql"
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

// latestEventTSForSubscriber returns the RFC3339 ts of the newest event for
// any resource this subscriber watches, or "" if none. Full timeline reads
// live in timeline.go (Task 3); this focused query is used by the list summary.
func latestEventTSForSubscriber(db *sql.DB, subscriber string) string {
	const q = `
SELECT COALESCE(MAX(e.ts), '')
FROM watcher_events e
JOIN watcher_event_resources er ON er.event_id = e.id
JOIN watcher_subscriptions s ON s.resource_type = er.resource_type AND s.resource_id = er.resource_id
WHERE s.subscriber = ? AND s.deleted_at IS NULL
  AND e.type NOT IN ('watch_started','watcher_error')`
	var ts string
	_ = db.QueryRow(q, subscriber).Scan(&ts)
	return ts
}
