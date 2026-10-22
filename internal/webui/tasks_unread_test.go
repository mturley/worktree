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
	f := taskUnreadFixture(t)
	for _, c := range []struct {
		name string
		path string
		body any
		want int
	}{
		{"no id", "/api/task-read", map[string]any{"through_ts": tts(1)}, http.StatusBadRequest},
		{"no through_ts", "/api/task-read", map[string]any{"id": f.both.ID}, http.StatusBadRequest},
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

func TestCmuxMailboxForTaskOnlyUnread(t *testing.T) {
	f := taskUnreadFixture(t)
	if has, ok := f.s.worktreeHasUnread(f.s.newUnreadIndex(), f.wt); !ok || has {
		t.Fatalf("before: has %v ok %v", has, ok)
	}
	insertTaskEvent(t, f.s.DB, f.direct.ID, tts(3), "task_updated", "agent", "")
	if has, ok := f.s.worktreeHasUnread(f.s.newUnreadIndex(), f.wt); !ok || !has {
		t.Fatalf("after: has %v ok %v", has, ok)
	}
}
