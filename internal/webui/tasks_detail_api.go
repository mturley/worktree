package webui

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

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
	// Live is the watcher event as it is now, present when it still exists
	// with the snapshot's type. Only ev: keys have one.
	Live *TimelineEvent `json:"live,omitempty"`
}

type taskDetailDTO struct {
	taskDTO
	DetailLinks []taskDetailLinkDTO `json:"detail_links"` // same order as Links
	ImplicitVia []taskImplicitDTO   `json:"implicit"`
	Subtasks    []taskSubtaskDTO    `json:"subtasks"`
	EventLinks  []taskEventLinkDTO  `json:"event_links"`
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
	d := taskDetailDTO{
		taskDTO:     newTaskDTO(t),
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
			if r := e.resource(l.ResourceType, l.ResourceID); r != nil && r.CustomName != "" {
				dl.Title = r.CustomName
			} else if r != nil && r.Title != "" {
				dl.Title = r.Title
			} else {
				dl.Title = shortResourceRef(l.ResourceType, l.ResourceID)
			}
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
		if wid, ok := strings.CutPrefix(l.Key, "ev:"); ok {
			if ev, err := s.loadWatcherEvent(wid); err == nil && string(ev.Type) == l.Snapshot.Type {
				te := e.enrich(*ev)
				el.Live = &te
			}
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

// loadWatcherEvent reads one watcher event by id.
func (s *Server) loadWatcherEvent(id string) (*watcher.Event, error) {
	var ev watcher.Event
	var typ string
	var ext, body, author, authorID sql.NullString
	err := s.DB.QueryRow(`SELECT id, ts, external_ts, source, type, title, body, author, author_id
		FROM watcher_events WHERE id = ?`, id).
		Scan(&ev.ID, &ev.TS, &ext, &ev.Source, &typ, &ev.Title, &body, &author, &authorID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errEventNotFound
	}
	if err != nil {
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

// eventSnapshot resolves the snapshot to store for key. An ev: key is
// rebuilt from watcher_events, ignoring the client's, so a snapshot always
// says what the event really said. Any other key takes the client's, which
// must have a title or a body.
func (s *Server) eventSnapshot(key string, client *tasks.EventSnapshot) (tasks.EventSnapshot, error) {
	if wid, ok := strings.CutPrefix(key, "ev:"); ok {
		ev, err := s.loadWatcherEvent(wid)
		if err != nil {
			return tasks.EventSnapshot{}, err
		}
		return snapshotOf(s.newEventEnricher().enrich(*ev)), nil
	}
	if client == nil || (strings.TrimSpace(client.Title) == "" && strings.TrimSpace(client.Body) == "") {
		return tasks.EventSnapshot{}, fmt.Errorf("%w: the snapshot needs a title or a body", tasks.ErrInvalid)
	}
	return *client, nil
}

// eventKeys are the event-link keys that name te: its ev: key, and for a
// Slack message its slack:<channel>:<ts> key too, so a message linked from
// the thread view shows as linked in the feed.
func eventKeys(te TimelineEvent) []string {
	keys := []string{"ev:" + te.ID}
	if te.ResourceType == "slack" && te.ExternalTS != "" {
		if ch, _, ok := strings.Cut(te.ResourceID, ":"); ok {
			keys = append(keys, "slack:"+ch+":"+te.ExternalTS)
		}
	}
	return keys
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

// activityItem is one feed row before enrichment: a converted task event,
// or a raw watcher event (enriched only if it survives the limit).
type activityItem struct {
	ts   time.Time
	task *TimelineEvent
	ev   *watcher.Event
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
// all: the task's own events plus every event of its linked resources.
// task: its own events. linked: the live rows of its ev: event links.
// resource: one linked resource's events. Newest first, at most 200.
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
			items = append(items, activityItem{ts: parseTS(te.TS), task: &te})
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
	switch filter {
	case "all":
		for _, l := range t.Links {
			if l.Kind != tasks.LinkResource {
				continue
			}
			evs, err := watcherdb.EventsForResource(s.DB, l.ResourceType, l.ResourceID)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			addEvents(evs)
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
		evs, err := watcherdb.EventsForResource(s.DB, typ, rid)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		addEvents(evs)
	case "linked":
		for _, l := range links {
			wid, ok := strings.CutPrefix(l.Key, "ev:")
			if !ok {
				continue
			}
			ev, err := s.loadWatcherEvent(wid)
			if errors.Is(err, errEventNotFound) {
				continue
			}
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			addEvents([]watcher.Event{*ev})
		}
	}

	sort.SliceStable(items, func(i, j int) bool { return items[i].ts.After(items[j].ts) })
	if len(items) > taskActivityLimit {
		items = items[:taskActivityLimit]
	}
	e := s.newEventEnricher()
	out := make([]TimelineEvent, 0, len(items))
	for _, it := range items {
		if it.task != nil {
			out = append(out, *it.task)
			continue
		}
		te := e.enrich(*it.ev)
		for _, k := range eventKeys(te) {
			te.LinkedToTask = te.LinkedToTask || linked[k]
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

// handleLinkTaskEvent: POST /api/tasks/events/link
func (s *Server) handleLinkTaskEvent(w http.ResponseWriter, r *http.Request) {
	var req taskEventLinkRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if !strings.HasPrefix(req.Key, "ev:") && !strings.HasPrefix(req.Key, "slack:") {
		writeError(w, http.StatusBadRequest, "key must start with ev: or slack:")
		return
	}
	snap, err := s.eventSnapshot(req.Key, req.Snapshot)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	if err := tasks.LinkEvent(s.DB, webActor, req.ID, req.Key, snap); err != nil {
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
// first non-blank line, else the event title, trimmed to 120 runes.
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
// from the event, Focus-linked to its resource, with the event linked. path
// (the worktree the user acted in) is added as a Focus worktree link only
// when that worktree does not already follow the event's resource — when it
// does, the task shows there implicitly.
func (s *Server) handleTaskFromEvent(w http.ResponseWriter, r *http.Request) {
	var req fromEventRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if !strings.HasPrefix(req.Key, "ev:") && !strings.HasPrefix(req.Key, "slack:") {
		writeError(w, http.StatusBadRequest, "key must start with ev: or slack:")
		return
	}
	snap, err := s.eventSnapshot(req.Key, req.Snapshot)
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
	t, err := tasks.Create(s.DB, webActor, n)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	if err := tasks.LinkEvent(s.DB, webActor, t.ID, req.Key, snap); err != nil {
		writeTaskError(w, err)
		return
	}
	s.writeTaskDetail(w, t.ID)
}
