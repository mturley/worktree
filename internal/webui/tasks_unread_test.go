package webui

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
)

// taskUnreadFixture: worktree wt focuses pr o/r#1 and relates pr o/r#2.
// Task "both" links both PRs (so it is in wt's scope implicitly, through two
// resources), task "direct" links wt, "global" links nothing and "gone" is
// deleted. No task has an event until a test writes one.
type taskUnread struct {
	s                          *Server
	wt                         string
	both, direct, global, gone tasks.Task
}

func taskUnreadFixture(t *testing.T) *taskUnread {
	t.Helper()
	s, wt := tasksServer(t)
	must(t, resources.Add(s.DB, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, resources.Add(s.DB, wt, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2", Related: true}))
	f := &taskUnread{s: s, wt: wt}
	f.both = mustTask(t, s, tasks.NewTask{Title: "both", Focus: []tasks.LinkTarget{resLink("pr", "o/r#1"), resLink("pr", "o/r#2")}})
	f.direct = mustTask(t, s, tasks.NewTask{Title: "direct", Focus: []tasks.LinkTarget{{Kind: tasks.LinkWorktree, Worktree: wt}}})
	f.global = mustTask(t, s, tasks.NewTask{Title: "global"})
	f.gone = mustTask(t, s, tasks.NewTask{Title: "gone", Focus: []tasks.LinkTarget{{Kind: tasks.LinkWorktree, Worktree: wt}}})
	if _, err := tasks.Delete(s.DB, webUser, f.gone.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`DELETE FROM task_events`); err != nil {
		t.Fatal(err)
	}
	return f
}

// seed writes the standard events: two agent events on "both", one agent
// and one user event on "direct", one agent event each on "global" and the
// deleted "gone".
func (f *taskUnread) seed(t *testing.T) {
	t.Helper()
	insertTaskEvent(t, f.s.DB, f.both.ID, tts(1), "task_updated", "agent", "")
	insertTaskEvent(t, f.s.DB, f.both.ID, tts(5), "task_updated", "agent", "")
	insertTaskEvent(t, f.s.DB, f.direct.ID, tts(3), "task_updated", "agent", "")
	insertTaskEvent(t, f.s.DB, f.direct.ID, tts(4), "task_updated", "user", "")
	insertTaskEvent(t, f.s.DB, f.global.ID, tts(2), "task_updated", "agent", "")
	insertTaskEvent(t, f.s.DB, f.gone.ID, tts(6), "task_updated", "agent", "")
}

// serveAll routes a request through every route in the real mux table.
func serveAll(t *testing.T, s *Server, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	for _, rt := range s.routes() {
		mux.HandleFunc(rt.pattern, rt.handler)
	}
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(method, target, rdr))
	return rec
}

func (f *taskUnread) worktree(t *testing.T) worktreeSummary {
	t.Helper()
	rec := serveAll(t, f.s, http.MethodGet, "/api/worktrees", nil)
	var wts []worktreeSummary
	if err := json.NewDecoder(rec.Body).Decode(&wts); err != nil {
		t.Fatal(err)
	}
	if len(wts) != 1 {
		t.Fatalf("worktrees = %+v", wts)
	}
	return wts[0]
}

func (f *taskUnread) resourceCounts(t *testing.T) map[string]int {
	t.Helper()
	rec := serveAll(t, f.s, http.MethodGet, "/api/worktree-resources?path="+url.QueryEscape(f.wt), nil)
	var rs []resourceDTO
	if err := json.NewDecoder(rec.Body).Decode(&rs); err != nil {
		t.Fatal(err)
	}
	out := map[string]int{}
	for _, r := range rs {
		out[r.ID] = r.UnreadCount
	}
	return out
}

func TestWorktreeUnreadCountsTaskEventsOnce(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	if w := f.worktree(t); w.HasUnread || w.UnreadCount != 0 {
		t.Fatalf("before any event: has_unread %v, unread_count %d", w.HasUnread, w.UnreadCount)
	}
	f.seed(t)
	w := f.worktree(t)
	// both (2, once although it links two of wt's resources) + direct (1:
	// the user's own event never counts). global and gone are not counted.
	if !w.HasUnread || w.UnreadCount != 3 {
		t.Fatalf("has_unread %v, unread_count %d; want true, 3", w.HasUnread, w.UnreadCount)
	}
	if fr := w.FocusResources; len(fr) != 1 || fr[0].UnreadCount != 2 {
		t.Fatalf("focus resources = %+v", fr)
	}
}

func TestResourceUnreadCountIncludesLinkingTasks(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	f.seed(t)
	// A watcher event on o/r#1 newer than its cursor adds to the task count.
	insertUnreadEvent(t, f.s.DB, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	got := f.resourceCounts(t)
	if got["o/r#1"] != 3 || got["o/r#2"] != 2 {
		t.Fatalf("resource counts = %v", got)
	}
	// The worktree adds the watcher event to its distinct task events.
	if w := f.worktree(t); w.UnreadCount != 4 {
		t.Fatalf("worktree unread_count = %d, want 4", w.UnreadCount)
	}
}

func TestTaskReadAndRestore(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	f.seed(t)
	rec := serveAll(t, f.s, http.MethodPost, "/api/task-read", map[string]any{"id": f.both.ID, "through_ts": tts(1)})
	if rec.Code != http.StatusOK {
		t.Fatalf("task-read = %d: %s", rec.Code, rec.Body.String())
	}
	var ch resourceReadResponse
	if err := json.NewDecoder(rec.Body).Decode(&ch); err != nil {
		t.Fatal(err)
	}
	if ch.PreviousTS != nil || ch.LastReadTS != tts(1) {
		t.Fatalf("change = %+v", ch)
	}
	if w := f.worktree(t); w.UnreadCount != 2 {
		t.Fatalf("after read: unread_count %d, want 2", w.UnreadCount)
	}

	// A second read moves the cursor on, so undoing the first is refused.
	rec = serveAll(t, f.s, http.MethodPost, "/api/task-read", map[string]any{"id": f.both.ID, "through_ts": tts(5)})
	if rec.Code != http.StatusOK {
		t.Fatalf("second task-read = %d", rec.Code)
	}
	rec = serveAll(t, f.s, http.MethodPost, "/api/task-read/restore",
		map[string]any{"id": f.both.ID, "last_read_ts": tts(1), "previous_ts": nil})
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale restore = %d, want 409", rec.Code)
	}
	prev := tts(1)
	rec = serveAll(t, f.s, http.MethodPost, "/api/task-read/restore",
		map[string]any{"id": f.both.ID, "last_read_ts": tts(5), "previous_ts": prev})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("restore = %d: %s", rec.Code, rec.Body.String())
	}
	if w := f.worktree(t); w.UnreadCount != 2 {
		t.Fatalf("after restore: unread_count %d, want 2", w.UnreadCount)
	}
}

func TestTaskReadErrors(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	for _, c := range []struct {
		name string
		path string
		body any
		want int
	}{
		{"no id", "/api/task-read", map[string]any{"through_ts": tts(1)}, http.StatusBadRequest},
		{"no through_ts", "/api/task-read", map[string]any{"id": f.both.ID}, http.StatusBadRequest},
		{"slack ts through_ts", "/api/task-read", map[string]any{"id": f.both.ID, "through_ts": "1787257539.775119"}, http.StatusBadRequest},
		{"date-only through_ts", "/api/task-read", map[string]any{"id": f.both.ID, "through_ts": "2026-01-01"}, http.StatusBadRequest},
		{"garbage through_ts", "/api/task-read", map[string]any{"id": f.both.ID, "through_ts": "garbage"}, http.StatusBadRequest},
		{"missing task", "/api/task-read", map[string]any{"id": 9999, "through_ts": tts(1)}, http.StatusNotFound},
		{"deleted task", "/api/task-read", map[string]any{"id": f.gone.ID, "through_ts": tts(1)}, http.StatusNotFound},
		{"restore no last_read_ts", "/api/task-read/restore", map[string]any{"id": f.both.ID}, http.StatusBadRequest},
		{"restore no id", "/api/task-read/restore", map[string]any{"last_read_ts": tts(1)}, http.StatusBadRequest},
	} {
		if rec := serveAll(t, f.s, http.MethodPost, c.path, c.body); rec.Code != c.want {
			t.Errorf("%s: %d, want %d (%s)", c.name, rec.Code, c.want, rec.Body.String())
		}
	}
	if rec := serveAll(t, f.s, http.MethodPost, "/api/task-read", "not an object"); rec.Code != http.StatusBadRequest {
		t.Errorf("bad JSON: %d", rec.Code)
	}
}

func TestTaskUnreadListsPerScope(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	get := func(query string) []taskUnreadDTO {
		t.Helper()
		rec := serveAll(t, f.s, http.MethodGet, "/api/task-unread?"+query, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d: %s", query, rec.Code, rec.Body.String())
		}
		var out []taskUnreadDTO
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if out == nil {
			t.Fatalf("GET %s: null, want []", query)
		}
		return out
	}
	if got := get("scope=all"); len(got) != 0 {
		t.Fatalf("before events = %+v", got)
	}
	f.seed(t)
	all := get("scope=all")
	// Newest unread first: both (5), direct (3), global (2).
	if len(all) != 3 || all[0].ID != f.both.ID || all[1].ID != f.direct.ID || all[2].ID != f.global.ID {
		t.Fatalf("all = %+v", all)
	}
	if all[0].Title != "both" || all[0].Count != 2 || all[0].NewestTS != tts(5) {
		t.Fatalf("both = %+v", all[0])
	}
	if got := get("scope=worktree&path=" + url.QueryEscape(f.wt)); len(got) != 2 || got[0].ID != f.both.ID || got[1].ID != f.direct.ID {
		t.Fatalf("worktree = %+v", got)
	}
	if got := get("scope=resource&type=pr&id=" + url.QueryEscape("o/r#2")); len(got) != 1 || got[0].ID != f.both.ID {
		t.Fatalf("resource = %+v", got)
	}
	for _, q := range []string{"scope=worktree", "scope=resource&type=pr", "scope=bogus"} {
		if rec := serveAll(t, f.s, http.MethodGet, "/api/task-unread?"+q, nil); rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", q, rec.Code)
		}
	}
}

func TestTaskDTOUnreadCount(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	f.seed(t)
	got := map[int64]int{}
	for _, tk := range listTasks(t, f.s, "scope=all") {
		got[tk.ID] = tk.UnreadCount
	}
	if got[f.both.ID] != 2 || got[f.direct.ID] != 1 || got[f.global.ID] != 1 {
		t.Fatalf("unread counts = %v", got)
	}
	// Single-task responses carry it too.
	d := decodeTask(t, serveTasks(t, f.s, http.MethodPost, "/api/tasks/update", map[string]any{"id": f.both.ID, "title": "both!"}))
	if d.UnreadCount != 2 {
		t.Fatalf("update response unread_count = %d", d.UnreadCount)
	}
	if det := getDetail(t, f.s, f.direct.ID); det.UnreadCount != 1 {
		t.Fatalf("detail unread_count = %d", det.UnreadCount)
	}
}

// unread_through_ts is the newest of the counted events — the same summary as
// unread_count — and is absent with nothing unread. A user event newer than
// it (direct's tts(4)) is not it.
func TestTaskDTOUnreadThroughTS(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	f.seed(t)
	got := map[int64]string{}
	for _, tk := range listTasks(t, f.s, "scope=all") {
		got[tk.ID] = tk.UnreadThroughTS
	}
	if got[f.both.ID] != tts(5) || got[f.direct.ID] != tts(3) || got[f.global.ID] != tts(2) {
		t.Fatalf("unread_through_ts = %v", got)
	}
	if det := getDetail(t, f.s, f.direct.ID); det.UnreadThroughTS != tts(3) {
		t.Fatalf("detail unread_through_ts = %q", det.UnreadThroughTS)
	}
	rec := serveAll(t, f.s, http.MethodPost, "/api/task-read", map[string]any{"id": f.direct.ID, "through_ts": tts(3)})
	if rec.Code != http.StatusOK {
		t.Fatalf("task-read = %d: %s", rec.Code, rec.Body.String())
	}
	if det := getDetail(t, f.s, f.direct.ID); det.UnreadThroughTS != "" || det.UnreadCount != 0 {
		t.Fatalf("after read: %q, %d; want absent", det.UnreadThroughTS, det.UnreadCount)
	}
}

// recordTaskUnreadLoads counts what unreadIndex.loadTasks reads, by part.
func recordTaskUnreadLoads(t *testing.T) map[string]int {
	t.Helper()
	got := map[string]int{}
	taskUnreadLoadHook = func(what string) { got[what]++ }
	t.Cleanup(func() { taskUnreadLoadHook = nil })
	return got
}

// Timelines render resource chips through fillOwn, so they never load task
// unread — even with task and watcher events unread and on the page.
func TestTimelinesDoNotLoadTaskUnread(t *testing.T) {
	f := taskUnreadFixture(t)
	f.seed(t)
	insertUnreadEvent(t, f.s.DB, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	loads := recordTaskUnreadLoads(t)
	for _, target := range []string{
		"/api/timeline?archived=false",
		"/api/worktree-timeline?path=" + url.QueryEscape(f.wt),
	} {
		rec := serveAll(t, f.s, http.MethodGet, target, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d: %s", target, rec.Code, rec.Body.String())
		}
	}
	if len(loads) != 0 {
		t.Fatalf("timelines loaded task unread: %v", loads)
	}
}

// The worktree list computes task membership once: its open-task counts'
// load primes the unread index, which then never builds its own.
func TestWorktreeListComputesTaskScopeOnce(t *testing.T) {
	f := taskUnreadFixture(t)
	f.seed(t)
	loads := recordTaskUnreadLoads(t)
	if w := f.worktree(t); w.UnreadCount != 3 {
		t.Fatalf("unread_count = %d, want 3", w.UnreadCount)
	}
	if loads["summaries"] != 1 || loads["scope"] != 0 {
		t.Fatalf("loads = %v, want one summaries read and no scope build", loads)
	}
}

// A Slack thread Slack calls read still counts its linking tasks' unread:
// has_unread stays Slack's verdict, resourceHasUnread ORs in the task count,
// and the worktree total counts the task once.
func TestSlackResourceWithTaskUnread(t *testing.T) {
	t.Parallel()
	s, wt := tasksServer(t)
	must(t, resources.Add(s.DB, wt, resources.Resource{Type: "slack", ID: "C1:1.2", URL: "https://x.slack.com/archives/C1/p12"}))
	tk := mustTask(t, s, tasks.NewTask{Title: "thread task", Focus: []tasks.LinkTarget{resLink("slack", "C1:1.2")}})
	if _, err := s.DB.Exec(`DELETE FROM task_events`); err != nil {
		t.Fatal(err)
	}
	insertTaskEvent(t, s.DB, tk.ID, tts(1), "task_updated", "agent", "")
	insertTaskEvent(t, s.DB, tk.ID, tts(2), "task_updated", "agent", "")
	f := &taskUnread{s: s, wt: wt}

	w := f.worktree(t)
	if !w.HasUnread || w.UnreadCount != 2 {
		t.Fatalf("worktree has_unread %v unread_count %d; want true, 2", w.HasUnread, w.UnreadCount)
	}
	if len(w.FocusResources) != 1 {
		t.Fatalf("focus = %+v", w.FocusResources)
	}
	dto := w.FocusResources[0]
	if dto.HasUnread || dto.UnreadCount != 2 || dto.TaskUnreadCount != 2 {
		t.Fatalf("slack dto = %+v", dto)
	}
	if !resourceHasUnread(dto) {
		t.Fatal("resourceHasUnread = false for a Slack thread with task unread")
	}
	if has, ok := s.worktreeHasUnread(s.newUnreadIndex(), wt); !ok || !has {
		t.Fatalf("mailbox: has %v ok %v", has, ok)
	}
}

// The mailbox runs every 5s, so it checks the resources' own unread first
// and loads task unread only when none is: a worktree with an unread
// resource never pays for the task load.
func TestCmuxMailboxChecksResourceUnreadFirst(t *testing.T) {
	f := taskUnreadFixture(t)
	f.seed(t)
	insertUnreadEvent(t, f.s.DB, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	loads := recordTaskUnreadLoads(t)
	if has, ok := f.s.worktreeHasUnread(f.s.newUnreadIndex(), f.wt); !ok || !has {
		t.Fatalf("has %v ok %v", has, ok)
	}
	if len(loads) != 0 {
		t.Fatalf("resource unread, yet task unread loaded: %v", loads)
	}
}

func TestCmuxMailboxForTaskOnlyUnread(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	if has, ok := f.s.worktreeHasUnread(f.s.newUnreadIndex(), f.wt); !ok || has {
		t.Fatalf("before: has %v ok %v", has, ok)
	}
	insertTaskEvent(t, f.s.DB, f.direct.ID, tts(3), "task_updated", "agent", "")
	if has, ok := f.s.worktreeHasUnread(f.s.newUnreadIndex(), f.wt); !ok || !has {
		t.Fatalf("after: has %v ok %v", has, ok)
	}
}
