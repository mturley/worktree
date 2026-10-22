package webui

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/mturley/worktree/internal/tasks"
)

// insertSlackReply inserts a slack_reply watcher event for message ts ext in
// thread rid ("<channel>:<thread ts>").
func insertSlackReply(t *testing.T, s *Server, id, ts, title, rid, ext, body string) {
	t.Helper()
	insertEvent(t, s.DB, id, ts, "slack", "slack_reply", title, "slack", rid, "https://x.slack.com/archives/"+rid)
	if _, err := s.DB.Exec(`UPDATE watcher_events SET external_ts = ?, body = ? WHERE id = ?`, ext, body, id); err != nil {
		t.Fatal(err)
	}
}

func TestRecentResourceEventsLimitsPerResourceAndSkipsBookkeeping(t *testing.T) {
	s, _ := tasksServer(t)
	for i := 1; i <= 5; i++ {
		insertEvent(t, s.DB, fmt.Sprintf("a%d", i), fmt.Sprintf("2026-01-01T00:00:0%dZ", i), "github", "pr_comment", "a", "pr", "o/r#1", "u")
	}
	insertEvent(t, s.DB, "ws", "2026-01-01T00:00:08Z", "github", "watch_started", "w", "pr", "o/r#1", "u")
	insertEvent(t, s.DB, "we", "2026-01-01T00:00:09Z", "github", "watcher_error", "w", "pr", "o/r#1", "u")
	insertEvent(t, s.DB, "b1", "2026-01-01T00:00:01Z", "jira", "jira_comment", "b", "jira", "X-1", "u")

	evs, err := s.recentResourceEvents("pr", "o/r#1", 3)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, e := range evs {
		ids = append(ids, e.ID)
	}
	if got := strings.Join(ids, ","); got != "a5,a4,a3" {
		t.Fatalf("events = %s, want the 3 newest non-bookkeeping", got)
	}

	tk := mustTask(t, s, tasks.NewTask{Title: "t", Focus: []tasks.LinkTarget{resLink("pr", "o/r#1"), resLink("jira", "X-1")}})
	for _, q := range []string{"filter=all", "filter=resource&type=pr&rid=o/r%231"} {
		for _, e := range getActivity(t, s, tk.ID, q) {
			if e.Type == "watch_started" || e.Type == "watcher_error" {
				t.Errorf("%s includes bookkeeping event %s", q, e.ID)
			}
		}
	}
}

func TestLinkingSlackEvKeyStoresCanonicalSlackKey(t *testing.T) {
	s, _ := tasksServer(t)
	insertSlackReply(t, s, "s1", "2026-01-01T00:00:01Z", "New reply", "C1:100.1", "100.5", "hello")
	tk := mustTask(t, s, tasks.NewTask{Title: "t"})

	// A client snapshot linked first is replaced by the server-built one.
	decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/events/link", map[string]any{
		"id": tk.ID, "key": "slack:C1:100.5",
		"snapshot": map[string]any{"title": "client", "resource_type": "slack", "resource_id": "C1:100.1"},
	}))
	d := decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/events/link", map[string]any{"id": tk.ID, "key": "ev:s1"}))
	if len(d.EventLinks) != 1 {
		t.Fatalf("event links = %+v", d.EventLinks)
	}
	el := d.EventLinks[0]
	if el.Key != "slack:C1:100.5" || el.Snapshot.Body != "hello" || el.Snapshot.Title == "client" ||
		el.Snapshot.ResourceID != "C1:100.1" || el.Snapshot.Type != "slack_reply" {
		t.Fatalf("link = %+v", el)
	}
	if el.Live == nil || el.Live.ID != "s1" {
		t.Fatalf("a slack: key's live event is found by external_ts: %+v", el.Live)
	}

	// from-event canonicalises too.
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/from-event", map[string]any{"key": "ev:s1"}))
	if len(d.EventLinks) != 1 || d.EventLinks[0].Key != "slack:C1:100.5" {
		t.Fatalf("from-event links = %+v", d.EventLinks)
	}

	// A non-Slack ev: key stays as it is.
	insertEvent(t, s.DB, "e1", "2026-01-01T00:00:00Z", "github", "pr_comment", "c", "pr", "o/r#1", "u")
	d = decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/events/link", map[string]any{"id": tk.ID, "key": "ev:e1"}))
	if len(d.EventLinks) != 2 || d.EventLinks[1].Key != "ev:e1" {
		t.Fatalf("ev link = %+v", d.EventLinks)
	}
}

func TestTaskActivityLinkedRendersEveryLink(t *testing.T) {
	s, _ := tasksServer(t)
	insertEvent(t, s.DB, "e1", "2026-01-01T00:00:01Z", "github", "pr_comment", "live", "pr", "o/r#1", "u")
	insertEvent(t, s.DB, "e2", "2026-01-01T00:00:02Z", "github", "pr_comment", "changed", "pr", "o/r#1", "u")
	insertSlackReply(t, s, "s1", "2026-01-01T00:00:03Z", "New reply", "C1:100.1", "100.5", "hi")
	tk := mustTask(t, s, tasks.NewTask{Title: "t"})
	link := func(key string, body map[string]any) {
		t.Helper()
		body["id"], body["key"] = tk.ID, key
		decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/events/link", body))
	}
	link("ev:e1", map[string]any{})
	link("ev:e2", map[string]any{})
	link("slack:C1:100.5", map[string]any{"snapshot": map[string]any{"title": "msg", "resource_type": "slack", "resource_id": "C1:100.1"}})
	link("slack:C9:7.7", map[string]any{"snapshot": map[string]any{"title": "gone msg", "ts": "2026-01-01T00:00:05Z",
		"resource_type": "slack", "resource_id": "C9:7.0"}})
	// A pruned ev: link: its event no longer exists.
	must(t, tasks.LinkEvent(s.DB, webUser, tk.ID, "ev:pruned", tasks.EventSnapshot{Source: "github", Type: "pr_comment",
		Title: "pruned", TS: "2026-01-01T00:00:04Z", ResourceType: "pr", ResourceID: "o/r#1"}))
	// e2's type changed since it was linked: it renders from its snapshot.
	if _, err := s.DB.Exec(`UPDATE watcher_events SET type = 'pr_review' WHERE id = 'e2'`); err != nil {
		t.Fatal(err)
	}

	evs := getActivity(t, s, tk.ID, "filter=linked")
	got := map[string]TimelineEvent{}
	var order []string
	for _, e := range evs {
		got[e.ID] = e
		order = append(order, e.ID)
		if !e.LinkedToTask || e.LinkedKey == "" {
			t.Errorf("%s: linked_to_task=%v linked_key=%q", e.ID, e.LinkedToTask, e.LinkedKey)
		}
	}
	if strings.Join(order, ",") != "slack:C9:7.7,ev:pruned,s1,ev:e2,e1" {
		t.Fatalf("linked rows = %v", order)
	}
	if e := got["s1"]; e.LinkedKey != "slack:C1:100.5" {
		t.Errorf("live slack row = %+v", e)
	}
	if e := got["ev:e2"]; e.Title != "changed" || e.Type != "pr_comment" || e.LinkedKey != "ev:e2" {
		t.Errorf("type-changed row = %+v", e)
	}
	if e := got["ev:pruned"]; e.Title != "pruned" || e.ResourceID != "o/r#1" {
		t.Errorf("pruned row = %+v", e)
	}
	if e := got["slack:C9:7.7"]; e.Title != "gone msg" || e.Source != "slack" || e.Worktrees == nil {
		t.Errorf("slack snapshot row = %+v", e)
	}
	if e := got["e1"]; e.LinkedKey != "ev:e1" {
		t.Errorf("live row = %+v", e)
	}

	d := getDetail(t, s, tk.ID)
	for _, el := range d.EventLinks {
		switch el.Key {
		case "ev:e1":
			if el.Live == nil {
				t.Errorf("ev:e1 has no live event")
			}
		case "slack:C1:100.5":
			if el.Live == nil || el.Live.ID != "s1" {
				t.Errorf("slack link live = %+v", el.Live)
			}
		default:
			if el.Live != nil {
				t.Errorf("%s should render from its snapshot, live = %+v", el.Key, el.Live)
			}
		}
	}
}

func TestSlackSnapshotValidation(t *testing.T) {
	s, _ := tasksServer(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "t"})
	valid := func() map[string]any {
		return map[string]any{"title": "hi", "resource_type": "slack", "resource_id": "C1:100.1",
			"url": "https://x.slack.com/archives/C1/p1005"}
	}
	post := func(path, key string, snap map[string]any) int {
		body := map[string]any{"key": key, "snapshot": snap}
		if path == "/api/tasks/events/link" {
			body["id"] = tk.ID
		}
		return serveTasks(t, s, http.MethodPost, path, body).Code
	}
	with := func(k string, v any) map[string]any {
		m := valid()
		if v == nil {
			delete(m, k)
		} else {
			m[k] = v
		}
		return m
	}
	bad := []struct {
		name, key string
		snap      map[string]any
	}{
		{"no channel or ts", "slack:", valid()},
		{"no ts", "slack:C1", valid()},
		{"empty channel", "slack::100.5", valid()},
		{"empty ts", "slack:C1:", valid()},
		{"no snapshot", "slack:C1:100.5", nil},
		{"no title or body", "slack:C1:100.5", with("title", nil)},
		{"not a slack resource", "slack:C1:100.5", with("resource_type", "pr")},
		{"no resource type", "slack:C1:100.5", with("resource_type", nil)},
		{"another channel's thread", "slack:C1:100.5", with("resource_id", "C2:100.1")},
		{"resource id without a thread", "slack:C1:100.5", with("resource_id", "C1")},
		{"channel prefix only", "slack:C1:100.5", with("resource_id", "C1:")},
		{"javascript url", "slack:C1:100.5", with("url", "javascript:alert(1)")},
		{"ftp url", "slack:C1:100.5", with("url", "ftp://x/y")},
		{"relative url", "slack:C1:100.5", with("url", "/archives/C1")},
	}
	for _, path := range []string{"/api/tasks/events/link", "/api/tasks/from-event"} {
		for _, c := range bad {
			if code := post(path, c.key, c.snap); code != http.StatusBadRequest {
				t.Errorf("%s %s = %d, want 400", path, c.name, code)
			}
		}
	}
	if n := countRows(t, s, "tasks"); n != 1 {
		t.Fatalf("rejected from-event requests created tasks: %d", n)
	}

	// Accepted: an empty URL; the server sets source and type and caps the title.
	snap := with("url", "")
	snap["source"], snap["type"] = "github", "pr_merged"
	snap["title"] = strings.Repeat("é", 300)
	d := decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/events/link",
		map[string]any{"id": tk.ID, "key": "slack:C1:100.5", "snapshot": snap}))
	got := d.EventLinks[0].Snapshot
	if got.Source != "slack" || got.Type != "slack_reply" || utf8.RuneCountInString(got.Title) != 200 || got.URL != "" {
		t.Fatalf("snapshot = %+v", got)
	}
	if code := post("/api/tasks/events/link", "slack:C1:100.6", with("url", "http://x/y")); code != http.StatusOK {
		t.Errorf("http url = %d", code)
	}
}

func countRows(t *testing.T, s *Server, table string) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestFromEventSlackTitleIsPlainText(t *testing.T) {
	s, _ := tasksServer(t)
	d := decodeDetail(t, serveTasks(t, s, http.MethodPost, "/api/tasks/from-event", map[string]any{
		"key": "slack:C1:5.5",
		"snapshot": map[string]any{
			"body":          "<@U123> see <https://x.io/a|the doc> in <#C9|general> &amp; <https://y.io> &lt;3",
			"resource_type": "slack", "resource_id": "C1:5.0",
		},
	}))
	if want := "@user see the doc in #general & https://y.io <3"; d.Title != want {
		t.Fatalf("title = %q, want %q", d.Title, want)
	}
}

func TestSlackPlain(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"plain", "plain"},
		{"<@U123>", "@user"},
		{"<@U123|bob>", "@bob"},
		{"<#C123|general>", "#general"},
		{"<#C123>", "#channel"},
		{"<https://x.io|label>", "label"},
		{"<https://x.io>", "https://x.io"},
		{"<mailto:a@b.c|a@b.c>", "a@b.c"},
		{"<!here>", "@here"},
		{"<!subteam^S1|@team>", "@team"},
		{"a &lt;b&gt; &amp;lt;", "a <b> &lt;"},
		{"x < y", "x < y"},
	} {
		if got := slackPlain(c.in); got != c.want {
			t.Errorf("slackPlain(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
