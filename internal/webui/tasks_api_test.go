package webui

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/testgit"
)

var webUser = tasks.Actor{Kind: tasks.ActorUser}

// tasksServer returns a server over a fresh DB with one registered worktree.
func tasksServer(t *testing.T) (*Server, string) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	wt := testgit.Worktree(t)
	if err := registry.Register(conn, registry.Entry{Path: wt, Repo: "r", RepoRoot: wt, Branch: "b", CreatedAt: "now"}); err != nil {
		t.Fatal(err)
	}
	return &Server{DB: conn}, wt
}

// serveTasks routes a request through the real mux table so the method +
// path patterns are exercised too.
func serveTasks(t *testing.T, s *Server, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	for _, rt := range s.routes() {
		if strings.Contains(rt.pattern, "/api/tasks") {
			mux.HandleFunc(rt.pattern, rt.handler)
		}
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

func decodeTask(t *testing.T, rec *httptest.ResponseRecorder) taskDTO {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var d taskDTO
	if err := json.NewDecoder(rec.Body).Decode(&d); err != nil {
		t.Fatal(err)
	}
	return d
}

func listTasks(t *testing.T, s *Server, query string) []taskDTO {
	t.Helper()
	rec := serveTasks(t, s, http.MethodGet, "/api/tasks?"+query, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s = %d: %s", query, rec.Code, rec.Body.String())
	}
	var out []taskDTO
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func titles(ts []taskDTO) string {
	var out []string
	for _, tk := range ts {
		out = append(out, tk.Title)
	}
	return strings.Join(out, ",")
}

func TestTasksAPICreateListScopes(t *testing.T) {
	s, wt := tasksServer(t)
	a := decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "a"}))
	if a.Ref != "T1" || a.ID != 1 || a.Links == nil || len(a.Links) != 0 || a.Implicit == nil || a.Priority != "none" {
		t.Fatalf("a = %+v", a)
	}
	// Lists marshal as [], never null.
	rec := serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "b", "path": wt, "starred": true, "priority": "high"})
	raw := rec.Body.String()
	var b taskDTO
	json.Unmarshal([]byte(raw), &b)
	if rec.Code != http.StatusOK || len(b.Links) != 1 || b.Links[0].Kind != "worktree" || !b.Links[0].Focus || !b.Starred || b.Priority != "high" {
		t.Fatalf("b = %d %s", rec.Code, raw)
	}
	if b.Links[0].Worktree != wdbCanon(wt) {
		t.Fatalf("worktree link %q, want canonical %q", b.Links[0].Worktree, wdbCanon(wt))
	}
	c := decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "c", "type": "pr", "id": "o/r#1"}))
	if len(c.Links) != 1 || c.Links[0].Kind != "resource" || c.Links[0].ResourceType != "pr" || c.Links[0].ResourceID != "o/r#1" || !c.Links[0].Focus {
		t.Fatalf("c = %+v", c)
	}

	if got := titles(listTasks(t, s, "scope=all")); got != "a,b,c" {
		t.Fatalf("all = %s", got)
	}
	if got := titles(listTasks(t, s, "")); got != "a,b,c" {
		t.Fatalf("default scope = %s", got)
	}
	if got := titles(listTasks(t, s, "scope=worktree&path="+url.QueryEscape(wt))); got != "b" {
		t.Fatalf("worktree = %s", got)
	}
	if got := titles(listTasks(t, s, "scope=resource&type=pr&id="+url.QueryEscape("o/r#1"))); got != "c" {
		t.Fatalf("resource = %s", got)
	}
	// An empty list is [] on the wire.
	rec = serveTasks(t, s, http.MethodGet, "/api/tasks?scope=resource&type=pr&id=nope", nil)
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("empty list = %q", rec.Body.String())
	}
}

func wdbCanon(p string) string {
	c, _ := wdb.WorktreePathFromSubscriber(wdb.Subscriber(p))
	return c
}

func TestTasksAPICreateAfter(t *testing.T) {
	s, _ := tasksServer(t)
	a := decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "a"}))
	decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "b"}))
	decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "c", "after": a.ID}))
	if got := titles(listTasks(t, s, "scope=all")); got != "a,c,b" {
		t.Fatalf("after: %s", got)
	}
	decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "d", "before": a.ID}))
	if got := titles(listTasks(t, s, "scope=all")); got != "d,a,c,b" {
		t.Fatalf("before: %s", got)
	}
	rec := serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "e", "after": a.ID, "before": a.ID})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("after+before = %d", rec.Code)
	}
	rec = serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "e", "after": 999})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("after unknown = %d %s", rec.Code, rec.Body.String())
	}
}

func TestTasksAPIUpdateStateMove(t *testing.T) {
	s, _ := tasksServer(t)
	a := decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "a"}))
	b := decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "b"}))

	up := decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks/update", map[string]any{"id": a.ID, "starred": true}))
	if !up.Starred || up.Title != "a" || up.Priority != "none" {
		t.Fatalf("starred update = %+v", up)
	}
	up = decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks/update", map[string]any{"id": a.ID, "title": "A", "priority": "low", "due": "2026-11-01"}))
	if up.Title != "A" || up.Priority != "low" || up.Due != "2026-11-01" || !up.Starred {
		t.Fatalf("multi update = %+v", up)
	}
	up = decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks/update", map[string]any{"id": a.ID, "due": ""}))
	if up.Due != "" {
		t.Fatalf("due not cleared: %+v", up)
	}

	done := decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks/state", map[string]any{"id": b.ID, "state": "done"}))
	if done.State != "done" || done.CompletedAt == "" {
		t.Fatalf("state = %+v", done)
	}
	if got := titles(listTasks(t, s, "scope=all")); got != "A" {
		t.Fatalf("open = %s", got)
	}
	if got := titles(listTasks(t, s, "scope=all&completed=1")); got != "A,b" {
		t.Fatalf("with completed = %s", got)
	}

	rec := serveTasks(t, s, http.MethodPost, "/api/tasks/move", map[string]any{"id": b.ID, "before": a.ID})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("move = %d %s", rec.Code, rec.Body.String())
	}
	if got := titles(listTasks(t, s, "scope=all&completed=1")); got != "b,A" {
		t.Fatalf("after move = %s", got)
	}
	rec = serveTasks(t, s, http.MethodPost, "/api/tasks/move", map[string]any{"id": b.ID, "after": a.ID})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("move after = %d", rec.Code)
	}
	if got := titles(listTasks(t, s, "scope=all&completed=1")); got != "A,b" {
		t.Fatalf("after move after = %s", got)
	}
	for _, body := range []map[string]any{
		{"id": b.ID, "after": a.ID, "before": a.ID},
		{"id": b.ID},
	} {
		if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/move", body); rec.Code != http.StatusBadRequest {
			t.Fatalf("move %v = %d", body, rec.Code)
		}
	}
}

func TestTasksAPIErrors(t *testing.T) {
	s, _ := tasksServer(t)
	a := decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks", map[string]any{"title": "a"}))
	cases := []struct {
		name, method, target string
		body                 any
		want                 int
	}{
		{"bad scope", http.MethodGet, "/api/tasks?scope=bogus", nil, 400},
		{"worktree scope without path", http.MethodGet, "/api/tasks?scope=worktree", nil, 400},
		{"resource scope without id", http.MethodGet, "/api/tasks?scope=resource&type=pr", nil, 400},
		{"blank title", http.MethodPost, "/api/tasks", map[string]any{"title": "  "}, 400},
		{"bad priority create", http.MethodPost, "/api/tasks", map[string]any{"title": "x", "priority": "urgent"}, 400},
		{"type without id", http.MethodPost, "/api/tasks", map[string]any{"title": "x", "type": "pr"}, 400},
		{"bad json", http.MethodPost, "/api/tasks", "not an object", 400},
		{"update unknown id", http.MethodPost, "/api/tasks/update", map[string]any{"id": 999, "starred": true}, 404},
		{"update bad priority", http.MethodPost, "/api/tasks/update", map[string]any{"id": a.ID, "priority": "urgent"}, 400},
		{"update empty priority", http.MethodPost, "/api/tasks/update", map[string]any{"id": a.ID, "priority": ""}, 400},
		{"update bad due", http.MethodPost, "/api/tasks/update", map[string]any{"id": a.ID, "due": "tomorrow"}, 400},
		{"state unknown id", http.MethodPost, "/api/tasks/state", map[string]any{"id": 999, "state": "done"}, 404},
		{"state bad", http.MethodPost, "/api/tasks/state", map[string]any{"id": a.ID, "state": "finished"}, 400},
		{"move unknown id", http.MethodPost, "/api/tasks/move", map[string]any{"id": 999, "after": a.ID}, 404},
		{"move unknown ref", http.MethodPost, "/api/tasks/move", map[string]any{"id": a.ID, "after": 999}, 404},
	}
	for _, c := range cases {
		rec := serveTasks(t, s, c.method, c.target, c.body)
		if rec.Code != c.want {
			t.Errorf("%s: %d (want %d) %s", c.name, rec.Code, c.want, rec.Body.String())
		}
	}
	// An oversized body is refused, not read.
	big := map[string]any{"title": strings.Repeat("x", 70<<10)}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks", big); rec.Code != http.StatusBadRequest {
		t.Fatalf("oversized body = %d", rec.Code)
	}
}

func TestStreamEmitsTasksChanged(t *testing.T) {
	s, _ := tasksServer(t)
	last := s.seedTasksVersion()
	if s.tasksVersionAdvanced(&last) {
		t.Fatal("nothing changed yet")
	}
	if _, err := tasks.Create(s.DB, webUser, tasks.NewTask{Title: "x"}); err != nil {
		t.Fatal(err)
	}
	if !s.tasksVersionAdvanced(&last) {
		t.Fatal("a write must advance the version")
	}
	if s.tasksVersionAdvanced(&last) {
		t.Fatal("the same version must not fire twice")
	}
}

func TestWorktreeAndResourceDTOsCarryOpenTaskCount(t *testing.T) {
	s, x := tasksServer(t)
	must(t, resources.Add(s.DB, x, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, resources.Add(s.DB, x, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2", Related: true}))
	pr := tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: "pr", ResourceID: "o/r#1"}
	wtX := tasks.LinkTarget{Kind: tasks.LinkWorktree, Worktree: x}
	for _, n := range []tasks.NewTask{
		{Title: "a", Focus: []tasks.LinkTarget{pr}},
		{Title: "b", Focus: []tasks.LinkTarget{wtX}},
		{Title: "d"},
	} {
		if _, err := tasks.Create(s.DB, webUser, n); err != nil {
			t.Fatal(err)
		}
	}
	c, err := tasks.Create(s.DB, webUser, tasks.NewTask{Title: "c", Focus: []tasks.LinkTarget{pr}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.SetState(s.DB, webUser, c.ID, tasks.StateDone); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	s.handleWorktrees(rec, httptest.NewRequest(http.MethodGet, "/api/worktrees", nil))
	var wts []worktreeSummary
	json.NewDecoder(rec.Body).Decode(&wts)
	if len(wts) != 1 || wts[0].OpenTaskCount != 2 {
		t.Fatalf("worktrees = %+v", wts)
	}
	if fr := wts[0].FocusResources; len(fr) != 1 || fr[0].OpenTaskCount != 1 {
		t.Fatalf("focus resources = %+v", fr)
	}

	rec = httptest.NewRecorder()
	s.handleWorktreeResources(rec, httptest.NewRequest(http.MethodGet, "/api/worktree-resources?path="+url.QueryEscape(x), nil))
	var rs []resourceDTO
	json.NewDecoder(rec.Body).Decode(&rs)
	counts := map[string]int{}
	for _, r := range rs {
		counts[r.ID] = r.OpenTaskCount
	}
	if len(rs) != 2 || counts["o/r#1"] != 1 || counts["o/r#2"] != 0 {
		t.Fatalf("worktree resources = %+v", rs)
	}
	if !strings.Contains(mustJSON(t, rs), `"open_task_count":0`) {
		t.Fatalf("open_task_count must always be sent: %s", mustJSON(t, rs))
	}

	rec = httptest.NewRecorder()
	s.handleAllResources(rec, httptest.NewRequest(http.MethodGet, "/api/all-resources", nil))
	var all []allResourceDTO
	json.NewDecoder(rec.Body).Decode(&all)
	counts = map[string]int{}
	for _, r := range all {
		counts[r.ID] = r.OpenTaskCount
	}
	if len(all) != 2 || counts["o/r#1"] != 1 || counts["o/r#2"] != 0 {
		t.Fatalf("all resources = %+v", all)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
