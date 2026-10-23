package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	watcher "github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
)

func addBlockerReq(t *testing.T, s *Server, body map[string]any) taskDetailDTO {
	t.Helper()
	return decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/blockers/add", body))
}

func blockerByKind(t *testing.T, d taskDetailDTO, label string) taskBlockerDTO {
	t.Helper()
	for _, b := range d.Blockers {
		if b.Label == label {
			return b
		}
	}
	t.Fatalf("no blocker labelled %q in %+v", label, d.Blockers)
	return taskBlockerDTO{}
}

func TestBlockerRoutesAndDetailFields(t *testing.T) {
	s, _ := tasksServer(t)
	dep := mustTask(t, s, tasks.NewTask{Title: "dep"})
	tk := mustTask(t, s, tasks.NewTask{Title: "main"})
	setPRState(t, s, "o/r#4498", "OPEN")
	must(t, watcherdb.UpsertResourceState(s.DB, "jira", "X-1", `{"summary":"Jira thing","status":"In Progress"}`, "2026-01-01T00:00:00Z", "x"))
	must(t, watcherdb.SetResourceMeta(s.DB, watcher.Resource{Type: "slack", ID: "C1:1.2"}, "Thread name", ""))

	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "task", "task_id": dep.ID})
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "resource", "url": "https://github.com/o/r/pull/4498"})
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "resource", "type": "jira", "rid": "X-1"})
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "resource", "type": "slack", "rid": "C1:1.2"})
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "resource", "type": "pr", "rid": "o/r#7"})
	d := addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "other", "text": "legal sign-off"})

	if !d.Blocked || d.BlockerCount != 6 || len(d.Blockers) != 6 {
		t.Fatalf("blocked=%v count=%d blockers=%+v", d.Blocked, d.BlockerCount, d.Blockers)
	}
	tb := blockerByKind(t, d, "T1 dep")
	if tb.Kind != "task" || tb.TaskID != dep.ID || tb.StatusLabel != "not_started" || tb.ManualResolvable || tb.Resolved {
		t.Errorf("task blocker = %+v", tb)
	}
	pr := blockerByKind(t, d, "T") // the PR's cached title
	if pr.ResourceType != "pr" || pr.ResourceID != "o/r#4498" || pr.StatusLabel != "open" ||
		pr.URL != "https://github.com/o/r/pull/4498" || pr.ManualResolvable {
		t.Errorf("pr blocker = %+v", pr)
	}
	if j := blockerByKind(t, d, "Jira thing"); j.StatusLabel != "In Progress" || j.ManualResolvable {
		t.Errorf("jira blocker = %+v", j)
	}
	if sl := blockerByKind(t, d, "Thread name"); sl.StatusLabel != "" || !sl.ManualResolvable {
		t.Errorf("slack blocker = %+v", sl)
	}
	if bare := blockerByKind(t, d, "#7"); bare.StatusLabel != "" {
		t.Errorf("never-polled pr blocker = %+v", bare)
	}
	other := blockerByKind(t, d, "legal sign-off")
	if other.Kind != "other" || other.Text != "legal sign-off" || !other.ManualResolvable || other.StatusLabel != "" {
		t.Errorf("other blocker = %+v", other)
	}

	// Manual resolve of "other".
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/blockers/resolve",
		map[string]any{"blocker_id": other.ID, "resolved": true}))
	other = blockerByKind(t, d, "legal sign-off")
	if !other.Resolved || other.ResolvedAuto || other.StatusLabel != "resolved" || d.BlockerCount != 5 {
		t.Errorf("resolved other = %+v (count %d)", other, d.BlockerCount)
	}
	// A PR blocker is not resolved by hand.
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/blockers/resolve",
		map[string]any{"blocker_id": pr.ID, "resolved": true}); rec.Code != http.StatusBadRequest {
		t.Errorf("resolve pr = %d %s", rec.Code, rec.Body.String())
	}

	// Remove.
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/blockers/remove",
		map[string]any{"blocker_id": other.ID}))
	if len(d.Blockers) != 5 {
		t.Errorf("after remove = %+v", d.Blockers)
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/blockers/remove",
		map[string]any{"blocker_id": other.ID}); rec.Code != http.StatusNotFound {
		t.Errorf("remove missing = %d", rec.Code)
	}

	// The blocking task lists what it blocks; one blocking nothing sends [].
	dd := getDetail(t, s, dep.ID)
	if len(dd.Blocks) != 1 || dd.Blocks[0] != (taskBlocksDTO{ID: tk.ID, Ref: "T2", Title: "main", State: "not_started"}) {
		t.Errorf("blocks = %+v", dd.Blocks)
	}
	if !strings.Contains(mustJSON(t, dd), `"blockers":[]`) || !strings.Contains(mustJSON(t, d), `"blocks":[]`) {
		t.Errorf("blockers/blocks must marshal as []")
	}
}

func TestAddBlockerResolvesAtOnceWhenSatisfied(t *testing.T) {
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "main"})
	setPRState(t, s, "o/r#1", "MERGED")
	d := addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "resource", "type": "pr", "rid": "o/r#1"})
	if len(d.Blockers) != 1 {
		t.Fatalf("blockers = %+v", d.Blockers)
	}
	b := d.Blockers[0]
	if !b.Resolved || !b.ResolvedAuto || b.ResolvedReason != "merged" || b.StatusLabel != "merged" || d.Blocked {
		t.Errorf("blocker = %+v, blocked=%v", b, d.Blocked)
	}
}

func TestAddBlockerRequestErrors(t *testing.T) {
	s, _ := tasksServer(t)
	a := mustTask(t, s, tasks.NewTask{Title: "a"})
	b := mustTask(t, s, tasks.NewTask{Title: "b"})
	addBlockerReq(t, s, map[string]any{"id": a.ID, "kind": "task", "task_id": b.ID})

	rec := serveTasks(t, s, http.MethodPost, "/api/tasks/blockers/add", map[string]any{"id": b.ID, "kind": "task", "task_id": a.ID})
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "would create a blocking cycle") {
		t.Errorf("cycle = %d %s", rec.Code, rec.Body.String())
	}
	for name, body := range map[string]map[string]any{
		"url and type":    {"id": a.ID, "kind": "resource", "url": "https://github.com/o/r/pull/1", "type": "pr", "rid": "o/r#1"},
		"bad url":         {"id": a.ID, "kind": "resource", "url": "not a url"},
		"no target":       {"id": a.ID, "kind": "resource"},
		"bad kind":        {"id": a.ID, "kind": "nope"},
		"empty other":     {"id": a.ID, "kind": "other", "text": "  "},
		"url on task":     {"id": a.ID, "kind": "task", "task_id": b.ID, "url": "https://github.com/o/r/pull/1"},
		"missing blocker": {"id": a.ID, "kind": "task", "task_id": 999},
	} {
		if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/blockers/add", body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body.String())
		}
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/blockers/add",
		map[string]any{"id": 999, "kind": "other", "text": "x"}); rec.Code != http.StatusNotFound {
		t.Errorf("missing task = %d", rec.Code)
	}
}

func TestTaskListCarriesBlockedFields(t *testing.T) {
	s, _ := tasksServer(t)
	dep := mustTask(t, s, tasks.NewTask{Title: "dep"})
	tk := mustTask(t, s, tasks.NewTask{Title: "main"})
	must(t, watcherdb.UpsertResourceState(s.DB, "jira", "X-1", `{"summary":"Jira thing"}`, "2026-01-01T00:00:00Z", "x"))
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "task", "task_id": dep.ID})
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "resource", "type": "jira", "rid": "X-1"})
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "resource", "type": "pr", "rid": "o/r#4498"})
	d := addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "other", "text": "done already"})
	other := blockerByKind(t, d, "done already")
	serveTasks(t, s, http.MethodPost, "/api/tasks/blockers/resolve", map[string]any{"blocker_id": other.ID, "resolved": true})

	rec := serveTasks(t, s, http.MethodGet, "/api/tasks", nil)
	body := rec.Body.String()
	var out []taskDTO
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	byID := map[int64]taskDTO{}
	for _, d := range out {
		byID[d.ID] = d
	}
	got := byID[tk.ID]
	want := []string{"T1 dep", "Jira thing", "#4498"}
	if !got.Blocked || got.BlockerCount != 3 || strings.Join(got.BlockerLabels, "|") != strings.Join(want, "|") {
		t.Errorf("main = blocked %v count %d labels %q", got.Blocked, got.BlockerCount, got.BlockerLabels)
	}
	if byID[dep.ID].Blocked || byID[dep.ID].BlockerLabels == nil {
		t.Errorf("dep = %+v", byID[dep.ID])
	}
	if !strings.Contains(body, `"blocker_labels":[]`) || !strings.Contains(body, `"blocker_count":0`) {
		t.Errorf("blocker_labels/blocker_count must always be sent: %s", body)
	}
	// The single-task endpoints carry them too.
	if d := getDetail(t, s, tk.ID); len(d.BlockerLabels) != 3 {
		t.Errorf("detail labels = %q", d.BlockerLabels)
	}
}

func TestResourceDTOsCarryBlocksCount(t *testing.T) {
	s, x := tasksServer(t)
	must(t, resources.Add(s.DB, x, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	must(t, resources.Add(s.DB, x, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u2"}))
	for _, title := range []string{"a", "b"} {
		tk := mustTask(t, s, tasks.NewTask{Title: title})
		addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "resource", "type": "pr", "rid": "o/r#1"})
	}

	rec := httptest.NewRecorder()
	s.handleWorktreeResources(rec, httptest.NewRequest(http.MethodGet, "/api/worktree-resources?path="+url.QueryEscape(x), nil))
	var rs []resourceDTO
	json.NewDecoder(rec.Body).Decode(&rs)
	counts := map[string]int{}
	for _, r := range rs {
		counts[r.ID] = r.BlocksCount
	}
	if counts["o/r#1"] != 2 || counts["o/r#2"] != 0 {
		t.Errorf("worktree resources = %+v", counts)
	}
	if !strings.Contains(mustJSON(t, rs), `"blocks_count":0`) {
		t.Errorf("blocks_count must always be sent: %s", mustJSON(t, rs))
	}

	rec = httptest.NewRecorder()
	s.handleAllResources(rec, httptest.NewRequest(http.MethodGet, "/api/all-resources", nil))
	var all []allResourceDTO
	json.NewDecoder(rec.Body).Decode(&all)
	counts = map[string]int{}
	for _, r := range all {
		counts[r.ID] = r.BlocksCount
	}
	if counts["o/r#1"] != 2 || counts["o/r#2"] != 0 {
		t.Errorf("all resources = %+v", counts)
	}
}

func TestBlockerEventTitles(t *testing.T) {
	tk := tasks.Task{ID: 1, Title: "main"}
	for _, c := range []struct {
		typ, actor, payload, want string
	}{
		{tasks.EventTaskBlockerAdded, "user", `{"blocker_id":1,"kind":"task","label":"T2 dep"}`, "Blocked by T2 dep"},
		{tasks.EventTaskBlockerAdded, "user", `{"blocker_id":1,"kind":"resource","label":"pr:o/r#4498"}`, "Blocked by #4498"},
		{tasks.EventTaskBlockerAdded, "user", `{"blocker_id":1,"kind":"other","label":"legal"}`, "Blocked by “legal”"},
		{tasks.EventTaskBlockerRemoved, "user", `{"blocker_id":1,"kind":"resource","label":"jira:X-1"}`, "Removed blocker X-1"},
		{tasks.EventTaskBlockerResolved, "system", `{"blocker_id":1,"kind":"resource","label":"pr:o/r#4498","auto":true,"reason":"merged"}`, "Unblocked: #4498 merged"},
		{tasks.EventTaskBlockerResolved, "system", `{"blocker_id":1,"kind":"task","label":"T2 dep","auto":true,"reason":"done"}`, "Unblocked: T2 dep is done"},
		{tasks.EventTaskBlockerResolved, "user", `{"blocker_id":1,"kind":"other","label":"legal","auto":false,"reason":""}`, "Resolved blocker “legal”"},
		{tasks.EventTaskBlockerUnresolved, "system", `{"blocker_id":1,"kind":"resource","label":"pr:o/r#4498"}`, "Blocked again by #4498"},
	} {
		te := taskEventToTimeline(tasks.Event{ID: 1, Type: c.typ, Actor: c.actor, Payload: json.RawMessage(c.payload)}, tk)
		if te.Title != c.want {
			t.Errorf("%s %s = %q, want %q", c.typ, c.payload, te.Title, c.want)
		}
		if te.TypeLabel == "" {
			t.Errorf("%s has no type label", c.typ)
		}
	}
	sys := taskEventToTimeline(tasks.Event{ID: 1, Type: tasks.EventTaskBlockerResolved, Actor: tasks.ActorSystem, Payload: json.RawMessage(`{}`)}, tk)
	if sys.Author != "worktree" {
		t.Errorf("system author = %q", sys.Author)
	}
}
