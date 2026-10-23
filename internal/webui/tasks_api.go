package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/unread"
)

// maxTaskBodyBytes caps a task write's request body.
const maxTaskBodyBytes = 64 << 10

// webActor is who every web write is attributed to.
var webActor = tasks.Actor{Kind: tasks.ActorUser}

// taskLinkDTO is one of a task's links. Focus is the task's Primary flag.
type taskLinkDTO struct {
	Kind         string `json:"kind"` // "resource" | "worktree"
	ResourceType string `json:"resource_type,omitempty"`
	ResourceID   string `json:"resource_id,omitempty"`
	Worktree     string `json:"worktree,omitempty"`
	Focus        bool   `json:"focus"`
	Archived     bool   `json:"archived"`
}

// taskDTO is a task on the wire; ui/src/api/types.ts mirrors it field for
// field. It is the CLI's JSON shape (cmd/tasks_json.go) with a numeric id
// plus its display ref, and subtask counts instead of the subtasks.
type taskDTO struct {
	ID            int64         `json:"id"`
	Ref           string        `json:"ref"` // "T42"
	Title         string        `json:"title"`
	Description   string        `json:"description"`
	State         string        `json:"state"`
	Priority      string        `json:"priority"`
	Starred       bool          `json:"starred"`
	Due           string        `json:"due,omitempty"`
	Rank          string        `json:"rank"`
	CreatedAt     string        `json:"created_at"`
	UpdatedAt     string        `json:"updated_at"`
	StartedAt     string        `json:"started_at,omitempty"`
	CompletedAt   string        `json:"completed_at,omitempty"`
	Archived      bool          `json:"archived"`
	Links         []taskLinkDTO `json:"links"`              // never null
	Implicit      []string      `json:"implicit_worktrees"` // never null
	SubtasksTotal int           `json:"subtasks_total"`
	SubtasksDone  int           `json:"subtasks_done"`
	// UnreadCount is the task's unread events: agent events newer than its
	// cursor (unread.TaskSummaries). Always sent, 0 included.
	UnreadCount int `json:"unread_count"`
	// UnreadThroughTS is the newest of those events, from the same summary:
	// what the task modal's Mark read sends as through_ts, so it clears only
	// what was counted, never an event that arrived after. Absent at 0.
	UnreadThroughTS string `json:"unread_through_ts,omitempty"`
	// Blocked: some blocker is unresolved; BlockerCount is how many.
	Blocked      bool `json:"blocked"`
	BlockerCount int  `json:"blocker_count"`
	// BlockerLabels names the unresolved blockers (blockerLabeler), oldest
	// first, for the row chip's tooltip. Never null.
	BlockerLabels []string `json:"blocker_labels"`
}

func newTaskDTO(t tasks.Task) taskDTO {
	out := taskDTO{
		ID: t.ID, Ref: "T" + strconv.FormatInt(t.ID, 10),
		Title: t.Title, Description: t.Description,
		State: string(t.State), Priority: string(t.Priority), Starred: t.Starred, Due: t.Due,
		Rank:      t.Rank,
		CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt, StartedAt: t.StartedAt, CompletedAt: t.CompletedAt,
		Archived:      t.Archived,
		Links:         make([]taskLinkDTO, 0, len(t.Links)),
		Implicit:      append(make([]string, 0, len(t.Implicit)), t.Implicit...),
		SubtasksTotal: len(t.Subtasks),
		Blocked:       t.Blocked, BlockerCount: t.BlockerCount,
		BlockerLabels: []string{},
	}
	for _, l := range t.Links {
		out.Links = append(out.Links, taskLinkDTO{
			Kind: string(l.Kind), ResourceType: l.ResourceType, ResourceID: l.ResourceID,
			Worktree: l.Worktree, Focus: l.Primary, Archived: l.Archived,
		})
	}
	for _, s := range t.Subtasks {
		if s.Checked {
			out.SubtasksDone++
		}
	}
	return out
}

// writeTaskError maps a tasks error to its status: ErrInvalid 400,
// ErrNotFound (ErrLinkNotFound included) 404, anything else 500.
func writeTaskError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, tasks.ErrInvalid):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, tasks.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// decodeTaskBody decodes a task write's JSON body, capped at
// maxTaskBodyBytes. It writes the 400 itself and reports false on failure.
func decodeTaskBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxTaskBodyBytes)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

// handleListTasks: GET /api/tasks?scope=all|worktree|resource
//
//	&path=<worktree>          (scope=worktree)
//	&type=<type>&id=<id>      (scope=resource)
//	&completed=1 &archived=1
//
// The server only scopes: sorting and the other filters are client-side.
// The result is in master order.
func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sc, ok := parseTaskScope(w, q)
	if !ok {
		return
	}
	ts, err := tasks.List(s.DB, tasks.Filter{
		Scope:            sc,
		IncludeCompleted: q.Get("completed") == "1",
		IncludeArchived:  q.Get("archived") == "1",
	})
	if err != nil {
		writeTaskError(w, err)
		return
	}
	sums := s.taskUnreadSummaries()
	labels := s.allBlockerLabels()
	out := make([]taskDTO, 0, len(ts))
	for _, t := range ts {
		d := newTaskDTO(t)
		d.UnreadCount, d.UnreadThroughTS = sums[t.ID].Count, sums[t.ID].NewestTS
		if l := labels[t.ID]; l != nil && t.Blocked { // a done task is never blocked
			d.BlockerLabels = l
		}
		out = append(out, d)
	}
	writeJSON(w, http.StatusOK, out)
}

// parseTaskScope reads ?scope=all|worktree|resource with its path or
// type+id. It writes the 400 itself and reports false on bad input.
func parseTaskScope(w http.ResponseWriter, q url.Values) (tasks.Scope, bool) {
	switch q.Get("scope") {
	case "", "all":
		return tasks.Scope{Kind: tasks.ScopeAll}, true
	case "worktree":
		if q.Get("path") == "" {
			writeError(w, http.StatusBadRequest, "missing path")
			return tasks.Scope{}, false
		}
		return tasks.Scope{Kind: tasks.ScopeWorktree, Worktree: q.Get("path")}, true
	case "resource":
		if q.Get("type") == "" || q.Get("id") == "" {
			writeError(w, http.StatusBadRequest, "missing type or id")
			return tasks.Scope{}, false
		}
		return tasks.Scope{Kind: tasks.ScopeResource, ResourceType: q.Get("type"), ResourceID: q.Get("id")}, true
	default:
		writeError(w, http.StatusBadRequest, "scope must be all, worktree or resource")
		return tasks.Scope{}, false
	}
}

// taskUnreadSummaries is every task's unread summary, read once per
// request. A failure is logged and costs only the counts (all 0).
func (s *Server) taskUnreadSummaries() map[int64]unread.Summary {
	sums, err := unread.TaskSummaries(s.DB)
	if err != nil {
		s.logger().Printf("unread.TaskSummaries: %v", err)
		return map[int64]unread.Summary{}
	}
	return sums
}

// newTaskDTOWithUnread is newTaskDTO with unread_count and blocker_labels
// filled, for the endpoints that return one task.
func (s *Server) newTaskDTOWithUnread(t tasks.Task) taskDTO {
	d := newTaskDTO(t)
	sum := s.taskUnreadSummaries()[t.ID]
	d.UnreadCount, d.UnreadThroughTS = sum.Count, sum.NewestTS
	if t.BlockerCount > 0 {
		d.BlockerLabels = s.taskBlockerLabels(t.ID)
	}
	return d
}

type createTaskRequest struct {
	Title    string `json:"title"`
	Priority string `json:"priority"`
	Starred  bool   `json:"starred"`
	Path     string `json:"path"` // Focus worktree link
	Type     string `json:"type"` // with ID: Focus resource link
	ID       string `json:"id"`
	After    int64  `json:"after"`
	Before   int64  `json:"before"`
}

// handleCreateTask: POST /api/tasks. The creating context becomes a Focus
// link: path a worktree, type+id a resource, neither a global task.
func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	var req createTaskRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if (req.Type == "") != (req.ID == "") {
		writeError(w, http.StatusBadRequest, "type and id go together")
		return
	}
	n := tasks.NewTask{
		Title: req.Title, Priority: tasks.Priority(req.Priority), Starred: req.Starred,
		After: req.After, Before: req.Before,
	}
	if req.Path != "" {
		n.Focus = append(n.Focus, tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: req.Path})
	}
	if req.Type != "" {
		n.Focus = append(n.Focus, tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: req.Type, ResourceID: req.ID})
	}
	t, err := tasks.Create(s.DB, webActor, n)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.newTaskDTOWithUnread(t))
}

// updateTaskRequest: an absent field is unchanged; due "" clears.
type updateTaskRequest struct {
	ID          int64   `json:"id"`
	Title       *string `json:"title"`
	Description *string `json:"description"`
	Priority    *string `json:"priority"`
	Starred     *bool   `json:"starred"`
	Due         *string `json:"due"`
}

// handleUpdateTask: POST /api/tasks/update
func (s *Server) handleUpdateTask(w http.ResponseWriter, r *http.Request) {
	var req updateTaskRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	p := tasks.Patch{Title: req.Title, Description: req.Description, Starred: req.Starred, Due: req.Due}
	if req.Priority != nil {
		pr := tasks.Priority(*req.Priority)
		p.Priority = &pr
	}
	t, err := tasks.Update(s.DB, webActor, req.ID, p)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.newTaskDTOWithUnread(t))
}

type setTaskStateRequest struct {
	ID    int64  `json:"id"`
	State string `json:"state"`
}

// handleSetTaskState: POST /api/tasks/state
func (s *Server) handleSetTaskState(w http.ResponseWriter, r *http.Request) {
	var req setTaskStateRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	sc, err := tasks.SetState(s.DB, webActor, req.ID, tasks.State(req.State))
	if err != nil {
		writeTaskError(w, err)
		return
	}
	if sc.From != sc.To {
		// Reopening puts the task's resource blockers back under
		// evaluation; task blockers already resolved inside SetState.
		s.afterTaskWrite()
	}
	t, err := tasks.Get(s.DB, req.ID)
	if err != nil {
		writeTaskError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.newTaskDTOWithUnread(t))
}

type moveTaskRequest struct {
	ID     int64  `json:"id"`
	After  *int64 `json:"after"`
	Before *int64 `json:"before"`
}

// handleMoveTask: POST /api/tasks/move, with exactly one of after and before.
func (s *Server) handleMoveTask(w http.ResponseWriter, r *http.Request) {
	var req moveTaskRequest
	if !decodeTaskBody(w, r, &req) {
		return
	}
	var err error
	switch {
	case (req.After == nil) == (req.Before == nil):
		writeError(w, http.StatusBadRequest, "set exactly one of after and before")
		return
	case req.After != nil:
		err = tasks.MoveAfter(s.DB, req.ID, *req.After)
	default:
		err = tasks.MoveBefore(s.DB, req.ID, *req.Before)
	}
	if err != nil {
		writeTaskError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// openTaskCountsPriming loads every scope's open-task count once per
// request, and primes ix with the task membership from the SAME load
// (tasks.CountsAndScope), so the request's unread badges do not compute it
// a second time. A failure is logged and costs only the counts (all 0),
// never the listing; ix is then left unprimed and tries its own load.
func (s *Server) openTaskCountsPriming(ix *unreadIndex) tasks.Counts {
	c, sc, err := tasks.CountsAndScope(s.DB)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Printf("tasks.CountsAndScope: %v", err)
		}
		return tasks.Counts{}
	}
	ix.primeTaskScope(sc)
	return c
}

// resourceBlockCounts is tasks.ResourceBlockCounts, read once per request.
// A failure is logged and costs only the counts (all 0).
func (s *Server) resourceBlockCounts() map[string]int {
	c, err := tasks.ResourceBlockCounts(s.DB)
	if err != nil {
		s.logger().Printf("tasks.ResourceBlockCounts: %v", err)
		return map[string]int{}
	}
	return c
}

// worktreeTaskCount is path's open-task count, looked up by the canonical
// path OpenCounts keys on (see the wdb.Subscriber gotcha in CLAUDE.md).
func worktreeTaskCount(c tasks.Counts, path string) int {
	canon, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(path))
	return c.ByWorktree[canon]
}

// resourceTaskCount is the open-task count of the resource typ:id.
func resourceTaskCount(c tasks.Counts, typ, id string) int {
	return c.ByResource[typ+":"+id]
}

// seedTasksVersion is the tasks version a new stream starts from, so it
// reports only changes made after it connected. 0 when it can't be read.
func (s *Server) seedTasksVersion() int64 {
	v, err := tasks.Version(s.DB)
	if err != nil {
		return 0
	}
	return v
}

// tasksVersionAdvanced reports whether tasks.Version has moved past *last,
// recording the new value. A read error reports no change.
func (s *Server) tasksVersionAdvanced(last *int64) bool {
	v, err := tasks.Version(s.DB)
	if err != nil || v == *last {
		return false
	}
	*last = v
	return true
}

// handleTaskRead: POST /api/task-read, body {"id":..., "through_ts":...}
// -> 200 resourceReadResponse ({previous_ts, last_read_ts}).
//
// The task twin of handleResourceRead, over the task's cursor
// (resource_type "task", resource_id the task id). through_ts is the newest
// task event the client rendered, never the server's MAX(ts), for the same
// reason. 404 for a task that is missing or deleted.
func (s *Server) handleTaskRead(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID        int64  `json:"id"`
		ThroughTS string `json:"through_ts"`
	}
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if req.ID <= 0 {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	if !validThroughTS(w, req.ThroughTS) {
		return
	}
	if _, err := tasks.Get(s.DB, req.ID); err != nil {
		writeTaskError(w, err)
		return
	}
	ch, err := unread.Mark(s.DB, taskResourceType, strconv.FormatInt(req.ID, 10), req.ThroughTS)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resourceReadResponse{PreviousTS: ch.Previous, LastReadTS: ch.Current})
}

// handleTaskReadRestore: POST /api/task-read/restore, body
// {"id":..., "last_read_ts":..., "previous_ts":...|null} -> 204, the undo of
// a POST /api/task-read, echoing back what it returned. 409 when the cursor
// has moved on since (unread.Restore's compare-and-swap).
func (s *Server) handleTaskReadRestore(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID         int64   `json:"id"`
		LastReadTS string  `json:"last_read_ts"`
		PreviousTS *string `json:"previous_ts"`
	}
	if !decodeTaskBody(w, r, &req) {
		return
	}
	if req.ID <= 0 || req.LastReadTS == "" {
		writeError(w, http.StatusBadRequest, "id and last_read_ts are required")
		return
	}
	err := unread.Restore(s.DB, taskResourceType, strconv.FormatInt(req.ID, 10), req.LastReadTS, req.PreviousTS)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, unread.ErrCursorMoved):
		writeError(w, http.StatusConflict, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// taskUnreadDTO is one task with unread events, for GET /api/task-unread.
type taskUnreadDTO struct {
	ID       int64  `json:"id"`
	Title    string `json:"title"`
	Count    int    `json:"count"`
	NewestTS string `json:"newest_ts"`
}

// handleTaskUnread: GET /api/task-unread?scope=all|worktree|resource
// (&path= | &type=&id=, as GET /api/tasks) -> []taskUnreadDTO, never null.
//
// Every task in the scope's FEED membership (completed and archived tasks
// included, as tasks.ScopeTaskIDs) with unread events, newest unread first.
// A mark-all-read uses it to clear the tasks of its feed, sending each
// newest_ts as through_ts.
func (s *Server) handleTaskUnread(w http.ResponseWriter, r *http.Request) {
	sc, ok := parseTaskScope(w, r.URL.Query())
	if !ok {
		return
	}
	sums, err := unread.TaskSummaries(s.DB)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := []taskUnreadDTO{}
	if len(sums) > 0 {
		ts, err := tasks.List(s.DB, tasks.Filter{Scope: sc, IncludeCompleted: true, IncludeArchived: true})
		if err != nil {
			writeTaskError(w, err)
			return
		}
		for _, t := range ts {
			if sum := sums[t.ID]; sum.Count > 0 {
				out = append(out, taskUnreadDTO{ID: t.ID, Title: t.Title, Count: sum.Count, NewestTS: sum.NewestTS})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].NewestTS != out[j].NewestTS {
			return out[i].NewestTS > out[j].NewestTS
		}
		return out[i].ID > out[j].ID
	})
	writeJSON(w, http.StatusOK, out)
}
