package webui

import (
	"encoding/json"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/linkmeta"
)

// saveLinkMeta caches a link's resolved metadata in watcher_resource_state.
//
// worktree writes this row itself rather than a poller writing it, because a
// link has no poller — nothing in pollAll ever names the "link" type. The
// table is a generic (type, id) -> json cache with no per-type schema, so
// this needs no watcher library release. It is the one place worktree writes
// a watcher_* row for a type the library does not know about.
func (s *Server) saveLinkMeta(id string, m linkmeta.Meta) error {
	blob, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return watcherdb.UpsertResourceState(s.DB, "link", id, string(blob), m.ResolvedAt, m.ResolvedAt)
}
