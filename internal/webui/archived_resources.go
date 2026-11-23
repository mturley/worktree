package webui

import (
	"github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/selfid"
)

// ArchivedResources lists every resource that was followed by a worktree and
// no longer is: at least one tombstoned `worktree:` subscription and no live
// one. `task:` hold subscriptions count for neither side, so a resource only
// a task still holds is archived. Newest tombstone first. Read-only.
func (s *Server) ArchivedResources() ([]AllResource, error) {
	rows, err := s.DB.Query(`
		SELECT resource_type, resource_id, COALESCE(resource_url, ''), subscriber, deleted_at
		  FROM watcher_subscriptions
		 WHERE subscriber LIKE 'worktree:%' AND deleted_at IS NOT NULL
		   AND NOT EXISTS (
		       SELECT 1 FROM watcher_subscriptions live
		        WHERE live.resource_type = watcher_subscriptions.resource_type
		          AND live.resource_id = watcher_subscriptions.resource_id
		          AND live.subscriber LIKE 'worktree:%'
		          AND live.deleted_at IS NULL)
		 ORDER BY deleted_at DESC, subscriber`)
	if err != nil {
		return nil, err
	}
	type key struct{ typ, id string }
	type found struct {
		url   string
		paths []string
	}
	var order []key
	byKey := map[key]*found{}
	for rows.Next() {
		var typ, id, url, sub, deleted string
		if err := rows.Scan(&typ, &id, &url, &sub, &deleted); err != nil {
			rows.Close()
			return nil, err
		}
		k := key{typ, id}
		f, ok := byKey[k]
		if !ok {
			f = &found{url: url}
			byKey[k] = f
			order = append(order, k)
		}
		if p, ok := wdb.WorktreePathFromSubscriber(sub); ok {
			f.paths = append(f.paths, p)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	entries, err := registry.List(s.DB)
	if err != nil {
		return nil, err
	}
	registered := map[string]resourceWorktree{}
	for _, e := range entries {
		registered[wdb.Subscriber(e.Path)] = resourceWorktree{Path: e.Path, Repo: e.Repo, Branch: e.Branch}
	}
	self, err := selfid.Load(s.DB)
	if err != nil && s.Logger != nil {
		s.Logger.Printf("selfid.Load: %v", err)
	}
	ix := s.newUnreadIndex()
	counts := s.openTaskCountsPriming(ix)
	blocks := s.resourceBlockCounts()

	out := make([]allResourceDTO, 0, len(order))
	for _, k := range order {
		f := byKey[k]
		res := resources.Resource{Type: k.typ, ID: k.id, URL: f.url, Related: true}
		meta, err := db.GetResourceMeta(s.DB, k.typ, k.id)
		if err != nil {
			return nil, err
		}
		if meta != nil {
			res.CustomName = meta.CustomName
			res.CustomDescription = meta.CustomDescription
			res.UpdatedAt = meta.UpdatedAt
		}
		dto := s.newResourceDTO(res)
		dto.Primary = false
		ix.fill(&dto)
		dto.OpenTaskCount = resourceTaskCount(counts, dto.Type, dto.ID)
		dto.BlocksCount = blocks[dto.Type+":"+dto.ID]
		last := make([]resourceWorktree, 0, len(f.paths))
		for _, p := range f.paths {
			if wt, ok := registered[wdb.Subscriber(p)]; ok {
				last = append(last, wt)
			} else {
				last = append(last, resourceWorktree{Path: p})
			}
		}
		out = append(out, allResourceDTO{
			resourceDTO:    dto,
			Worktrees:      []resourceWorktree{},
			Archived:       true,
			LastFollowedBy: last,
			Mine:           isMine(dto, self),
		})
	}
	return out, nil
}
