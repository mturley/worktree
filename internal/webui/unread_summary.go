package webui

import (
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

// worktreeUnreadTotals is a worktree's has_unread and unread_count in
// /api/worktrees, from the filled DTOs of every resource it follows, focus
// and related. Unlike has_unread, the count cannot short-circuit: every
// resource has to be asked, or the badge undercounts. Task events count once
// per task, not once per resource linking it, so each resource's
// task_unread_count is left out and the worktree's distinct tasks added.
func worktreeUnreadTotals(ix *unreadIndex, path string, filled []resourceDTO) (has bool, count int) {
	for _, dto := range filled {
		has = has || resourceHasUnread(dto)
		count += dto.UnreadCount - dto.TaskUnreadCount
	}
	if n := ix.worktreeTaskUnread(path); n > 0 {
		has = true
		count += n
	}
	return has, count
}

// UnreadSummary is the app-wide unread state: whether any worktree has
// unread activity, and how many unread events in all.
type UnreadSummary struct {
	Unread bool `json:"unread"`
	Count  int  `json:"count"`
}

// AppUnread is what the web UI's unreadBadge folds out of /api/worktrees
// (the tab's blinking favicon, the menu bar icon), computed straight from
// the DB: `worktree unread` reports it to the macOS menu bar app without a
// session or a running server. A worktree whose resources can't be read
// counts as read, as on the worktree list.
func (s *Server) AppUnread() (UnreadSummary, error) {
	entries, err := registry.List(s.DB)
	if err != nil {
		return UnreadSummary{}, err
	}
	ix := s.newUnreadIndex()
	var out UnreadSummary
	for _, e := range entries {
		rs, err := resources.Load(s.DB, e.Path)
		if err != nil {
			if s.Logger != nil {
				s.Logger.Printf("resources.Load(%s): %v", e.Path, err)
			}
			continue
		}
		filled := make([]resourceDTO, 0, len(rs))
		for _, res := range rs {
			dto := s.newResourceDTO(res)
			ix.fill(&dto)
			filled = append(filled, dto)
		}
		// unreadBadge counts a worktree only while it is unread.
		if has, n := worktreeUnreadTotals(ix, e.Path, filled); has {
			out.Unread = true
			out.Count += n
		}
	}
	return out, nil
}
