package webui

import (
	"fmt"
	"net/http"
	"strings"

	watcherdb "github.com/mturley/watcher/db"
	wtjira "github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/resourceurl"
	"github.com/mturley/worktree/internal/tasks"
)

// The task blocker API: the detail's blockers and blocks, the list's
// blocker labels, and the three blocker writes. See
// docs/web-ui-architecture.md "Task detail API".

// taskBlockerDTO is one of a task's blockers in the detail. Only the target
// fields its kind uses are set.
type taskBlockerDTO struct {
	ID    int64  `json:"id"`
	Kind  string `json:"kind"`  // task | resource | other
	Label string `json:"label"` // blockerLabeler.label
	URL   string `json:"url,omitempty"`
	// StatusLabel is the blocking thing's status as the UI shows it: a
	// task's state, a PR's merged/closed/open, a Jira issue's status name;
	// for a Slack thread, a link or other text, "resolved" once resolved,
	// else "". "" when unknown.
	StatusLabel      string `json:"status_label"`
	Resolved         bool   `json:"resolved"`
	ResolvedAuto     bool   `json:"resolved_auto"`
	ResolvedReason   string `json:"resolved_reason"`
	ManualResolvable bool   `json:"manual_resolvable"`
	TaskID           int64  `json:"task_id,omitempty"` // the blocking task
	ResourceType     string `json:"resource_type,omitempty"`
	ResourceID       string `json:"resource_id,omitempty"`
	Text             string `json:"text,omitempty"`
}

// taskBlocksDTO is a task this one blocks (by a task blocker, resolved or
// not).
type taskBlocksDTO struct {
	ID    int64  `json:"id"`
	Ref   string `json:"ref"`
	Title string `json:"title"`
	State string `json:"state"`
}

// resourceDisplayTitle is how a task's detail names a resource: its custom
// name, else its cached title, else its short ref ("#4498", "RHOAIENG-1").
// r is its enriched DTO, nil when unknown.
func resourceDisplayTitle(r *resourceDTO, typ, id string) string {
	switch {
	case r != nil && r.CustomName != "":
		return r.CustomName
	case r != nil && r.Title != "":
		return r.Title
	}
	return shortResourceRef(typ, id)
}

// blockerLabeler names blockers for ONE request: a task as "T<id>
// <title>" (deleted tasks included), a resource as resourceDisplayTitle,
// other as its text. It reads each blocking task and resource once.
type blockerLabeler struct {
	s        *Server
	heads    map[int64]tasks.Head
	resource func(typ, id string) *resourceDTO
}

// newBlockerLabeler loads the heads of every blocking task in bs. resource
// looks a resource up (the detail passes its eventEnricher's); nil uses a
// per-labeler memo of the resource's custom name and cached state.
func (s *Server) newBlockerLabeler(bs []tasks.Blocker, resource func(typ, id string) *resourceDTO) *blockerLabeler {
	var ids []int64
	for _, b := range bs {
		if b.Kind == tasks.BlockerTask {
			ids = append(ids, b.BlockingTaskID)
		}
	}
	heads, err := tasks.Heads(s.DB, ids)
	if err != nil {
		s.logger().Printf("tasks.Heads: %v", err)
		heads = map[int64]tasks.Head{}
	}
	if resource == nil {
		memo := map[string]*resourceDTO{}
		resource = func(typ, id string) *resourceDTO {
			k := typ + ":" + id
			if r, ok := memo[k]; ok {
				return r
			}
			r := &resourceDTO{Type: typ, ID: id}
			if meta, err := watcherdb.GetResourceMeta(s.DB, typ, id); err == nil && meta != nil {
				r.CustomName = meta.CustomName
			}
			s.enrichResourceDTO(r)
			memo[k] = r
			return r
		}
	}
	return &blockerLabeler{s: s, heads: heads, resource: resource}
}

func (l *blockerLabeler) label(b tasks.Blocker) string {
	switch b.Kind {
	case tasks.BlockerTask:
		if h, ok := l.heads[b.BlockingTaskID]; ok {
			return fmt.Sprintf("T%d %s", b.BlockingTaskID, h.Title)
		}
		return fmt.Sprintf("T%d", b.BlockingTaskID)
	case tasks.BlockerResource:
		return resourceDisplayTitle(l.resource(b.ResourceType, b.ResourceID), b.ResourceType, b.ResourceID)
	}
	return b.Text
}

// statusLabel is taskBlockerDTO.StatusLabel. It reads only the DB and the
// server's Jira status cache: never the network.
func (l *blockerLabeler) statusLabel(b tasks.Blocker) string {
	switch b.Kind {
	case tasks.BlockerTask:
		h, ok := l.heads[b.BlockingTaskID]
		if !ok || h.Deleted {
			return "deleted"
		}
		return string(h.State)
	case tasks.BlockerResource:
		switch b.ResourceType {
		case "pr":
			if st, ok := prBlockerStatus(l.s, b.ResourceID); ok {
				return st.Label
			}
			return ""
		case "jira":
			if r := l.resource(b.ResourceType, b.ResourceID); r != nil && r.Status != "" {
				return r.Status
			}
			if key, ok := wtjira.ParseKey(b.ResourceID); ok {
				if is, ok := l.s.cachedJiraStatuses()[key]; ok {
					return is.Status
				}
			}
			return ""
		}
	}
	if b.ResolvedAt != "" {
		return "resolved"
	}
	return ""
}

func (l *blockerLabeler) dto(b tasks.Blocker) taskBlockerDTO {
	d := taskBlockerDTO{
		ID: b.ID, Kind: b.Kind, Label: l.label(b), StatusLabel: l.statusLabel(b),
		Resolved: b.ResolvedAt != "", ResolvedAuto: b.ResolvedAuto, ResolvedReason: b.ResolvedReason,
		ManualResolvable: tasks.ManuallyResolvable(b.BlockerTarget),
		TaskID:           b.BlockingTaskID, ResourceType: b.ResourceType, ResourceID: b.ResourceID, Text: b.Text,
	}
	if b.Kind == tasks.BlockerResource {
		// The URL the user pasted, else whatever the DB knows.
		if d.URL = b.URL; d.URL == "" {
			d.URL = l.s.resourceURL(b.ResourceType, b.ResourceID)
		}
	}
	return d
}

// unresolvedLabels labels bs's unresolved blockers, in order. Never nil.
func (l *blockerLabeler) unresolvedLabels(bs []tasks.Blocker) []string {
	out := []string{}
	for _, b := range bs {
		if b.ResolvedAt == "" {
			out = append(out, l.label(b))
		}
	}
	return out
}

// allBlockerLabels maps every task with unresolved blockers to their
// labels, read once per listing request. A failure is logged and costs
// only the labels.
func (s *Server) allBlockerLabels() map[int64][]string {
	byTask, err := tasks.UnresolvedBlockers(s.DB)
	if err != nil {
		s.logger().Printf("tasks.UnresolvedBlockers: %v", err)
		return map[int64][]string{}
	}
	var all []tasks.Blocker
	for _, bs := range byTask {
		all = append(all, bs...)
	}
	l := s.newBlockerLabeler(all, nil)
	out := make(map[int64][]string, len(byTask))
	for id, bs := range byTask {
		out[id] = l.unresolvedLabels(bs)
	}
	return out
}

// taskBlockerLabels is one task's unresolved blocker labels. Never nil.
func (s *Server) taskBlockerLabels(id int64) []string {
	bs, err := tasks.Blockers(s.DB, id)
	if err != nil {
		s.logger().Printf("tasks.Blockers(%d): %v", id, err)
		return []string{}
	}
	return s.newBlockerLabeler(bs, nil).unresolvedLabels(bs)
}

// detailBlockers builds the detail's blockers, blocks and blocker labels.
// resource is the detail's eventEnricher lookup.
func (s *Server) detailBlockers(id int64, resource func(typ, id string) *resourceDTO) ([]taskBlockerDTO, []taskBlocksDTO, []string, error) {
	bs, err := tasks.Blockers(s.DB, id)
	if err != nil {
		return nil, nil, nil, err
	}
	l := s.newBlockerLabeler(bs, resource)
	blockers := make([]taskBlockerDTO, 0, len(bs))
	for _, b := range bs {
		blockers = append(blockers, l.dto(b))
	}
	ids, err := tasks.Blocking(s.DB, id)
	if err != nil {
		return nil, nil, nil, err
	}
	heads, err := tasks.Heads(s.DB, ids)
	if err != nil {
		return nil, nil, nil, err
	}
	blocks := make([]taskBlocksDTO, 0, len(ids))
	for _, bid := range ids {
		h := heads[bid]
		blocks = append(blocks, taskBlocksDTO{ID: bid, Ref: fmt.Sprintf("T%d", bid), Title: h.Title, State: string(h.State)})
	}
	return blockers, blocks, l.unresolvedLabels(bs), nil
}

type addBlockerRequest struct {
	ID     int64  `json:"id"`
	Kind   string `json:"kind"`
	TaskID int64  `json:"task_id"`
	URL    string `json:"url"`
	Type   string `json:"type"`
	RID    string `json:"rid"`
	Text   string `json:"text"`
}

// target turns the request into a BlockerTarget, or names what is wrong
// with its shape. A task blocker takes task_id; a resource blocker exactly
// one of url (resolved with resourceurl.InferAny, as links are) and
// type+rid; other takes text. The tasks package validates the values.
func (r addBlockerRequest) target() (tasks.BlockerTarget, string) {
	hasURL, hasRef := r.URL != "", r.Type != "" || r.RID != ""
	switch r.Kind {
	case tasks.BlockerTask:
		if hasURL || hasRef || r.Text != "" {
			return tasks.BlockerTarget{}, "a task blocker takes only task_id"
		}
		return tasks.BlockerTarget{Kind: r.Kind, BlockingTaskID: r.TaskID}, ""
	case tasks.BlockerResource:
		if r.TaskID != 0 || r.Text != "" {
			return tasks.BlockerTarget{}, "a resource blocker takes url or type+rid"
		}
		if hasURL == hasRef {
			return tasks.BlockerTarget{}, "set exactly one of url and type+rid"
		}
		if hasURL {
			typ, id, ok := resourceurl.InferAny(strings.TrimSpace(r.URL))
			if !ok {
				return tasks.BlockerTarget{}, "unrecognised URL"
			}
			return tasks.BlockerTarget{Kind: r.Kind, ResourceType: typ, ResourceID: id, URL: strings.TrimSpace(r.URL)}, ""
		}
		return tasks.BlockerTarget{Kind: r.Kind, ResourceType: r.Type, ResourceID: r.RID}, ""
	case tasks.BlockerOther:
		if hasURL || hasRef || r.TaskID != 0 {
			return tasks.BlockerTarget{}, "an other blocker takes only text"
		}
		return tasks.BlockerTarget{Kind: r.Kind, Text: r.Text}, ""
	}
	// An unknown kind: the tasks package names the valid ones.
	return tasks.BlockerTarget{Kind: r.Kind}, ""
}

// handleAddTaskBlocker: POST /api/tasks/blockers/add
// {id, kind, task_id? | url? | type+rid? | text?} -> the task's detail.
// A cycle is a 400 ("would create a blocking cycle"). afterTaskWrite runs
// before the response, so a blocker already satisfied (a merged PR) comes
// back resolved.
func (s *Server) handleAddTaskBlocker(w http.ResponseWriter, r *http.Request) {
	var req addBlockerRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	bt, msg := req.target()
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if _, err := tasks.AddBlocker(s.DB, webActor, req.ID, bt); err != nil {
		writeTaskError(w, err)
		return
	}
	s.afterTaskWrite()
	s.writeTaskDetail(w, req.ID)
}

type blockerRequest struct {
	BlockerID int64 `json:"blocker_id"`
	Resolved  bool  `json:"resolved"`
}

// blockerWrite runs op on the blocker named in the body, then
// afterTaskWrite, and answers with its task's detail. The task is looked up
// first: after a removal there is no blocker left to find it from.
func (s *Server) blockerWrite(w http.ResponseWriter, r *http.Request, op func(blockerRequest) error) {
	var req blockerRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	taskID, err := tasks.BlockerTaskID(s.DB, req.BlockerID)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	if err := op(req); err != nil {
		writeTaskError(w, err)
		return
	}
	s.afterTaskWrite()
	s.writeTaskDetail(w, taskID)
}

// handleRemoveTaskBlocker: POST /api/tasks/blockers/remove {blocker_id}
func (s *Server) handleRemoveTaskBlocker(w http.ResponseWriter, r *http.Request) {
	s.blockerWrite(w, r, func(req blockerRequest) error {
		return tasks.RemoveBlocker(s.DB, webActor, req.BlockerID)
	})
}

// handleResolveTaskBlocker: POST /api/tasks/blockers/resolve
// {blocker_id, resolved}. Only free-text, Slack thread and link blockers
// (manual_resolvable); any other is a 400.
func (s *Server) handleResolveTaskBlocker(w http.ResponseWriter, r *http.Request) {
	s.blockerWrite(w, r, func(req blockerRequest) error {
		return tasks.SetBlockerResolved(s.DB, webActor, req.BlockerID, req.Resolved)
	})
}
