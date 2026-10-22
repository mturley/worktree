package webui

import (
	"net/http"
	"os"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notes"
	"github.com/mturley/worktree/internal/notifyprefs"
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
	// RelatedByType breaks RelatedCount down the same way PrimaryByType does,
	// so the UI can name what is related ("2 Slack threads") rather than only
	// counting it. Kept alongside RelatedCount rather than replacing it: the
	// total is still what callers checking "are there any?" want.
	RelatedByType map[string]int `json:"related_by_type"`
	LatestEventTS string         `json:"latest_event_ts"`
	// CreatedAt is the registry's stored creation time, passed through
	// verbatim so the UI can sort by it. Not parsed here: worktrees seeded by
	// the Phase 1 cutover may carry older formats, and the UI already treats
	// an unparseable value as missing.
	CreatedAt string `json:"created_at"`
	// FocusResources are the primary (non-related) resources, enriched from
	// watcher_resource_state, so the worktree list can show what each
	// worktree is actually about instead of bare counts.
	FocusResources []resourceDTO `json:"focus_resources"`
	// HasUnread is true when ANY resource on this worktree has unread
	// activity, RELATED ones included. Deliberately not derivable from
	// FocusResources: related resources are counted but never listed, so a
	// client folding over that list alone would miss their unreads.
	HasUnread bool `json:"has_unread"`
	// UnreadCount totals unread_count across those same resources — Slack
	// threads included, each counting at least 1 while unread (see
	// unreadIndex.fill), so it is non-zero whenever HasUnread is — minus
	// their task_unread_count, plus the unread task events of the DISTINCT
	// tasks in the worktree's scope (unreadIndex.worktreeTaskUnread), so a
	// task linked to two of its resources counts once. HasUnread is also
	// true while that task count is above 0.
	UnreadCount int `json:"unread_count"`
	// NotifyAll is the worktree-wide "Notify on all" toggle.
	NotifyAll bool `json:"notify_all"`
	// Notes are the worktree's notes, present only when they are non-blank
	// and its "Show notes on home page" setting is on.
	Notes string `json:"notes,omitempty"`
	// NotesSearch is the worktree's notes whenever they are non-blank,
	// regardless of the show-on-home setting, so search can find a worktree
	// by its notes. Not rendered.
	NotesSearch string `json:"notes_search,omitempty"`
	// OpenTaskCount is how many open tasks are in this worktree's scope
	// (tasks.OpenCounts' ByWorktree): linked, implicit, or archived fallback.
	OpenTaskCount int `json:"open_task_count"`
}

func (s *Server) handleWorktrees(w http.ResponseWriter, r *http.Request) {
	entries, err := registry.List(s.DB)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]worktreeSummary, 0, len(entries))
	// One index for the whole response: the alternative is a count query per
	// resource per worktree.
	ix := s.newUnreadIndex()
	// One query for every worktree's toggles, like the unread index above.
	allPrefs, err := notifyprefs.ListAll(s.DB)
	if err != nil && s.Logger != nil {
		s.Logger.Printf("notifyprefs.ListAll: %v", err)
	}
	// Likewise one query for every worktree's home-page notes. A failure
	// only costs the notes, never the list.
	homeNotes, err := notes.HomeNotes(s.DB)
	if err != nil && s.Logger != nil {
		s.Logger.Printf("notes.HomeNotes: %v", err)
	}
	allNotes, err := notes.AllNonBlank(s.DB)
	if err != nil && s.Logger != nil {
		s.Logger.Printf("notes.AllNonBlank: %v", err)
	}
	// One load for every worktree's and resource's open-task count.
	taskCounts := s.openTaskCounts()
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
		relatedByType := make(map[string]int)
		// Sized for the common case; make(...) (not nil) so it marshals as [].
		focus := make([]resourceDTO, 0, len(rs))
		hasUnread := false
		unreadCount := 0
		prefs := allPrefs[wdb.Subscriber(e.Path)]
		for _, res := range rs {
			if !res.Related {
				primary++
				primaryByType[res.Type]++
				dto := s.newResourceDTO(res)
				ix.fill(&dto)
				dto.Notify = prefs.Resources[notifyprefs.Key{Type: dto.Type, ID: dto.ID}]
				dto.OpenTaskCount = resourceTaskCount(taskCounts, dto.Type, dto.ID)
				focus = append(focus, dto)
				hasUnread = hasUnread || resourceHasUnread(dto)
				unreadCount += dto.UnreadCount - dto.TaskUnreadCount
			} else {
				relatedCount++
				relatedByType[res.Type]++
				// Related resources get no DTO of their own in the response,
				// so one is built here purely to answer the unread questions.
				// Unlike HasUnread, the COUNT cannot short-circuit — every
				// related resource has to be asked, or the badge undercounts.
				dto := s.newResourceDTO(res)
				ix.fill(&dto)
				hasUnread = hasUnread || resourceHasUnread(dto)
				unreadCount += dto.UnreadCount - dto.TaskUnreadCount
			}
		}
		// Task events count once per task, not once per resource linking it.
		if n := ix.worktreeTaskUnread(e.Path); n > 0 {
			hasUnread = true
			unreadCount += n
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
			RelatedByType:  relatedByType,
			LatestEventTS:  latestEventTSForSubscriber(s.DB, wdb.Subscriber(e.Path)),
			CreatedAt:      e.CreatedAt,
			FocusResources: focus,
			HasUnread:      hasUnread,
			UnreadCount:    unreadCount,
			NotifyAll:      prefs.All,
			Notes:          homeNotes[e.Path],
			NotesSearch:    allNotes[e.Path],
			OpenTaskCount:  worktreeTaskCount(taskCounts, e.Path),
		})
	}
	writeJSON(w, http.StatusOK, out)
}
