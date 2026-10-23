package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
)

func decodeDetail(t *testing.T, rec *httptest.ResponseRecorder) taskDetailDTO {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var d taskDetailDTO
	if err := json.NewDecoder(rec.Body).Decode(&d); err != nil {
		t.Fatal(err)
	}
	return d
}

func getDetail(t *testing.T, s *Server, id int64) taskDetailDTO {
	t.Helper()
	return decodeDetail(t, serveTasks(t, s, http.MethodGet, "/api/tasks/detail?id="+strconv.FormatInt(id, 10), nil))
}

func getActivity(t *testing.T, s *Server, id int64, query string) []TimelineEvent {
	t.Helper()
	rec := serveTasks(t, s, http.MethodGet, "/api/tasks/activity?id="+strconv.FormatInt(id, 10)+"&"+query, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("activity %s = %d: %s", query, rec.Code, rec.Body.String())
	}
	var out []TimelineEvent
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func mustTask(t *testing.T, s *Server, n tasks.NewTask) tasks.Task {
	t.Helper()
	tk, err := tasks.Create(s.DB, webUser, n)
	if err != nil {
		t.Fatal(err)
	}
	return tk
}

func resLink(typ, id string) tasks.LinkTarget {
	return tasks.LinkTarget{Kind: tasks.LinkResource, ResourceType: typ, ResourceID: id}
}

func TestTaskDetailIncludesTitlesImplicitAndSubtasks(t *testing.T) {
	s, wt := tasksServer(t)
	must(t, resources.Add(s.DB, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "https://github.com/o/r/pull/1"}))
	must(t, watcherdb.SetResourceMeta(s.DB, watcher.Resource{Type: "pr", ID: "o/r#1"}, "My PR", ""))
	must(t, watcherdb.UpsertResourceState(s.DB, "jira", "X-1", `{"summary":"Fix the thing"}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
	tk := mustTask(t, s, tasks.NewTask{Title: "t", Focus: []tasks.LinkTarget{
		resLink("pr", "o/r#1"), resLink("jira", "X-1"), resLink("pr", "o/r#7"),
		{Kind: tasks.LinkWorktree, Worktree: wt},
	}})
	if _, err := tasks.AddSubtask(s.DB, webUser, tk.ID, "sub"); err != nil {
		t.Fatal(err)
	}

	d := getDetail(t, s, tk.ID)
	if d.Title != "t" || d.Ref != "T1" || len(d.Links) != 4 || len(d.DetailLinks) != 4 {
		t.Fatalf("detail = %+v", d)
	}
	wantTitles := []string{"My PR", "Fix the thing", "#7", "b"}
	for i, w := range wantTitles {
		if d.DetailLinks[i].Title != w {
			t.Errorf("link %d title = %q, want %q", i, d.DetailLinks[i].Title, w)
		}
	}
	if d.DetailLinks[0].URL != "https://github.com/o/r/pull/1" || d.DetailLinks[2].URL != "https://github.com/o/r/pull/7" {
		t.Errorf("urls = %q, %q", d.DetailLinks[0].URL, d.DetailLinks[2].URL)
	}
	if d.DetailLinks[0].ResourceType != "pr" || !d.DetailLinks[0].Focus {
		t.Errorf("embedded link = %+v", d.DetailLinks[0].taskLinkDTO)
	}
	if len(d.ImplicitVia) != 1 || d.ImplicitVia[0].Worktree != wdbCanon(wt) || d.ImplicitVia[0].Branch != "b" ||
		len(d.ImplicitVia[0].Via) != 1 || d.ImplicitVia[0].Via[0] != "pr:o/r#1" {
		t.Errorf("implicit = %+v", d.ImplicitVia)
	}
	if len(d.Subtasks) != 1 || d.Subtasks[0].Text != "sub" || d.Subtasks[0].Checked || d.SubtasksTotal != 1 {
		t.Errorf("subtasks = %+v", d.Subtasks)
	}
	if d.EventLinks == nil {
		t.Errorf("event_links must marshal as [], got nil")
	}
}

func TestTaskDetailErrors(t *testing.T) {
	s, _ := tasksServer(t)
	if rec := serveTasks(t, s, http.MethodGet, "/api/tasks/detail?id=42", nil); rec.Code != http.StatusNotFound {
		t.Errorf("missing = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodGet, "/api/tasks/detail?id=x", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("bad id = %d", rec.Code)
	}
	tk := mustTask(t, s, tasks.NewTask{Title: "t"})
	// Focus on a link the task doesn't have is ErrLinkNotFound → 404.
	rec := serveTasks(t, s, http.MethodPost, "/api/tasks/links/focus",
		map[string]any{"id": tk.ID, "kind": "resource", "type": "pr", "rid": "o/r#1", "focus": true})
	if rec.Code != http.StatusNotFound {
		t.Errorf("focus missing link = %d %s", rec.Code, rec.Body.String())
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/links/remove",
		map[string]any{"id": tk.ID, "kind": "bogus"}); rec.Code != http.StatusBadRequest {
		t.Errorf("bad kind = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/subtasks/edit",
		map[string]any{"subtask_id": 99, "text": "x"}); rec.Code != http.StatusNotFound {
		t.Errorf("missing subtask = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/subtasks/add",
		map[string]any{"id": tk.ID, "text": "  "}); rec.Code != http.StatusBadRequest {
		t.Errorf("empty subtask = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/events/unlink",
		map[string]any{"id": tk.ID, "key": "ev:nope"}); rec.Code != http.StatusNotFound {
		t.Errorf("unlink missing = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodGet, "/api/tasks/activity?id="+strconv.FormatInt(tk.ID, 10)+"&filter=bogus", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("bad filter = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodGet, "/api/tasks/activity?id=42", nil); rec.Code != http.StatusNotFound {
		t.Errorf("activity missing = %d", rec.Code)
	}
}

func TestTaskDetailEditRoutes(t *testing.T) {
	s, wt := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "t"})
	id := tk.ID

	desc := "## notes"
	got := decodeTask(t, serveTasks(t, s, http.MethodPost, "/api/tasks/update", map[string]any{"id": id, "description": desc}))
	if got.Description != desc {
		t.Fatalf("description = %q", got.Description)
	}

	d := decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/links/add", map[string]any{"id": id, "path": wt}))
	if len(d.DetailLinks) != 1 || d.DetailLinks[0].Kind != "worktree" || d.DetailLinks[0].Focus {
		t.Fatalf("add path = %+v", d.DetailLinks)
	}
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/links/add", map[string]any{"id": id, "type": "jira", "rid": "X-1", "focus": true}))
	if len(d.Links) != 2 || d.Links[0].ResourceID != "X-1" || !d.Links[0].Focus {
		t.Fatalf("add type+rid = %+v", d.Links)
	}
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/links/focus", map[string]any{"id": id, "kind": "worktree", "path": wt, "focus": true}))
	if !d.Links[1].Focus {
		t.Fatalf("focus = %+v", d.Links)
	}
	wtTarget := map[string]any{"kind": "worktree", "path": wt}
	jiraTarget := map[string]any{"kind": "resource", "type": "jira", "rid": "X-1"}
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/links/order",
		map[string]any{"id": id, "focus": []any{wtTarget}, "related": []any{jiraTarget}}))
	if d.Links[0].Kind != "worktree" || !d.Links[0].Focus || d.Links[1].ResourceID != "X-1" || d.Links[1].Focus {
		t.Fatalf("order = %+v", d.Links)
	}
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/links/remove", map[string]any{"id": id, "kind": "resource", "type": "jira", "rid": "X-1"}))
	if len(d.Links) != 1 {
		t.Fatalf("remove = %+v", d.Links)
	}

	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/subtasks/add", map[string]any{"id": id, "text": "a"}))
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/subtasks/add", map[string]any{"id": id, "text": "b"}))
	a, b := d.Subtasks[0].ID, d.Subtasks[1].ID
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/subtasks/edit", map[string]any{"subtask_id": a, "text": "A"}))
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/subtasks/check", map[string]any{"subtask_id": b, "checked": true}))
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/subtasks/order", map[string]any{"id": id, "ids": []int64{b, a}}))
	if len(d.Subtasks) != 2 || d.Subtasks[0].ID != b || !d.Subtasks[0].Checked || d.Subtasks[1].Text != "A" || d.SubtasksDone != 1 {
		t.Fatalf("subtasks = %+v", d.Subtasks)
	}
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/subtasks/remove", map[string]any{"subtask_id": a}))
	if len(d.Subtasks) != 1 {
		t.Fatalf("after remove = %+v", d.Subtasks)
	}

	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/delete", map[string]any{"id": id}); rec.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body.String())
	}
	if rec := serveTasks(t, s, http.MethodGet, "/api/tasks/detail?id="+strconv.FormatInt(id, 10), nil); rec.Code != http.StatusNotFound {
		t.Fatalf("detail after delete = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/delete", map[string]any{"id": id}); rec.Code != http.StatusNotFound {
		t.Fatalf("second delete = %d", rec.Code)
	}
}

func TestTaskDetailLinksAddByURL(t *testing.T) {
	s, wt := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "t"})
	d := decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/links/add",
		map[string]any{"id": tk.ID, "url": "https://github.com/o/r/pull/99"}))
	if len(d.DetailLinks) != 1 {
		t.Fatalf("links = %+v", d.DetailLinks)
	}
	l := d.DetailLinks[0]
	if l.ResourceType != "pr" || l.ResourceID != "o/r#99" || !l.Archived || l.Title != "#99" || l.URL != "https://github.com/o/r/pull/99" {
		t.Fatalf("link = %+v", l)
	}
	for name, body := range map[string]map[string]any{
		"not a url":      {"id": tk.ID, "url": "not a url"},
		"url and path":   {"id": tk.ID, "url": "https://github.com/o/r/pull/1", "path": wt},
		"nothing":        {"id": tk.ID},
		"type, no rid":   {"id": tk.ID, "type": "pr"},
		"type and path":  {"id": tk.ID, "type": "pr", "rid": "o/r#1", "path": wt},
		"unknown scheme": {"id": tk.ID, "url": "ftp://example.com/x"},
	} {
		if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/links/add", body); rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d %s", name, rec.Code, rec.Body.String())
		}
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/links/add", map[string]any{"id": 99, "path": wt}); rec.Code != http.StatusNotFound {
		t.Errorf("missing task = %d", rec.Code)
	}
}

func TestEventLinkRendersFromSnapshot(t *testing.T) {
	s, _ := tasksServer(t)
	insertEvent(t, s.DB, "e1", "2026-01-01T00:00:00Z", "github", "pr_comment", "Real title", "pr", "o/r#1", "https://github.com/o/r/pull/1")
	tk := mustTask(t, s, tasks.NewTask{Title: "t", Focus: []tasks.LinkTarget{resLink("pr", "o/r#1")}})

	// The client's snapshot is ignored for ev: keys.
	d := decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/events/link",
		map[string]any{"id": tk.ID, "key": "ev:e1", "snapshot": map[string]any{"title": "forged"}}))
	if len(d.EventLinks) != 1 {
		t.Fatalf("event links = %+v", d.EventLinks)
	}
	el := d.EventLinks[0]
	if el.Key != "ev:e1" || el.Snapshot.Title != "Real title" || el.Snapshot.Type != "pr_comment" ||
		el.Snapshot.ResourceType != "pr" || el.Snapshot.ResourceID != "o/r#1" || el.Snapshot.URL != "https://github.com/o/r/pull/1" {
		t.Fatalf("snapshot = %+v", el.Snapshot)
	}
	if el.Live == nil || el.Live.ID != "e1" {
		t.Fatalf("live = %+v", el.Live)
	}

	if _, err := s.DB.Exec(`DELETE FROM watcher_events WHERE id = 'e1'`); err != nil {
		t.Fatal(err)
	}
	d = getDetail(t, s, tk.ID)
	if len(d.EventLinks) != 1 || d.EventLinks[0].Live != nil || d.EventLinks[0].Snapshot.Title != "Real title" {
		t.Fatalf("after delete = %+v", d.EventLinks)
	}

	// A missing ev: event is 404; a slack: key needs a title or body.
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/events/link",
		map[string]any{"id": tk.ID, "key": "ev:gone"}); rec.Code != http.StatusNotFound {
		t.Errorf("missing event = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/events/link",
		map[string]any{"id": tk.ID, "key": "slack:C1:1.2", "snapshot": map[string]any{"author": "x"}}); rec.Code != http.StatusBadRequest {
		t.Errorf("empty slack snapshot = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/events/link",
		map[string]any{"id": tk.ID, "key": "bogus:1", "snapshot": map[string]any{"title": "x"}}); rec.Code != http.StatusBadRequest {
		t.Errorf("bad key = %d", rec.Code)
	}
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/events/link",
		map[string]any{"id": tk.ID, "key": "slack:C1:1.2", "snapshot": map[string]any{"title": "hi", "body": "hello", "source": "slack",
			"resource_type": "slack", "resource_id": "C1:1.0"}}))
	if len(d.EventLinks) != 2 || d.EventLinks[1].Snapshot.Body != "hello" {
		t.Fatalf("slack link = %+v", d.EventLinks)
	}
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/events/unlink", map[string]any{"id": tk.ID, "key": "ev:e1"}))
	if len(d.EventLinks) != 1 || d.EventLinks[0].Key != "slack:C1:1.2" {
		t.Fatalf("after unlink = %+v", d.EventLinks)
	}
}

func TestTaskActivityFilters(t *testing.T) {
	s, _ := tasksServer(t)
	insertEvent(t, s.DB, "e1", "2026-01-01T00:00:01Z", "github", "pr_comment", "pr one", "pr", "o/r#1", "u1")
	insertEvent(t, s.DB, "e2", "2026-01-01T00:00:02Z", "jira", "jira_comment", "jira one", "jira", "X-1", "u2")
	insertEvent(t, s.DB, "e3", "2026-01-01T00:00:03Z", "github", "pr_comment", "unrelated", "pr", "o/r#9", "u9")
	tk := mustTask(t, s, tasks.NewTask{Title: "t", Focus: []tasks.LinkTarget{resLink("pr", "o/r#1"), resLink("jira", "X-1")}})
	must(t, tasks.LinkEvent(s.DB, webUser, tk.ID, "ev:e1", tasks.EventSnapshot{Title: "pr one", Type: "pr_comment"}))

	ids := func(evs []TimelineEvent) string {
		var out []string
		for _, e := range evs {
			out = append(out, e.ID)
		}
		return strings.Join(out, ",")
	}

	all := getActivity(t, s, tk.ID, "filter=all")
	// Task events are stamped now, so they sort before the 2026-01-01 events.
	if n := len(all); n < 3 || !strings.HasSuffix(ids(all), "e2,e1") || strings.Contains(ids(all), "e3") {
		t.Fatalf("all = %s", ids(all))
	}
	for i := 1; i < len(all); i++ {
		if all[i-1].TS < all[i].TS {
			t.Fatalf("not newest first: %s", ids(all))
		}
	}
	for _, e := range all {
		switch e.ID {
		case "e1":
			if !e.LinkedToTask || e.ResourceType != "pr" {
				t.Errorf("e1 = %+v", e)
			}
		case "e2":
			if e.LinkedToTask {
				t.Errorf("e2 linked")
			}
		default:
			if e.Source != "tasks" || e.ResourceType != "task" || e.ResourceID != strconv.FormatInt(tk.ID, 10) || !strings.HasPrefix(e.ID, "task:") {
				t.Errorf("task event = %+v", e)
			}
		}
	}
	if got := getActivity(t, s, tk.ID, ""); ids(got) != ids(all) {
		t.Errorf("default filter = %s", ids(got))
	}

	own := getActivity(t, s, tk.ID, "filter=task")
	if len(own) == 0 {
		t.Fatal("no task events")
	}
	for _, e := range own {
		if e.Source != "tasks" {
			t.Errorf("task filter has %+v", e)
		}
	}
	if got := ids(getActivity(t, s, tk.ID, "filter=linked")); got != "e1" {
		t.Errorf("linked = %s", got)
	}
	if got := ids(getActivity(t, s, tk.ID, "filter=resource&type=jira&rid=X-1")); got != "e2" {
		t.Errorf("resource = %s", got)
	}
	if rec := serveTasks(t, s, http.MethodGet, "/api/tasks/activity?id="+strconv.FormatInt(tk.ID, 10)+"&filter=resource", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("resource without type = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodGet, "/api/tasks/activity?id="+strconv.FormatInt(tk.ID, 10)+"&filter=resource&type=pr&rid=o/r%239", nil); rec.Code != http.StatusNotFound {
		t.Errorf("resource not linked = %d", rec.Code)
	}
}

func TestTaskActivityLinkedToTaskSlackKey(t *testing.T) {
	s, _ := tasksServer(t)
	insertEvent(t, s.DB, "s1", "2026-01-01T00:00:01Z", "slack", "slack_reply", "reply", "slack", "C1:100.1", "")
	if _, err := s.DB.Exec(`UPDATE watcher_events SET external_ts = '100.5' WHERE id = 's1'`); err != nil {
		t.Fatal(err)
	}
	tk := mustTask(t, s, tasks.NewTask{Title: "t", Focus: []tasks.LinkTarget{resLink("slack", "C1:100.1")}})
	must(t, tasks.LinkEvent(s.DB, webUser, tk.ID, "slack:C1:100.5", tasks.EventSnapshot{Title: "reply"}))
	evs := getActivity(t, s, tk.ID, "filter=resource&type=slack&rid=C1:100.1")
	if len(evs) != 1 || !evs[0].LinkedToTask {
		t.Fatalf("slack message linked by its slack: key = %+v", evs)
	}
}

// Only a Slack reply is a Slack message with a canonical slack: key; a
// bookkeeping event on the thread (watch_started) carries an external_ts too
// but must keep its ev: key.
func TestSlackKeyOfOnlyReplies(t *testing.T) {
	reply := TimelineEvent{Type: "slack_reply", ResourceType: "slack", ResourceID: "C1:100.1", ExternalTS: "100.5"}
	if got := slackKeyOf(reply); got != "slack:C1:100.5" {
		t.Errorf("reply key = %q", got)
	}
	for _, typ := range []string{"watch_started", "watcher_error", "slack_thread_resolved"} {
		ev := reply
		ev.Type = typ
		if got := slackKeyOf(ev); got != "" {
			t.Errorf("%s key = %q, want none", typ, got)
		}
	}
}

func TestFromEvent(t *testing.T) {
	s, wt := tasksServer(t)
	insertEvent(t, s.DB, "e1", "2026-01-01T00:00:00Z", "github", "pr_comment", "Review requested", "pr", "o/r#1", "https://github.com/o/r/pull/1")

	d := decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/from-event", map[string]any{"key": "ev:e1"}))
	if d.Title != "Review requested" || len(d.Links) != 1 || d.Links[0].ResourceID != "o/r#1" || !d.Links[0].Focus {
		t.Fatalf("from ev = %+v", d)
	}
	if len(d.EventLinks) != 1 || d.EventLinks[0].Key != "ev:e1" || d.EventLinks[0].Live == nil {
		t.Fatalf("event links = %+v", d.EventLinks)
	}

	long := strings.Repeat("x", 200)
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/from-event", map[string]any{
		"key": "slack:C1:5.5",
		"snapshot": map[string]any{
			"source": "slack", "title": "New reply", "body": "  first line  \nsecond",
			"resource_type": "slack", "resource_id": "C1:5.0",
		},
	}))
	if d.Title != "first line" || len(d.Links) != 1 || d.Links[0].ResourceType != "slack" || d.Links[0].ResourceID != "C1:5.0" {
		t.Fatalf("from slack = %+v", d)
	}
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/from-event", map[string]any{
		"key": "slack:C1:6.6", "snapshot": map[string]any{"source": "slack", "body": long, "resource_type": "slack", "resource_id": "C1:5.0"},
	}))
	if len([]rune(d.Title)) != 120 {
		t.Fatalf("long title = %d runes", len([]rune(d.Title)))
	}

	// path adds a Focus worktree link when that worktree doesn't follow the
	// event's resource (here: nothing follows o/r#1).
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/from-event", map[string]any{"key": "ev:e1", "path": wt}))
	if len(d.Links) != 2 || d.Links[1].Kind != "worktree" || !d.Links[1].Focus {
		t.Fatalf("with path = %+v", d.Links)
	}
	must(t, resources.Add(s.DB, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}))
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/from-event", map[string]any{"key": "ev:e1", "path": wt}))
	if len(d.Links) != 1 {
		t.Fatalf("path that follows the resource is implicit, links = %+v", d.Links)
	}

	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/from-event", map[string]any{"key": "ev:nope"}); rec.Code != http.StatusNotFound {
		t.Errorf("missing event = %d", rec.Code)
	}
	if rec := serveTasks(t, s, http.MethodPost, "/api/tasks/from-event", map[string]any{"key": "slack:C1:1"}); rec.Code != http.StatusBadRequest {
		t.Errorf("slack without snapshot = %d", rec.Code)
	}
}

func TestTaskDetailTimelineTitles(t *testing.T) {
	tk := tasks.Task{ID: 3, Title: "Ship it"}
	cases := []struct {
		typ, payload, actor, session, want string
	}{
		{tasks.EventTaskCreated, `{}`, tasks.ActorUser, "", "Created “Ship it”"},
		{tasks.EventTaskEdited, `{"changes":{"title":{"from":"a","to":"Ship it"}}}`, tasks.ActorUser, "", "Renamed “a” to “Ship it”"},
		{tasks.EventTaskEdited, `{"changes":{"priority":{"from":"none","to":"high"},"starred":{"from":false,"to":true}}}`, tasks.ActorUser, "", "Set priority to high; starred"},
		{tasks.EventTaskEdited, `{"changes":{"due":{"from":"2026-01-01","to":""},"description":{"from":"","to":"x"}}}`, tasks.ActorUser, "", "Edited the description; cleared the due date"},
		{tasks.EventTaskStateChanged, `{"from":"not_started","to":"in_progress"}`, tasks.ActorAgent, "s1", "Started “Ship it”"},
		{tasks.EventTaskStateChanged, `{"from":"in_progress","to":"done"}`, tasks.ActorUser, "", "Completed “Ship it”"},
		{tasks.EventTaskStateChanged, `{"from":"done","to":"not_started"}`, tasks.ActorUser, "", "Reopened “Ship it”"},
		{tasks.EventTaskDeleted, `{}`, tasks.ActorUser, "", "Deleted “Ship it”"},
		{tasks.EventTaskLinked, `{"kind":"resource","resource_type":"pr","resource_id":"o/r#4521","focus":true}`, tasks.ActorUser, "", "Linked #4521"},
		{tasks.EventTaskUnlinked, `{"kind":"worktree","worktree":"/x/y/feature"}`, tasks.ActorUser, "", "Unlinked worktree feature"},
		{tasks.EventTaskFocusChanged, `{"kind":"resource","resource_type":"jira","resource_id":"X-1","focus":false}`, tasks.ActorUser, "", "Moved X-1 to Related"},
		{tasks.EventSubtaskAdded, `{"subtask_id":1,"text":"a"}`, tasks.ActorUser, "", "Added subtask “a”"},
		{tasks.EventSubtaskEdited, `{"subtask_id":1,"text":"a"}`, tasks.ActorUser, "", "Edited subtask “a”"},
		{tasks.EventSubtaskChecked, `{"subtask_id":1,"text":"a"}`, tasks.ActorUser, "", "Checked “a”"},
		{tasks.EventSubtaskUnchecked, `{"subtask_id":1,"text":"a"}`, tasks.ActorUser, "", "Unchecked “a”"},
		{tasks.EventSubtaskRemoved, `{"subtask_id":1,"text":"a"}`, tasks.ActorUser, "", "Removed subtask “a”"},
		{tasks.EventTaskEventLinked, `{"key":"ev:1","title":"CI failed"}`, tasks.ActorUser, "", "Linked event “CI failed”"},
		{tasks.EventTaskEventUnlinked, `{"key":"ev:1","title":"CI failed"}`, tasks.ActorUser, "", "Unlinked event “CI failed”"},
		{"something_new", `{}`, tasks.ActorUser, "", "something_new"},
	}
	for _, c := range cases {
		te := taskEventToTimeline(tasks.Event{ID: 9, TaskID: 3, TS: "2026-01-01T00:00:00Z", Type: c.typ,
			Actor: c.actor, ActorSession: c.session, Payload: json.RawMessage(c.payload)}, tk)
		if te.Title != c.want {
			t.Errorf("%s %s: title %q, want %q", c.typ, c.payload, te.Title, c.want)
		}
		if te.ID != "task:9" || te.Source != "tasks" || te.Type != c.typ || te.ResourceType != "task" ||
			te.ResourceID != "3" || te.ResourceTitle != "Ship it" || te.TS != "2026-01-01T00:00:00Z" {
			t.Errorf("%s: fields = %+v", c.typ, te)
		}
		wantAuthor := "you"
		if c.actor == tasks.ActorAgent {
			wantAuthor = "agent (s1)"
		}
		if te.Author != wantAuthor {
			t.Errorf("%s: author %q", c.typ, te.Author)
		}
		if te.Worktrees == nil || te.WorktreePaths == nil {
			t.Errorf("%s: worktree slices must be non-nil", c.typ)
		}
	}
	if a := taskEventToTimeline(tasks.Event{Type: tasks.EventTaskCreated, Actor: tasks.ActorAgent, Payload: json.RawMessage(`{}`)}, tk).Author; a != "agent" {
		t.Errorf("sessionless agent = %q", a)
	}
}
