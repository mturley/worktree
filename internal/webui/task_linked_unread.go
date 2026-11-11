package webui

import (
	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/tasks"
)

// A task's combined unread count and its linked resources' unread fields.
// See docs/web-ui-architecture.md "Unread" (combined count).

// followedResources is every resource a live worktree follows, keyed
// "type:id": the set unread.IsFollowed answers for one event at a time, in
// one query. A task's hold (`task:<id>`) does not count, nor does a
// tombstone, so a resource only a task keeps polled is not followed.
func (s *Server) followedResources() (map[string]bool, error) {
	rows, err := s.DB.Query(`
		SELECT DISTINCT resource_type, resource_id FROM watcher_subscriptions
		 WHERE subscriber LIKE 'worktree:%' AND deleted_at IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var typ, id string
		if err := rows.Scan(&typ, &id); err != nil {
			return nil, err
		}
		out[typ+":"+id] = true
	}
	return out, rows.Err()
}

// taskLinkedUnread is task t's resource links as enriched resource DTOs, in
// link order, and the sum of their OWN unread (unread_count less
// task_unread_count: no task's events, so a PR two tasks link never counts
// one task's events in the other's total).
//
// A followed link's DTO keeps fill's values — unread_count including
// task_unread_count, as on a resource card — because the mark-all-read
// button subtracts task_unread_count itself. A link no worktree follows
// adds 0 and is returned with its unread fields cleared: what isn't
// followed isn't unread (unread.ErrNotFollowed).
//
// memo holds each resource's DTO for one request, keyed "type:id", so a
// resource many tasks link is enriched once. Primary is the link's own
// focus flag, set on the returned copy.
func (s *Server) taskLinkedUnread(ix *unreadIndex, followed map[string]bool, memo map[string]resourceDTO, t tasks.Task) (sum int, dtos []resourceDTO) {
	dtos = []resourceDTO{}
	seen := map[string]bool{}
	for _, l := range t.Links {
		if l.Kind != tasks.LinkResource {
			continue
		}
		key := l.ResourceType + ":" + l.ResourceID
		if seen[key] {
			continue
		}
		seen[key] = true
		dto, ok := memo[key]
		if !ok {
			dto = s.linkedResourceDTO(ix, followed[key], l.ResourceType, l.ResourceID)
			memo[key] = dto
		}
		if followed[key] {
			sum += dto.UnreadCount - dto.TaskUnreadCount
		}
		dto.Primary = l.Primary
		dtos = append(dtos, dto)
	}
	return sum, dtos
}

// linkedResourceDTO builds one linked resource's DTO: custom name, URL and
// cached state, then unread through fill when followed.
func (s *Server) linkedResourceDTO(ix *unreadIndex, followed bool, typ, id string) resourceDTO {
	dto := resourceDTO{Type: typ, ID: id, URL: s.resourceURL(typ, id)}
	if meta, err := watcherdb.GetResourceMeta(s.DB, typ, id); err == nil && meta != nil {
		dto.CustomName = meta.CustomName
		dto.CustomDescription = meta.CustomDescription
	}
	s.enrichResourceDTO(&dto)
	if followed {
		ix.fill(&dto)
	} else {
		dto.HasUnread = false // Slack's verdict, but nothing follows the thread
	}
	return dto
}

// taskUnreadReader fills the unread fields of the task DTOs of one request:
// one unread index, one followed-resources read and one resource memo,
// however many tasks it is asked about.
type taskUnreadReader struct {
	s        *Server
	ix       *unreadIndex
	followed map[string]bool
	memo     map[string]resourceDTO
}

// newTaskUnreadReader starts a request's task unread reads over ix, the
// request's one unread index. A failure to read what worktrees follow is
// logged and degrades to "nothing followed": combined counts fall back to
// the tasks' own.
func (s *Server) newTaskUnreadReader(ix *unreadIndex) *taskUnreadReader {
	followed, err := s.followedResources()
	if err != nil {
		s.logger().Printf("followedResources: %v", err)
		followed = map[string]bool{}
	}
	return &taskUnreadReader{s: s, ix: ix, followed: followed, memo: map[string]resourceDTO{}}
}

// fill sets d's unread_count, unread_through_ts and combined_unread_count
// for task t, and returns t's linked resource DTOs.
func (r *taskUnreadReader) fill(d *taskDTO, t tasks.Task) []resourceDTO {
	r.ix.loadTasks()
	sum := r.ix.taskSums[t.ID]
	d.UnreadCount, d.UnreadThroughTS = sum.Count, sum.NewestTS
	linked, dtos := r.s.taskLinkedUnread(r.ix, r.followed, r.memo, t)
	d.CombinedUnreadCount = d.UnreadCount + linked
	return dtos
}
