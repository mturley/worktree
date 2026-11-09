package webui

import (
	"database/sql"
	"errors"
	"fmt"

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

// humanUnreadSQL finds one unread event of a resource that a person wrote:
// the global timeline's unread_only and humans_only clauses together, so a
// worktree's has_human_unread can never disagree with what the Activity feed
// shows with Unreads only and Humans only both on.
const humanUnreadSQL = `SELECT 1 FROM watcher_events e
JOIN watcher_event_resources er ON er.event_id = e.id
WHERE er.resource_type = ? AND er.resource_id = ?
  AND e.type NOT IN ('watch_started','watcher_error') ` + unreadOnlyClause + humansOnlyClause + `LIMIT 1`

// worktreeHasHumanUnread is a worktree's has_human_unread: whether any of its
// unread activity is a person's. Unread task events count (a task event has
// no bot author), as does the worktree's own task activity; a watcher
// resource is asked only once it has unread at all, so a quiet worktree costs
// no query. memo caches each resource's answer across worktrees following it.
// An error counts as human: the UI then keeps the worktree listed rather than
// hiding activity it could not rule out.
func (s *Server) worktreeHasHumanUnread(ix *unreadIndex, path string, filled []resourceDTO, memo map[string]bool) bool {
	if ix.worktreeTaskUnread(path) > 0 {
		return true
	}
	for _, dto := range filled {
		if dto.TaskUnreadCount > 0 {
			return true
		}
		if !resourceHasUnread(dto) {
			continue
		}
		key := dto.Type + ":" + dto.ID
		human, ok := memo[key]
		if !ok {
			var one int
			err := s.DB.QueryRow(humanUnreadSQL, dto.Type, dto.ID).Scan(&one)
			human = err == nil || !errors.Is(err, sql.ErrNoRows)
			if err != nil && !errors.Is(err, sql.ErrNoRows) && s.Logger != nil {
				s.Logger.Printf("human unread (%s): %v", key, err)
			}
			memo[key] = human
		}
		if human {
			return true
		}
	}
	return false
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

// UnreadBy breaks the unread count down for `worktree unread --by`. by is
// "worktree" (key = worktree path, value = the count WorktreeSummaries
// reports) or "resource" (key = "type:id", value = the resource's
// UnreadCount). Only non-zero entries appear. Read-only.
func (s *Server) UnreadBy(by string) (map[string]int, error) {
	out := map[string]int{}
	switch by {
	case "worktree":
		sums, err := s.WorktreeSummaries()
		if err != nil {
			return nil, err
		}
		for _, w := range sums {
			if w.UnreadCount > 0 {
				out[w.Path] = w.UnreadCount
			}
		}
	case "resource":
		rs, err := s.AllResources()
		if err != nil {
			return nil, err
		}
		for _, r := range rs {
			if r.UnreadCount > 0 {
				out[r.Type+":"+r.ID] = r.UnreadCount
			}
		}
	default:
		return nil, fmt.Errorf("unknown --by %q (want worktree or resource)", by)
	}
	return out, nil
}
