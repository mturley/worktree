package webui

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resourceurl"
	"github.com/mturley/worktree/internal/tasks"
)

// The task detail modal's API. See docs/web-ui-architecture.md "Task detail
// API" for how event-link snapshots and the merged activity feed work.

// taskActivityLimit caps the merged activity feed.
const taskActivityLimit = 200

// maxFromEventTitle is the most runes of a Slack message's first line a task
// created from it takes as its title.
const maxFromEventTitle = 120

type taskDetailLinkDTO struct {
	taskLinkDTO
	// The resource's custom_name, else its cached title, else its short ref;
	// a worktree's branch, else its basename.
	Title string `json:"title"`
	URL   string `json:"url,omitempty"` // the resource URL
}

// taskImplicitDTO is a worktree the task shows in only because it follows
// one of the task's resource links. Via names those links as "type:id".
type taskImplicitDTO struct {
	Worktree string   `json:"worktree"`
	Branch   string   `json:"branch,omitempty"`
	Via      []string `json:"via"`
}

type taskSubtaskDTO struct {
	ID      int64  `json:"id"`
	Text    string `json:"text"`
	Checked bool   `json:"checked"`
}

type taskEventLinkDTO struct {
	Key      string              `json:"key"`
	Snapshot tasks.EventSnapshot `json:"snapshot"`
	// Live is the watcher event as it is now (see liveEvent): an ev: key's
	// event while it still exists with the snapshot's type, a slack: key's
	// message matched by its external ts.
	Live *TimelineEvent `json:"live,omitempty"`
}

type taskDetailDTO struct {
	taskDTO
	DetailLinks []taskDetailLinkDTO `json:"detail_links"` // same order as Links
	ImplicitVia []taskImplicitDTO   `json:"implicit"`
	Subtasks    []taskSubtaskDTO    `json:"subtasks"`
	EventLinks  []taskEventLinkDTO  `json:"event_links"`
	// Blockers: unresolved first, then oldest first. Blocks: the tasks this
	// one blocks, in master order. Both never null.
	Blockers []taskBlockerDTO `json:"blockers"`
	Blocks   []taskBlocksDTO  `json:"blocks"`
}

// taskDetail loads task id and builds its detail DTO.
func (s *Server) taskDetail(id int64) (taskDetailDTO, error) {
	t, err := tasks.Get(s.DB, id)
	if err != nil {
		return taskDetailDTO{}, err
	}
	links, err := tasks.EventLinks(s.DB, id)
	if err != nil {
		return taskDetailDTO{}, err
	}
	branches := s.registryBranches()
	e := s.newEventEnricher()
	blockers, blocks, labels, err := s.detailBlockers(id, e.resource)
	if err != nil {
		return taskDetailDTO{}, err
	}
	td := newTaskDTO(t)
	sum := s.taskUnreadSummaries()[t.ID]
	td.UnreadCount, td.UnreadThroughTS, td.BlockerLabels = sum.Count, sum.NewestTS, labels
	d := taskDetailDTO{
		taskDTO:     td,
		Blockers:    blockers,
		Blocks:      blocks,
		DetailLinks: make([]taskDetailLinkDTO, 0, len(t.Links)),
		ImplicitVia: make([]taskImplicitDTO, 0, len(t.Implicit)),
		Subtasks:    make([]taskSubtaskDTO, 0, len(t.Subtasks)),
		EventLinks:  make([]taskEventLinkDTO, 0, len(links)),
	}
	for i, l := range t.Links {
		dl := taskDetailLinkDTO{taskLinkDTO: d.Links[i]}
		switch l.Kind {
		case tasks.LinkResource:
			dl.URL = s.resourceURL(l.ResourceType, l.ResourceID)
			dl.Title = resourceDisplayTitle(e.resource(l.ResourceType, l.ResourceID), l.ResourceType, l.ResourceID)
		case tasks.LinkWorktree:
			if b := branches[l.Worktree]; b != "" {
				dl.Title = b
			} else {
				dl.Title = filepath.Base(l.Worktree)
			}
		}
		d.DetailLinks = append(d.DetailLinks, dl)
	}
	via := s.implicitVia(t)
	for _, p := range t.Implicit {
		d.ImplicitVia = append(d.ImplicitVia, taskImplicitDTO{
			Worktree: p, Branch: branches[p], Via: append([]string{}, via[p]...),
		})
	}
	for _, st := range t.Subtasks {
		d.Subtasks = append(d.Subtasks, taskSubtaskDTO{ID: st.ID, Text: st.Text, Checked: st.Checked})
	}
	for _, l := range links {
		el := taskEventLinkDTO{Key: l.Key, Snapshot: l.Snapshot}
		// A lookup failure degrades to the snapshot.
		if ev, err := s.liveEvent(l); err == nil && ev != nil {
			te := e.enrich(*ev)
			el.Live = &te
		}
		d.EventLinks = append(d.EventLinks, el)
	}
	return d, nil
}

func (s *Server) writeTaskDetail(w http.ResponseWriter, id int64) {
	d, err := s.taskDetail(id)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// registryBranches maps each registered worktree's canonical path to its
// branch. A registry read failure degrades to no branches.
func (s *Server) registryBranches() map[string]string {
	out := map[string]string{}
	entries, err := registry.List(s.DB)
	if err != nil {
		return out
	}
	for _, e := range entries {
		out[canonicalWorktree(e.Path)] = e.Branch
	}
	return out
}

// canonicalWorktree is the canonical path the tasks package keys worktrees
// by (see the wdb.Subscriber gotcha in CLAUDE.md).
func canonicalWorktree(p string) string {
	c, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(p))
	return c
}

// implicitVia maps each worktree actively following one of t's resource
// links to those links' "type:id" keys, in link order.
func (s *Server) implicitVia(t tasks.Task) map[string][]string {
	out := map[string][]string{}
	nowTS := time.Now().UTC().Format(time.RFC3339)
	for _, l := range t.Links {
		if l.Kind != tasks.LinkResource {
			continue
		}
		subs, err := watcherdb.SubscribersOf(s.DB, l.ResourceType, l.ResourceID)
		if err != nil {
			continue
		}
		seen := map[string]bool{}
		for _, sub := range subs {
			if sub.DeletedAt != nil || (sub.ExpiresAt != nil && *sub.ExpiresAt <= nowTS) {
				continue
			}
			p, ok := wdb.WorktreePathFromSubscriber(sub.Subscriber)
			if !ok || seen[p] {
				continue
			}
			seen[p] = true
			out[p] = append(out[p], l.ResourceType+":"+l.ResourceID)
		}
	}
	return out
}

// resourceURL finds a resource's URL: from any subscription to it (live or
// not), else from an event about it, else derived from its id where that is
// possible (a PR, a link). "" when nothing knows it.
func (s *Server) resourceURL(typ, id string) string {
	var u string
	_ = s.DB.QueryRow(`SELECT resource_url FROM watcher_subscriptions
		WHERE resource_type = ? AND resource_id = ? AND COALESCE(resource_url,'') <> ''
		ORDER BY deleted_at IS NOT NULL, created_at DESC LIMIT 1`, typ, id).Scan(&u)
	if u != "" {
		return u
	}
	_ = s.DB.QueryRow(`SELECT resource_url FROM watcher_event_resources
		WHERE resource_type = ? AND resource_id = ? AND COALESCE(resource_url,'') <> '' LIMIT 1`, typ, id).Scan(&u)
	if u != "" {
		return u
	}
	switch typ {
	case "pr":
		if repo, num, ok := strings.Cut(id, "#"); ok && strings.Count(repo, "/") == 1 {
			return "https://github.com/" + repo + "/pull/" + num
		}
	case "link":
		return id
	}
	return ""
}

// errEventNotFound is a missing watcher event; it maps to 404.
var errEventNotFound = fmt.Errorf("%w: no such event", tasks.ErrNotFound)

// watcherEventCols are the watcher_events columns scanWatcherEvent reads, as
// columns of the alias e.
const watcherEventCols = `e.id, e.ts, e.external_ts, e.source, e.type, COALESCE(e.title,''), e.body, e.author, e.author_id`

// loadWatcherEvent reads one watcher event by id.
func (s *Server) loadWatcherEvent(id string) (*watcher.Event, error) {
	ev, err := scanWatcherEvent(s.DB.QueryRow(`SELECT `+watcherEventCols+` FROM watcher_events e WHERE e.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errEventNotFound
	}
	if err != nil {
		return nil, err
	}
	return ev, nil
}

// recentResourceEvents is one resource's newest limit events, newest first,
// leaving out the watcher's bookkeeping types as the timeline does. A direct
// query rather than watcherdb.EventsForResource, which loads the resource's
// whole history, unpaged — and the task activity feed re-runs on every SSE
// events_new and tasks_changed.
func (s *Server) recentResourceEvents(typ, rid string, limit int) ([]watcher.Event, error) {
	rows, err := s.DB.Query(`SELECT `+watcherEventCols+` FROM watcher_events e
		JOIN watcher_event_resources er ON er.event_id = e.id
		WHERE er.resource_type = ? AND er.resource_id = ?
		  AND e.type NOT IN ('watch_started','watcher_error')
		ORDER BY e.ts DESC LIMIT ?`, typ, rid, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []watcher.Event
	for rows.Next() {
		ev, err := scanWatcherEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *ev)
	}
	return out, rows.Err()
}

// scanWatcherEvent scans one row of watcherEventCols.
func scanWatcherEvent(row interface{ Scan(...any) error }) (*watcher.Event, error) {
	var ev watcher.Event
	var typ string
	var ext, body, author, authorID sql.NullString
	if err := row.Scan(&ev.ID, &ev.TS, &ext, &ev.Source, &typ, &ev.Title, &body, &author, &authorID); err != nil {
		return nil, err
	}
	ev.Type = watcher.EventType(typ)
	if ext.Valid {
		ev.ExternalTS = &ext.String
	}
	if body.Valid {
		ev.Body = &body.String
	}
	if author.Valid {
		ev.Author = &author.String
	}
	if authorID.Valid {
		ev.AuthorID = &authorID.String
	}
	return &ev, nil
}

// snapshotOf is what an event link remembers of a watcher event.
func snapshotOf(te TimelineEvent) tasks.EventSnapshot {
	return tasks.EventSnapshot{
		Source: te.Source, Type: te.Type, Title: te.Title, Author: te.Author, Body: te.Body,
		URL: te.ResourceURL, TS: te.TS, ResourceType: te.ResourceType, ResourceID: te.ResourceID,
	}
}

// resolveEventLink is the key and snapshot an events/link or from-event
// request stores, and whether the snapshot is server-built.
//
// An ev: key's snapshot is rebuilt from watcher_events, ignoring the
// client's, so it always says what the event really said; and a Slack
// message's ev: key becomes its canonical slack:<channel>:<ts> key, so a
// message has one identity however it was linked. A slack: key takes the
// client's snapshot, validated (validSlackSnapshot). Anything else is
// ErrInvalid.
func (s *Server) resolveEventLink(key string, client *tasks.EventSnapshot) (string, tasks.EventSnapshot, bool, error) {
	if wid, ok := strings.CutPrefix(key, "ev:"); ok {
		ev, err := s.loadWatcherEvent(wid)
		if err != nil {
			return "", tasks.EventSnapshot{}, false, err
		}
		te := s.newEventEnricher().enrich(*ev)
		if k := slackKeyOf(te); k != "" {
			key = k
		}
		return key, snapshotOf(te), true, nil
	}
	if strings.HasPrefix(key, "slack:") {
		snap, err := validSlackSnapshot(key, client)
		return key, snap, false, err
	}
	return "", tasks.EventSnapshot{}, false, fmt.Errorf("%w: key must start with ev: or slack:", tasks.ErrInvalid)
}

// maxSlackSnapshotTitle caps a client-sent Slack snapshot's title, in runes.
const maxSlackSnapshotTitle = 200

// parseSlackKey splits slack:<channel>:<message ts>, both parts non-empty.
func parseSlackKey(key string) (channel, ts string, ok bool) {
	rest, ok := strings.CutPrefix(key, "slack:")
	if !ok {
		return "", "", false
	}
	channel, ts, ok = strings.Cut(rest, ":")
	return channel, ts, ok && channel != "" && ts != "" && !strings.Contains(ts, ":")
}

// validSlackSnapshot checks the client's snapshot for a slack: key. It must
// name a thread in the key's channel, have a title or a body, and have an
// empty or http(s) URL. The server sets source and type and caps the title,
// so a client can't pass a snapshot off as some other kind of event.
func validSlackSnapshot(key string, c *tasks.EventSnapshot) (tasks.EventSnapshot, error) {
	bad := func(msg string) (tasks.EventSnapshot, error) {
		return tasks.EventSnapshot{}, fmt.Errorf("%w: %s", tasks.ErrInvalid, msg)
	}
	ch, _, ok := parseSlackKey(key)
	if !ok {
		return bad("a slack: key is slack:<channel>:<message ts>")
	}
	if c == nil || (strings.TrimSpace(c.Title) == "" && strings.TrimSpace(c.Body) == "") {
		return bad("the snapshot needs a title or a body")
	}
	if c.ResourceType != "slack" {
		return bad(`the snapshot's resource_type must be "slack"`)
	}
	if thread, ok := strings.CutPrefix(c.ResourceID, ch+":"); !ok || thread == "" {
		return bad("the snapshot's resource_id must be <channel>:<thread ts> in the key's channel")
	}
	if c.URL != "" {
		u, err := url.Parse(c.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return bad("the snapshot's url must be empty or http(s)")
		}
	}
	snap := *c
	snap.Source, snap.Type = "slack", string(watcher.EventTypeSlackReply)
	if r := []rune(snap.Title); len(r) > maxSlackSnapshotTitle {
		snap.Title = string(r[:maxSlackSnapshotTitle])
	}
	return snap, nil
}

// slackKeyOf is a Slack thread event's canonical event-link key,
// slack:<channel>:<message ts>; "" for any other event. Only a reply is a
// Slack message: a bookkeeping event on a thread (watch_started,
// watcher_error) can carry an external_ts too, but it names no message and
// keeps its ev: key.
func slackKeyOf(te TimelineEvent) string {
	if te.ResourceType != "slack" || te.Type != string(watcher.EventTypeSlackReply) || te.ExternalTS == "" {
		return ""
	}
	ch, _, ok := strings.Cut(te.ResourceID, ":")
	if !ok || ch == "" {
		return ""
	}
	return "slack:" + ch + ":" + te.ExternalTS
}

// linkedKeyOf is the key te is linked to the task under, or "": its
// canonical slack: key, else its ev: key (how a Slack message linked from
// the feed was stored before keys were canonicalised).
func linkedKeyOf(te TimelineEvent, linked map[string]bool) string {
	for _, k := range []string{slackKeyOf(te), "ev:" + te.ID} {
		if k != "" && linked[k] {
			return k
		}
	}
	return ""
}

// liveEvent is the watcher event a link renders from while it exists: an
// ev: key's event while its type still matches the snapshot's, and a
// slack: key's message found by its external ts in a thread of that
// channel. nil when there is none.
func (s *Server) liveEvent(l tasks.EventLink) (*watcher.Event, error) {
	if wid, ok := strings.CutPrefix(l.Key, "ev:"); ok {
		ev, err := s.loadWatcherEvent(wid)
		if errors.Is(err, errEventNotFound) {
			return nil, nil
		}
		if err != nil || string(ev.Type) != l.Snapshot.Type {
			return nil, err
		}
		return ev, nil
	}
	ch, ts, ok := parseSlackKey(l.Key)
	if !ok {
		return nil, nil
	}
	var id string
	err := s.DB.QueryRow(`SELECT e.id FROM watcher_events e
		JOIN watcher_event_resources er ON er.event_id = e.id
		WHERE er.resource_type = 'slack' AND substr(er.resource_id, 1, ?) = ? AND e.external_ts = ?
		  AND e.type NOT IN ('watch_started','watcher_error')
		ORDER BY e.ts DESC LIMIT 1`, utf8.RuneCountInString(ch)+1, ch+":", ts).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	ev, err := s.loadWatcherEvent(id)
	if errors.Is(err, errEventNotFound) {
		return nil, nil
	}
	return ev, err
}

// snapshotEvent is the feed row of a link with no live event, built from
// its snapshot as the modal's eventFromLink builds one: no unread state, no
// worktrees, and the link key as its id.
func snapshotEvent(l tasks.EventLink) TimelineEvent {
	sn := l.Snapshot
	return TimelineEvent{
		ID: l.Key, TS: sn.TS, Source: sn.Source, Type: sn.Type,
		TypeLabel: watcher.EventType(sn.Type).DisplayName(),
		Title:     sn.Title, Body: sn.Body, Author: sn.Author,
		ResourceType: sn.ResourceType, ResourceID: sn.ResourceID, ResourceURL: sn.URL,
		Worktrees: []string{}, WorktreePaths: []string{},
		LinkedToTask: true, LinkedKey: l.Key,
	}
}

func parseTaskIDParam(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "missing or invalid id")
		return 0, false
	}
	return id, true
}

// handleTaskDetail: GET /api/tasks/detail?id=
func (s *Server) handleTaskDetail(w http.ResponseWriter, r *http.Request) {
	id, ok := parseTaskIDParam(w, r)
	if !ok {
		return
	}
	s.writeTaskDetail(w, id)
}

// activityItem is one feed row before enrichment: a row already built (a
// converted task event, or an event link's snapshot), or a raw watcher event
// (enriched only if it survives the limit).
type activityItem struct {
	ts    time.Time
	built *TimelineEvent
	ev    *watcher.Event
}

func parseTS(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

// handleTaskActivity: GET /api/tasks/activity?id=&filter=all|task|linked|resource&type=&rid=
//
// all: the task's own events plus its linked resources' events. task: its
// own events. linked: every event link, as its live event or else as a row
// built from its snapshot. resource: one linked resource's events. Each
// resource contributes at most its newest taskActivityLimit events (one
// limited query each), and the merged feed is newest first, at most
// taskActivityLimit rows.
func (s *Server) handleTaskActivity(w http.ResponseWriter, r *http.Request) {
	id, ok := parseTaskIDParam(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	filter := q.Get("filter")
	if filter == "" {
		filter = "all"
	}
	switch filter {
	case "all", "task", "linked", "resource":
	default:
		writeError(w, http.StatusBadRequest, "filter must be all, task, linked or resource")
		return
	}
	t, err := tasks.Get(s.DB, id)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	links, err := tasks.EventLinks(s.DB, id)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	linked := map[string]bool{}
	for _, l := range links {
		linked[l.Key] = true
	}

	var items []activityItem
	if filter == "all" || filter == "task" {
		evs, err := tasks.Events(s.DB, id)
		if err != nil {
			writeTaskError(w, err)
			return
		}
		for _, ev := range evs {
			te := taskEventToTimeline(ev, t)
			items = append(items, activityItem{ts: parseTS(te.TS), built: &te})
		}
	}
	seen := map[string]bool{}
	addEvents := func(evs []watcher.Event) {
		for i := range evs {
			if seen[evs[i].ID] {
				continue
			}
			seen[evs[i].ID] = true
			items = append(items, activityItem{ts: parseTS(evs[i].TS), ev: &evs[i]})
		}
	}
	addResource := func(typ, rid string) bool {
		evs, err := s.recentResourceEvents(typ, rid, taskActivityLimit)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return false
		}
		addEvents(evs)
		return true
	}
	switch filter {
	case "all":
		for _, l := range t.Links {
			if l.Kind == tasks.LinkResource && !addResource(l.ResourceType, l.ResourceID) {
				return
			}
		}
	case "resource":
		typ, rid := q.Get("type"), q.Get("rid")
		if typ == "" || rid == "" {
			writeError(w, http.StatusBadRequest, "filter=resource needs type and rid")
			return
		}
		found := false
		for _, l := range t.Links {
			found = found || (l.Kind == tasks.LinkResource && l.ResourceType == typ && l.ResourceID == rid)
		}
		if !found {
			writeTaskError(w, tasks.ErrLinkNotFound)
			return
		}
		if !addResource(typ, rid) {
			return
		}
	case "linked":
		for _, l := range links {
			ev, err := s.liveEvent(l)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if ev != nil {
				addEvents([]watcher.Event{*ev})
				continue
			}
			te := snapshotEvent(l)
			items = append(items, activityItem{ts: parseTS(te.TS), built: &te})
		}
	}

	sort.SliceStable(items, func(i, j int) bool { return items[i].ts.After(items[j].ts) })
	if len(items) > taskActivityLimit {
		items = items[:taskActivityLimit]
	}
	e := s.newEventEnricher()
	out := make([]TimelineEvent, 0, len(items))
	for _, it := range items {
		if it.built != nil {
			out = append(out, *it.built)
			continue
		}
		te := e.enrich(*it.ev)
		if k := linkedKeyOf(te, linked); k != "" {
			te.LinkedToTask, te.LinkedKey = true, k
		}
		out = append(out, te)
	}
	writeJSON(w, http.StatusOK, out)
}

type taskIDRequest struct {
	ID int64 `json:"id"`
}

// handleDeleteTask: POST /api/tasks/delete → 204
func (s *Server) handleDeleteTask(w http.ResponseWriter, r *http.Request) {
	var req taskIDRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if _, err := tasks.Delete(s.DB, webActor, req.ID); err != nil {
		writeTaskError(w, err)
		return
	}
	s.afterTaskWrite()
	w.WriteHeader(http.StatusNoContent)
}

// linkTargetBody names one link: kind plus type+rid or path.
type linkTargetBody struct {
	Kind string `json:"kind"`
	Type string `json:"type"`
	RID  string `json:"rid"`
	Path string `json:"path"`
}

// target converts the body; the tasks package validates it (bad kind or
// missing fields are ErrInvalid).
func (b linkTargetBody) target() tasks.LinkTarget {
	return tasks.LinkTarget{Kind: tasks.LinkKind(b.Kind), ResourceType: b.Type, ResourceID: b.RID, Worktree: b.Path}
}

type addTaskLinkRequest struct {
	ID    int64  `json:"id"`
	URL   string `json:"url"`
	Type  string `json:"type"`
	RID   string `json:"rid"`
	Path  string `json:"path"`
	Focus bool   `json:"focus"`
}

// handleAddTaskLink: POST /api/tasks/links/add, with exactly one of url,
// type+rid and path. A URL resolves with resourceurl.InferAny.
func (s *Server) handleAddTaskLink(w http.ResponseWriter, r *http.Request) {
	var req addTaskLinkRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	given := 0
	for _, set := range []bool{req.URL != "", req.Type != "" || req.RID != "", req.Path != ""} {
		if set {
			given++
		}
	}
	if given != 1 {
		writeError(w, http.StatusBadRequest, "set exactly one of url, type+rid and path")
		return
	}
	var lt tasks.LinkTarget
	switch {
	case req.URL != "":
		typ, id, ok := resourceurl.InferAny(strings.TrimSpace(req.URL))
		if !ok {
			writeError(w, http.StatusBadRequest, "unrecognised URL")
			return
		}
		lt = tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: typ, ResourceID: id}
	case req.Path != "":
		lt = tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: req.Path}
	default:
		lt = tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: req.Type, ResourceID: req.RID}
	}
	if _, err := tasks.AddLink(s.DB, webActor, req.ID, lt, req.Focus); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, req.ID)
}

type taskLinkRequest struct {
	ID int64 `json:"id"`
	linkTargetBody
	Focus bool `json:"focus"`
}

// handleRemoveTaskLink: POST /api/tasks/links/remove
func (s *Server) handleRemoveTaskLink(w http.ResponseWriter, r *http.Request) {
	var req taskLinkRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if err := tasks.RemoveLink(s.DB, webActor, req.ID, req.target()); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, req.ID)
}

// handleSetTaskLinkFocus: POST /api/tasks/links/focus
func (s *Server) handleSetTaskLinkFocus(w http.ResponseWriter, r *http.Request) {
	var req taskLinkRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if err := tasks.SetLinkFocus(s.DB, webActor, req.ID, req.target(), req.Focus); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, req.ID)
}

type taskLinkOrderRequest struct {
	ID      int64            `json:"id"`
	Focus   []linkTargetBody `json:"focus"`
	Related []linkTargetBody `json:"related"`
}

// handleSetTaskLinkOrder: POST /api/tasks/links/order
func (s *Server) handleSetTaskLinkOrder(w http.ResponseWriter, r *http.Request) {
	var req taskLinkOrderRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	conv := func(bs []linkTargetBody) []tasks.LinkTarget {
		out := make([]tasks.LinkTarget, 0, len(bs))
		for _, b := range bs {
			out = append(out, b.target())
		}
		return out
	}
	if err := tasks.SetLinkOrder(s.DB, webActor, req.ID, conv(req.Focus), conv(req.Related)); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, req.ID)
}

type addSubtaskRequest struct {
	ID   int64  `json:"id"`
	Text string `json:"text"`
}

// handleAddSubtask: POST /api/tasks/subtasks/add
func (s *Server) handleAddSubtask(w http.ResponseWriter, r *http.Request) {
	var req addSubtaskRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if _, err := tasks.AddSubtask(s.DB, webActor, req.ID, req.Text); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, req.ID)
}

type subtaskRequest struct {
	SubtaskID int64  `json:"subtask_id"`
	Text      string `json:"text"`
	Checked   bool   `json:"checked"`
}

// subtaskWrite runs op on the subtask named in the body and answers with
// its task's detail. The task is looked up first: after a removal there is
// no subtask left to find it from.
func (s *Server) subtaskWrite(w http.ResponseWriter, r *http.Request, op func(subtaskRequest) error) {
	var req subtaskRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	taskID, err := tasks.SubtaskTaskID(s.DB, req.SubtaskID)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	if err := op(req); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, taskID)
}

// handleEditSubtask: POST /api/tasks/subtasks/edit
func (s *Server) handleEditSubtask(w http.ResponseWriter, r *http.Request) {
	s.subtaskWrite(w, r, func(req subtaskRequest) error {
		return tasks.EditSubtask(s.DB, webActor, req.SubtaskID, req.Text)
	})
}

// handleCheckSubtask: POST /api/tasks/subtasks/check
func (s *Server) handleCheckSubtask(w http.ResponseWriter, r *http.Request) {
	s.subtaskWrite(w, r, func(req subtaskRequest) error {
		_, err := tasks.SetSubtaskChecked(s.DB, webActor, req.SubtaskID, req.Checked)
		return err
	})
}

// handleRemoveSubtask: POST /api/tasks/subtasks/remove
func (s *Server) handleRemoveSubtask(w http.ResponseWriter, r *http.Request) {
	s.subtaskWrite(w, r, func(req subtaskRequest) error {
		return tasks.RemoveSubtask(s.DB, webActor, req.SubtaskID)
	})
}

type subtaskOrderRequest struct {
	ID  int64   `json:"id"`
	IDs []int64 `json:"ids"`
}

// handleSetSubtaskOrder: POST /api/tasks/subtasks/order
func (s *Server) handleSetSubtaskOrder(w http.ResponseWriter, r *http.Request) {
	var req subtaskOrderRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if err := tasks.SetSubtaskOrder(s.DB, req.ID, req.IDs); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, req.ID)
}

type taskEventLinkRequest struct {
	ID       int64                `json:"id"`
	Key      string               `json:"key"`
	Snapshot *tasks.EventSnapshot `json:"snapshot"`
}

// handleLinkTaskEvent: POST /api/tasks/events/link. The stored key and
// snapshot come from resolveEventLink; a server-built snapshot replaces any
// the key already had (a client's, linked from the thread view).
func (s *Server) handleLinkTaskEvent(w http.ResponseWriter, r *http.Request) {
	var req taskEventLinkRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	key, snap, serverBuilt, err := s.resolveEventLink(req.Key, req.Snapshot)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	link := tasks.LinkEvent
	if serverBuilt {
		link = tasks.LinkEventReplace
	}
	if err := link(s.DB, webActor, req.ID, key, snap); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, req.ID)
}

// handleUnlinkTaskEvent: POST /api/tasks/events/unlink
func (s *Server) handleUnlinkTaskEvent(w http.ResponseWriter, r *http.Request) {
	var req taskEventLinkRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if err := tasks.UnlinkEvent(s.DB, webActor, req.ID, req.Key); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, req.ID)
}

type fromEventRequest struct {
	Key      string               `json:"key"`
	Snapshot *tasks.EventSnapshot `json:"snapshot"`
	Path     string               `json:"path"`
}

// fromEventTitle is a new task's title from its event: a Slack message's
// first non-blank line as plain text (slackPlain), else the event title,
// trimmed to 120 runes.
func fromEventTitle(snap tasks.EventSnapshot) string {
	title := strings.TrimSpace(snap.Title)
	if snap.Source == "slack" {
		for _, line := range strings.Split(snap.Body, "\n") {
			if line = strings.TrimSpace(line); line != "" {
				title = line
				break
			}
		}
	}
	if title == "" {
		title = strings.TrimSpace(snap.Body)
	}
	if snap.Source == "slack" {
		title = strings.TrimSpace(slackPlain(title))
	}
	if r := []rune(title); len(r) > maxFromEventTitle {
		title = strings.TrimSpace(string(r[:maxFromEventTitle]))
	}
	return title
}

// follows reports whether the worktree at path actively follows typ:id.
func (s *Server) follows(path, typ, id string) bool {
	sub := wdb.Subscriber(path)
	subs, err := watcherdb.SubscribersOf(s.DB, typ, id)
	if err != nil {
		return false
	}
	nowTS := time.Now().UTC().Format(time.RFC3339)
	for _, x := range subs {
		if x.Subscriber == sub && x.DeletedAt == nil && (x.ExpiresAt == nil || *x.ExpiresAt > nowTS) {
			return true
		}
	}
	return false
}

// handleTaskFromEvent: POST /api/tasks/from-event. Creates a task titled
// from the event, Focus-linked to its resource, with the event linked (under
// the key resolveEventLink settles on), all in one transaction
// (tasks.CreateFromEvent). path (the worktree the user acted in) is added as
// a Focus worktree link only when that worktree does not already follow the
// event's resource — when it does, the task shows there implicitly.
func (s *Server) handleTaskFromEvent(w http.ResponseWriter, r *http.Request) {
	var req fromEventRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	key, snap, _, err := s.resolveEventLink(req.Key, req.Snapshot)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	n := tasks.NewTask{Title: fromEventTitle(snap)}
	hasResource := snap.ResourceType != "" && snap.ResourceID != ""
	if hasResource {
		n.Focus = append(n.Focus, tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: snap.ResourceType, ResourceID: snap.ResourceID})
	}
	if req.Path != "" && (!hasResource || !s.follows(req.Path, snap.ResourceType, snap.ResourceID)) {
		n.Focus = append(n.Focus, tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: req.Path})
	}
	t, err := tasks.CreateFromEvent(s.DB, webActor, n, key, snap)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, t.ID)
}
