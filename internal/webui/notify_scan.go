package webui

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

// notifySkipTypes never notify: the two the unread/timeline filter already
// drops, plus CI's "pending" churn, which says nothing worth interrupting for.
var notifySkipTypes = []string{"watch_started", "watcher_error", "ci_pending", "ci_workflows_pending"}

// notifyCursor is how far the notifier has read. watcher_events.ts has
// one-second resolution, so a ts alone would miss an event written later in
// the same second it last read; seen holds the IDs already handled AT ts.
type notifyCursor struct {
	ts   string
	seen map[string]bool
}

// initNotifyCursor starts at the newest event, so a restart never replays a
// backlog as a burst of notifications.
func initNotifyCursor(conn *sql.DB) (notifyCursor, error) {
	c := notifyCursor{seen: map[string]bool{}}
	if err := conn.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&c.ts); err != nil {
		return c, err
	}
	rows, err := conn.Query(`SELECT id FROM watcher_events WHERE ts = ?`, c.ts)
	if err != nil {
		return c, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return c, err
		}
		c.seen[id] = true
	}
	return c, rows.Err()
}

// newEvent is one (event, resource) pair past the cursor.
type newEvent struct{ id, ts, title, resType, resID string }

// readNewEvents returns the notify-worthy events past c, oldest first, and
// the advanced cursor. The cursor advances whatever the caller then does with
// the events: delivery is fire-and-forget, never retried.
func readNewEvents(conn *sql.DB, c notifyCursor) ([]newEvent, notifyCursor, error) {
	q := `SELECT e.id, e.ts, e.title, er.resource_type, er.resource_id
	      FROM watcher_events e JOIN watcher_event_resources er ON er.event_id = e.id
	      WHERE e.ts >= ? AND e.type NOT IN (?` + strings.Repeat(",?", len(notifySkipTypes)-1) + `)
	      ORDER BY e.ts, e.id`
	args := []any{c.ts}
	for _, t := range notifySkipTypes {
		args = append(args, t)
	}
	rows, err := conn.Query(q, args...)
	if err != nil {
		return nil, c, err
	}
	defer rows.Close()
	next := notifyCursor{ts: c.ts, seen: map[string]bool{}}
	for id := range c.seen {
		next.seen[id] = true
	}
	var out []newEvent
	for rows.Next() {
		var e newEvent
		if err := rows.Scan(&e.id, &e.ts, &e.title, &e.resType, &e.resID); err != nil {
			return nil, c, err
		}
		if e.ts > next.ts {
			next.ts, next.seen = e.ts, map[string]bool{}
		}
		if e.ts == c.ts && c.seen[e.id] {
			continue
		}
		next.seen[e.id] = true
		out = append(out, e)
	}
	return out, next, rows.Err()
}

// notifyBatch is one notification: every new event for one resource in one
// worktree since the last pass.
type notifyBatch struct {
	WorktreePath string
	ResourceType string // empty for a worktree-wide test notification
	ResourceID   string
	Title        string
	Subtitle     string
	Body         string
	Tag          string
}

// notifyTag identifies a notification's target, so a browser replaces rather
// than stacks a duplicate that slips through a fallback race.
func notifyTag(path, typ, id string) string {
	if typ == "" {
		return "worktree:" + path + "|all"
	}
	return "worktree:" + path + "|" + typ + ":" + id
}

// notifyResourceLabel names a resource the way its card does: its key, then
// the user's custom name or the fetched title.
func notifyResourceLabel(d resourceDTO) string {
	key := d.ID
	switch d.Type {
	case "pr":
		if i := strings.LastIndex(d.ID, "#"); i >= 0 {
			key = "PR " + d.ID[i:]
		}
	case "slack":
		key = "Slack thread"
		if d.ChannelName != "" {
			key = "Thread in #" + d.ChannelName
		}
	}
	name := d.CustomName
	if name == "" {
		name = d.Title
	}
	if name == "" {
		return key
	}
	return key + ": " + name
}

// notifyBatches matches events to worktrees with notifications on, one batch
// per (worktree, resource). Only resources the worktree actively tracks
// match, so stale toggles and untracked resources never notify.
func (s *Server) notifyBatches(events []newEvent) ([]notifyBatch, error) {
	if len(events) == 0 {
		return nil, nil
	}
	prefs, err := notifyprefs.ListAll(s.DB)
	if err != nil || len(prefs) == 0 {
		return nil, err
	}
	entries, err := registry.List(s.DB)
	if err != nil {
		return nil, err
	}
	var out []notifyBatch
	for _, e := range entries {
		p, ok := prefs[wdb.Subscriber(e.Path)]
		if !ok {
			continue
		}
		rs, err := resources.Load(s.DB, e.Path)
		if err != nil {
			s.logger().Printf("notify: resources.Load(%s): %v", e.Path, err)
			continue
		}
		tracked := make(map[notifyprefs.Key]resources.Resource, len(rs))
		for _, r := range rs {
			tracked[notifyprefs.Key{Type: r.Type, ID: r.ID}] = r
		}
		type agg struct {
			count  int
			newest string
		}
		groups := map[notifyprefs.Key]*agg{}
		var order []notifyprefs.Key
		for _, ev := range events { // oldest first, so the last one wins newest
			k := notifyprefs.Key{Type: ev.resType, ID: ev.resID}
			if _, ok := tracked[k]; !ok || !p.Notifies(k) {
				continue
			}
			g := groups[k]
			if g == nil {
				g = &agg{}
				groups[k] = g
				order = append(order, k)
			}
			g.count++
			g.newest = ev.title
		}
		for _, k := range order {
			g := groups[k]
			body := g.newest
			if g.count > 1 {
				body = fmt.Sprintf("%s (+%d more)", g.newest, g.count-1)
			}
			out = append(out, notifyBatch{
				WorktreePath: e.Path,
				ResourceType: k.Type,
				ResourceID:   k.ID,
				Title:        notifyResourceLabel(s.newResourceDTO(tracked[k])),
				Subtitle:     filepath.Base(e.Path),
				Body:         body,
				Tag:          notifyTag(e.Path, k.Type, k.ID),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].WorktreePath < out[j].WorktreePath })
	return out, nil
}
