package webui

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/notifyprefs"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/tasks"
)

// notifySkipTypes never notify: the two the unread/timeline filter already
// drops, plus CI's "pending" churn, which says nothing worth interrupting for.
var notifySkipTypes = []string{"watch_started", "watcher_error", "ci_pending", "ci_workflows_pending"}

// notifyLookback is how far behind the cursor each pass re-reads. The
// watcher stamps ts from the wall clock BEFORE its write commits, and a write
// can wait on the SQLite lock while a later-stamped one commits first; such a
// late row lands behind the cursor and would be missed by a strict
// "ts >= cursor" read.
const notifyLookback = 30 * time.Second

// notifyCursor is how far the notifier has read: the newest ts seen, plus
// every (id, ts) row read within the lookback window, so re-reading the
// window never notifies twice. Keyed by ts as well as id because the
// watcher reuses a CI bundle's ID and restamps its ts when it changes.
type notifyCursor struct {
	ts   string
	seen map[string]bool
	// ready is false until initNotifyCursor has succeeded. A zero cursor
	// would read from the beginning of time, so notifyPass never reads with
	// one.
	ready bool
	// taskID is the newest task_events.id read (readNewTaskEvents). Unlike
	// watcher_events, task_events.id is an AUTOINCREMENT integer assigned
	// under SQLite's single write lock, so ids commit in order and a plain
	// "id > cursor" read needs no lookback window.
	taskID int64
}

func seenKey(id, ts string) string { return id + "\x00" + ts }

// lookbackFrom is the oldest ts a pass re-reads for a cursor at ts.
func lookbackFrom(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ts // "" (empty DB) reads everything
	}
	return t.Add(-notifyLookback).UTC().Format(time.RFC3339)
}

// initNotifyCursor starts at the newest event, with the lookback window
// already marked seen, so a restart never replays a backlog as a burst of
// notifications.
func initNotifyCursor(conn *sql.DB) (notifyCursor, error) {
	c := notifyCursor{seen: map[string]bool{}}
	if err := conn.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM watcher_events`).Scan(&c.ts); err != nil {
		return c, err
	}
	rows, err := conn.Query(`SELECT id, ts FROM watcher_events WHERE ts >= ?`, lookbackFrom(c.ts))
	if err != nil {
		return c, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, ts string
		if err := rows.Scan(&id, &ts); err != nil {
			return c, err
		}
		c.seen[seenKey(id, ts)] = true
	}
	if err := rows.Err(); err != nil {
		return c, err
	}
	// Both cursors initialise together, so a failure of either leaves the
	// whole cursor not-ready and notifyPass retries both.
	if err := conn.QueryRow(`SELECT COALESCE(MAX(id),0) FROM task_events`).Scan(&c.taskID); err != nil {
		return c, err
	}
	c.ready = true
	return c, nil
}

// newEvent is one (event, resource) pair past the cursor.
type newEvent struct{ id, ts, source, typ, title, body, resType, resID string }

// The user's own events (internal/selfid) are never read, so a mixed
// batch's count and newest title cover only other people's events.
// readNewEvents returns the notify-worthy events not yet seen, oldest first,
// and the advanced cursor. The cursor advances whatever the caller then does
// with the events: delivery is fire-and-forget, never retried.
func readNewEvents(conn *sql.DB, c notifyCursor) ([]newEvent, notifyCursor, error) {
	q := `SELECT e.id, e.ts, e.source, e.type, e.title, COALESCE(e.body,''), er.resource_type, er.resource_id
	      FROM watcher_events e JOIN watcher_event_resources er ON er.event_id = e.id
	      WHERE e.ts >= ? AND e.type NOT IN (?` + strings.Repeat(",?", len(notifySkipTypes)-1) + `)
	        AND ` + selfid.NotMineSQL + `
	      ORDER BY e.ts, e.id`
	args := []any{lookbackFrom(c.ts)}
	for _, t := range notifySkipTypes {
		args = append(args, t)
	}
	rows, err := conn.Query(q, args...)
	if err != nil {
		return nil, c, err
	}
	defer rows.Close()
	// Every row this pass reads is in next.seen, and the next pass's window
	// starts no earlier than this one's, so nothing older needs carrying.
	next := notifyCursor{ts: c.ts, seen: map[string]bool{}, ready: c.ready, taskID: c.taskID}
	var out []newEvent
	for rows.Next() {
		var e newEvent
		if err := rows.Scan(&e.id, &e.ts, &e.source, &e.typ, &e.title, &e.body, &e.resType, &e.resID); err != nil {
			return nil, c, err
		}
		if e.ts > next.ts {
			next.ts = e.ts
		}
		k := seenKey(e.id, e.ts)
		next.seen[k] = true
		if c.seen[k] {
			continue
		}
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
	// The custom notification command's placeholders (notify_command.go):
	// $event, $resource (key and truncated name) and $description.
	Event       string
	Resource    string
	Description string
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
func notifyResourceLabel(d resourceDTO) string { return notifyResourceLabelMax(d, 0) }

// notifyResourceLabelMax is notifyResourceLabel with the name cut to max
// runes; 0 means no limit.
func notifyResourceLabelMax(d resourceDTO, max int) string {
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
	if max > 0 {
		name = truncateRunes(name, max)
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
			body   string
			dto    resourceDTO
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
				g = &agg{dto: s.newResourceDTO(tracked[k])}
				groups[k] = g
				order = append(order, k)
			}
			g.count++
			g.newest = slackEventTitle(ev.source, ev.typ, ev.title, &g.dto)
			g.body = ev.body
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
				Title:        notifyResourceLabel(g.dto),
				Subtitle:     filepath.Base(e.Path),
				Body:         body,
				Tag:          notifyTag(e.Path, k.Type, k.ID),
				Event:        body,
				Resource:     notifyResourceLabelMax(g.dto, notifyNameMax),
				Description:  truncateRunes(oneLine(g.body), notifyDescriptionMax),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].WorktreePath < out[j].WorktreePath })
	return out, nil
}

// readNewTaskEvents returns the task events past c.taskID whose actor counts
// as unread (tasks.CountsAsUnread: an agent's or the system's), oldest
// first, and the advanced id cursor. Every row past the cursor advances it,
// including the user's own events and those of deleted tasks, which are then
// dropped: the user's events never notify, and a deleted task's never count.
func readNewTaskEvents(conn *sql.DB, c notifyCursor) ([]tasks.FeedEvent, int64, error) {
	rows, err := conn.Query(
		`SELECT e.id, e.task_id, e.ts, e.type, e.actor, e.actor_session, e.payload,
		        COALESCE(t.title,''), (t.id IS NOT NULL AND t.deleted_at IS NULL)
		   FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id
		  WHERE e.id > ?
		  ORDER BY e.id`, c.taskID)
	if err != nil {
		return nil, c.taskID, err
	}
	defer rows.Close()
	next := c.taskID
	var out []tasks.FeedEvent
	for rows.Next() {
		var e tasks.FeedEvent
		var payload string
		var live bool
		if err := rows.Scan(&e.ID, &e.TaskID, &e.TS, &e.Type, &e.Actor, &e.ActorSession, &payload, &e.TaskTitle, &live); err != nil {
			return nil, c.taskID, err
		}
		if e.ID > next {
			next = e.ID
		}
		if !live || !tasks.CountsAsUnread(e.Actor) {
			continue
		}
		e.Payload = []byte(payload)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, c.taskID, err
	}
	return out, next, nil
}

// notifyTaskBatches matches agent task events to worktrees, one batch per
// (worktree, task). A worktree is notified when the task is in its scope
// (tasks.BuildScopeIndex: linked directly, implicitly, or by the archived
// fallback) and it has "Notify on all", or "Notify on new events" on a
// resource the task links and the worktree tracks. A global task is in no
// worktree's scope, so it notifies nobody.
func (s *Server) notifyTaskBatches(events []tasks.FeedEvent) ([]notifyBatch, error) {
	if len(events) == 0 {
		return nil, nil
	}
	prefs, err := notifyprefs.ListAll(s.DB)
	if err != nil || len(prefs) == 0 {
		return nil, err
	}
	scope, err := tasks.BuildScopeIndex(s.DB)
	if err != nil {
		return nil, err
	}
	inWorktree := map[int64]map[string]bool{} // task -> canonical worktree paths
	for p, ids := range scope.ByWorktree {
		for _, id := range ids {
			if inWorktree[id] == nil {
				inWorktree[id] = map[string]bool{}
			}
			inWorktree[id][p] = true
		}
	}
	links := map[int64][]notifyprefs.Key{} // task -> the resources it links
	for k, ids := range scope.ByResource {
		typ, rid, ok := strings.Cut(k, ":") // a type has no colon; an id may
		if !ok {
			continue
		}
		for _, id := range ids {
			links[id] = append(links[id], notifyprefs.Key{Type: typ, ID: rid})
		}
	}
	entries, err := registry.List(s.DB)
	if err != nil {
		return nil, err
	}
	var out []notifyBatch
	for _, e := range entries {
		sub := wdb.Subscriber(e.Path)
		p, ok := prefs[sub]
		if !ok {
			continue
		}
		canon, _ := wdb.WorktreePathFromSubscriber(sub)
		var tracked map[notifyprefs.Key]bool // loaded only once a per-resource toggle decides
		notifies := func(id int64) bool {
			if !inWorktree[id][canon] {
				return false
			}
			if p.All {
				return true
			}
			if tracked == nil {
				tracked = map[notifyprefs.Key]bool{}
				rs, err := resources.Load(s.DB, e.Path)
				if err != nil {
					s.logger().Printf("notify: resources.Load(%s): %v", e.Path, err)
				}
				for _, r := range rs {
					tracked[notifyprefs.Key{Type: r.Type, ID: r.ID}] = true
				}
			}
			for _, k := range links[id] {
				if tracked[k] && p.Notifies(k) {
					return true
				}
			}
			return false
		}
		type agg struct {
			count  int
			title  string // the task's title
			newest string // the newest event's converted title
		}
		groups := map[int64]*agg{}
		decided := map[int64]bool{}
		var order []int64
		for _, ev := range events { // oldest first, so the last one wins newest
			on, seen := decided[ev.TaskID]
			if !seen {
				on = notifies(ev.TaskID)
				decided[ev.TaskID] = on
			}
			if !on {
				continue
			}
			g := groups[ev.TaskID]
			if g == nil {
				g = &agg{}
				groups[ev.TaskID] = g
				order = append(order, ev.TaskID)
			}
			g.count++
			g.title = ev.TaskTitle
			g.newest = taskEventToTimeline(ev.Event, tasks.Task{ID: ev.TaskID, Title: ev.TaskTitle}).Title
		}
		for _, id := range order {
			g := groups[id]
			body := g.newest
			if g.count > 1 {
				body = fmt.Sprintf("%s (+%d more)", g.newest, g.count-1)
			}
			sid := strconv.FormatInt(id, 10)
			out = append(out, notifyBatch{
				WorktreePath: e.Path,
				ResourceType: "task",
				ResourceID:   sid,
				Title:        g.title,
				Subtitle:     filepath.Base(e.Path),
				Body:         body,
				Tag:          notifyTag(e.Path, "task", sid),
				Event:        body,
				Resource:     "T" + sid + ": " + truncateRunes(g.title, notifyNameMax),
				// A task event has no body of its own; the newest event's
				// title, without the count, is the closest thing.
				Description: truncateRunes(oneLine(g.newest), notifyDescriptionMax),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].WorktreePath < out[j].WorktreePath })
	return out, nil
}
