package webui

import (
	"database/sql"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/tasks"
)

// insertTaskEvent writes one task event with a chosen ts, returning its
// timeline id ("task:<id>").
func insertTaskEvent(t *testing.T, db *sql.DB, taskID int64, ts, typ, actor, payload string) string {
	t.Helper()
	if payload == "" {
		payload = "{}"
	}
	res, err := db.Exec(`INSERT INTO task_events (task_id, ts, type, actor, payload) VALUES (?,?,?,?,?)`,
		taskID, ts, typ, actor, payload)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return "task:" + strconv.FormatInt(id, 10)
}

func tts(sec int) string { return "2026-01-01T00:00:" + pad2(sec) + "Z" }

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// taskFeedFixture: worktree wt follows pr o/r#1. Task "alpha zebra" links
// wt, task "beta" links the PR (so it is in wt's scope implicitly), task
// "gamma" is global, task "delta" is deleted. Every event the setup wrote is
// cleared so each test controls the ts values exactly.
type taskFeed struct {
	s                         *Server
	wt                        string
	base                      string
	alpha, beta, gamma, delta tasks.Task
}

func taskFeedFixture(t *testing.T) *taskFeed {
	t.Helper()
	s, wt := tasksServer(t)
	must(t, resources.Add(s.DB, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"}))
	f := &taskFeed{s: s, wt: wt}
	f.alpha = mustTask(t, s, tasks.NewTask{Title: "alpha zebra", Focus: []tasks.LinkTarget{{Kind: tasks.LinkWorktree, Worktree: wt}}})
	f.beta = mustTask(t, s, tasks.NewTask{Title: "beta", Focus: []tasks.LinkTarget{resLink("pr", "o/r#1")}})
	f.gamma = mustTask(t, s, tasks.NewTask{Title: "gamma"})
	f.delta = mustTask(t, s, tasks.NewTask{Title: "delta"})
	if _, err := tasks.Delete(s.DB, webUser, f.delta.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`DELETE FROM task_events`); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	f.base = ts.URL
	return f
}

func (f *taskFeed) home(t *testing.T, query string) timelineResponse {
	t.Helper()
	return getTimeline(t, f.base, "/api/timeline?archived=false&"+query)
}

func (f *taskFeed) worktree(t *testing.T, query string) timelineResponse {
	t.Helper()
	return getTimeline(t, f.base, "/api/worktree-timeline?path="+url.QueryEscape(f.wt)+"&"+query)
}

func joinIDs(evs []TimelineEvent) string { return strings.Join(eventIDs(evs), ",") }

func TestTimelineTaskEventsHomeMergeOrder(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	insertEvent(t, f.s.DB, "e1", tts(10), "github", "pr_comment", "comment", "pr", "o/r#1", "u1")
	a := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(20), tasks.EventTaskCreated, tasks.ActorUser, "")
	c := insertTaskEvent(t, f.s.DB, f.gamma.ID, tts(10), tasks.EventTaskCreated, tasks.ActorUser, "")
	b := insertTaskEvent(t, f.s.DB, f.beta.ID, tts(5), tasks.EventTaskCreated, tasks.ActorAgent, "")
	insertTaskEvent(t, f.s.DB, f.delta.ID, tts(15), tasks.EventTaskCreated, tasks.ActorAgent, "")

	got := f.home(t, "limit=50").Events
	// A tie puts the watcher row first; the deleted task's event is absent.
	if want := strings.Join([]string{a, "e1", c, b}, ","); joinIDs(got) != want {
		t.Fatalf("home feed = %s, want %s", joinIDs(got), want)
	}
	row := got[0]
	if row.Source != "tasks" || row.ResourceType != "task" || row.ResourceID != strconv.FormatInt(f.alpha.ID, 10) ||
		row.Title != "Created “alpha zebra”" || row.ResourceTitle != "alpha zebra" {
		t.Fatalf("converted row = %+v", row)
	}
	// archived=true shows them too.
	if got := getTimeline(t, f.base, "/api/timeline?archived=true&limit=50").Events; len(got) != 4 {
		t.Fatalf("archived=true = %s", joinIDs(got))
	}
}

// A task event names the worktrees its task belongs to (linked directly, or
// following one of its resource links), and is archived only when the task
// is: a global task (no links) is neither, and has no worktrees.
func TestTimelineTaskEventsWorktreesAndArchived(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	// The fixture worktree followed o/r#9 and stopped: the task linking only
	// it is archived. A resource no worktree ever followed would not be.
	must(t, resources.Add(f.s.DB, f.wt, resources.Resource{Type: "pr", ID: "o/r#9", URL: "u9"}))
	must(t, resources.Remove(f.s.DB, f.wt, "pr", "o/r#9"))
	orphan := mustTask(t, f.s, tasks.NewTask{Title: "orphan", Focus: []tasks.LinkTarget{resLink("pr", "o/r#9")}})
	a := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(40), tasks.EventTaskCreated, tasks.ActorUser, "")
	b := insertTaskEvent(t, f.s.DB, f.beta.ID, tts(30), tasks.EventTaskCreated, tasks.ActorUser, "")
	c := insertTaskEvent(t, f.s.DB, f.gamma.ID, tts(20), tasks.EventTaskCreated, tasks.ActorUser, "")
	o := insertTaskEvent(t, f.s.DB, orphan.ID, tts(10), tasks.EventTaskCreated, tasks.ActorUser, "")

	byID := map[string]TimelineEvent{}
	for _, e := range f.home(t, "limit=50").Events {
		byID[e.ID] = e
	}
	wtPath := wdbCanonical(t, f.wt)
	for _, id := range []string{a, b} {
		e := byID[id]
		if len(e.WorktreePaths) != 1 || wdbCanonical(t, e.WorktreePaths[0]) != wtPath || len(e.Worktrees) != 1 || e.Worktrees[0] == "" {
			t.Fatalf("%s worktrees = %v / %v, want the fixture worktree", id, e.Worktrees, e.WorktreePaths)
		}
		if e.Archived {
			t.Fatalf("%s is archived", id)
		}
	}
	if e := byID[c]; len(e.WorktreePaths) != 0 || e.Archived {
		t.Fatalf("global task event = %v archived=%v, want no worktrees, not archived", e.WorktreePaths, e.Archived)
	}
	if e := byID[o]; len(e.WorktreePaths) != 0 || !e.Archived {
		t.Fatalf("orphaned task event = %v archived=%v, want no worktrees, archived", e.WorktreePaths, e.Archived)
	}
}

// A state change names the state it changed to, and a creation the state a
// new task starts in, so the feed can draw that checkbox; other task events
// name none.
func TestTimelineTaskEventsState(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	created := insertTaskEvent(t, f.s.DB, f.gamma.ID, tts(30), tasks.EventTaskCreated, tasks.ActorUser, "")
	changed := insertTaskEvent(t, f.s.DB, f.gamma.ID, tts(20), tasks.EventTaskStateChanged, tasks.ActorUser,
		`{"from":"not_started","to":"in_progress"}`)
	blocker := insertTaskEvent(t, f.s.DB, f.gamma.ID, tts(10), tasks.EventTaskBlockerResolved, tasks.ActorSystem, `{}`)
	byID := map[string]TimelineEvent{}
	for _, e := range f.home(t, "limit=50").Events {
		byID[e.ID] = e
	}
	if got := byID[created].TaskState; got != "not_started" {
		t.Fatalf("created task_state = %q, want not_started", got)
	}
	if got := byID[changed].TaskState; got != "in_progress" {
		t.Fatalf("state change task_state = %q, want in_progress", got)
	}
	if got := byID[blocker].TaskState; got != "" {
		t.Fatalf("blocker event task_state = %q, want none", got)
	}
}

// wdbCanonical is a path as worktree subscribers key it (symlinks resolved).
func wdbCanonical(t *testing.T, p string) string {
	t.Helper()
	c, ok := wdb.WorktreePathFromSubscriber(wdb.Subscriber(p))
	if !ok {
		t.Fatalf("no canonical path for %s", p)
	}
	return c
}

func TestTimelineMergePaging(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	var want []string
	// Watcher events on odd seconds, task events (all in wt's scope) on even
	// ones, interleaved.
	for sec := 7; sec >= 1; sec-- {
		if sec%2 == 1 {
			id := "w" + strconv.Itoa(sec)
			insertEvent(t, f.s.DB, id, tts(sec), "github", "pr_comment", "c", "pr", "o/r#1", "u1")
			want = append(want, id)
		} else {
			want = append(want, insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(sec), tasks.EventTaskStateChanged, tasks.ActorUser, ""))
		}
	}
	for name, get := range map[string]func(*testing.T, string) timelineResponse{"home": f.home, "worktree": f.worktree} {
		var all []string
		before := ""
		for page := 0; page < 10; page++ {
			q := "limit=3"
			if before != "" {
				q += "&before=" + url.QueryEscape(before)
			}
			resp := get(t, q)
			all = append(all, eventIDs(resp.Events)...)
			if len(resp.Events) < 3 {
				break
			}
			before = resp.NextCursor
		}
		if strings.Join(all, ",") != strings.Join(want, ",") {
			t.Errorf("%s paged = %v, want %v", name, all, want)
		}
	}
}

func TestTimelineTaskEventsWorktreeAndResourceScope(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	insertEvent(t, f.s.DB, "e1", tts(1), "github", "pr_comment", "c", "pr", "o/r#1", "u1")
	a := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(4), tasks.EventTaskStateChanged, tasks.ActorUser, "")
	b := insertTaskEvent(t, f.s.DB, f.beta.ID, tts(3), tasks.EventTaskStateChanged, tasks.ActorUser, "")
	insertTaskEvent(t, f.s.DB, f.gamma.ID, tts(2), tasks.EventTaskStateChanged, tasks.ActorUser, "")
	insertTaskEvent(t, f.s.DB, f.delta.ID, tts(5), tasks.EventTaskStateChanged, tasks.ActorUser, "")

	if got, want := joinIDs(f.worktree(t, "").Events), strings.Join([]string{a, b, "e1"}, ","); got != want {
		t.Errorf("worktree feed = %s, want %s", got, want)
	}
	if got, want := joinIDs(f.worktree(t, "resource_type=pr&resource_id="+url.QueryEscape("o/r#1")).Events), strings.Join([]string{b, "e1"}, ","); got != want {
		t.Errorf("resource feed = %s, want %s", got, want)
	}
}

func TestTimelineTaskEventsFilters(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	insertEvent(t, f.s.DB, "e1", tts(1), "github", "pr_comment", "c", "pr", "o/r#1", "u1")
	a := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(2), tasks.EventTaskStateChanged, tasks.ActorUser, "")
	for _, feed := range []struct {
		name string
		get  func(*testing.T, string) timelineResponse
	}{{"home", f.home}, {"worktree", f.worktree}} {
		cases := map[string]string{
			"resource_types=pr":           "e1",
			"resource_types=task":         a,
			"resource_types=pr,task":      a + ",e1",
			"resource_types=bogus":        a + ",e1", // unknown values drop to no filter
			"event_types=pr_comment":      "e1",
			"event_types=task":            a,
			"event_types=pr_comment,task": a + ",e1",
		}
		for q, want := range cases {
			if got := joinIDs(feed.get(t, q).Events); got != want {
				t.Errorf("%s %s = %s, want %s", feed.name, q, got, want)
			}
		}
	}
}

func TestTimelineTaskEventsUnread(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	// alpha: agent events either side of its cursor.
	readA := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(2), tasks.EventTaskStateChanged, tasks.ActorAgent, "")
	newA := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(6), tasks.EventTaskStateChanged, tasks.ActorAgent, "")
	if _, err := f.s.DB.Exec(`INSERT INTO resource_read_cursor (resource_type, resource_id, last_read_ts, updated_at) VALUES ('task', ?, ?, ?)`,
		strconv.FormatInt(f.alpha.ID, 10), tts(4), tts(4)); err != nil {
		t.Fatal(err)
	}
	// beta: no cursor, so every agent event is unread; the user's never is.
	agentB := insertTaskEvent(t, f.s.DB, f.beta.ID, tts(3), tasks.EventTaskStateChanged, tasks.ActorAgent, "")
	userB := insertTaskEvent(t, f.s.DB, f.beta.ID, tts(5), tasks.EventTaskStateChanged, tasks.ActorUser, "")

	for _, feed := range []struct {
		name string
		get  func(*testing.T, string) timelineResponse
	}{{"home", f.home}, {"worktree", f.worktree}} {
		got := feed.get(t, "").Events
		if want := strings.Join([]string{newA, userB, agentB, readA}, ","); joinIDs(got) != want {
			t.Fatalf("%s feed = %s, want %s", feed.name, joinIDs(got), want)
		}
		if u, want := strings.Join(unreadIDs(got), ","), newA+","+agentB; u != want {
			t.Errorf("%s unread = %s, want %s", feed.name, u, want)
		}
		if got, want := joinIDs(feed.get(t, "unread_only=true").Events), newA+","+agentB; got != want {
			t.Errorf("%s unread_only = %s, want %s", feed.name, got, want)
		}
	}
}

func TestTimelineTaskEventsSearch(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	insertEvent(t, f.s.DB, "e1", tts(1), "github", "pr_comment", "giraffe comment", "pr", "o/r#1", "u1")
	sub := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(3), tasks.EventSubtaskChecked, tasks.ActorUser, `{"text":"Giraffe"}`)
	edit := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(2), tasks.EventTaskStateChanged, tasks.ActorUser, "")
	insertTaskEvent(t, f.s.DB, f.beta.ID, tts(4), tasks.EventTaskStateChanged, tasks.ActorUser, "")

	for _, feed := range []struct {
		name string
		get  func(*testing.T, string) timelineResponse
	}{{"home", f.home}, {"worktree", f.worktree}} {
		// The converted title, case-insensitively.
		got := feed.get(t, "q=GIRAFFE").Events
		if joinIDs(got) != sub+",e1" {
			t.Fatalf("%s q=GIRAFFE = %s", feed.name, joinIDs(got))
		}
		if m := got[0].Match; m == nil || m.Field != "title" || m.Snippet != "Checked “Giraffe”" {
			t.Errorf("%s match = %+v", feed.name, m)
		}
		// The task's title.
		got = feed.get(t, "q=zebra").Events
		if joinIDs(got) != sub+","+edit {
			t.Fatalf("%s q=zebra = %s", feed.name, joinIDs(got))
		}
		if m := got[1].Match; m == nil || m.Field != "resource" || m.Snippet != "alpha zebra" {
			t.Errorf("%s task-title match = %+v", feed.name, m)
		}
		// Every term must match somewhere: one in each field.
		if got := joinIDs(feed.get(t, "q=zebra+giraffe").Events); got != sub {
			t.Errorf("%s q=zebra giraffe = %s", feed.name, got)
		}
	}
}

// q also matches a task event's author, as matchEvent does a watcher
// event's: "agent", the agent's session name, or "you".
func TestTimelineTaskEventsSearchAuthor(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	res, err := f.s.DB.Exec(`INSERT INTO task_events (task_id, ts, type, actor, actor_session, payload)
		VALUES (?, ?, ?, 'agent', 'otter-session', '{}')`, f.alpha.ID, tts(3), tasks.EventTaskStateChanged)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := res.LastInsertId()
	sess := "task:" + strconv.FormatInt(n, 10)
	agent := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(2), tasks.EventTaskStateChanged, tasks.ActorAgent, "")
	user := insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(1), tasks.EventTaskStateChanged, tasks.ActorUser, "")
	for _, feed := range []struct {
		name string
		get  func(*testing.T, string) timelineResponse
	}{{"home", f.home}, {"worktree", f.worktree}} {
		got := feed.get(t, "q=otter").Events
		if joinIDs(got) != sess {
			t.Fatalf("%s q=otter = %s, want %s", feed.name, joinIDs(got), sess)
		}
		if m := got[0].Match; m == nil || m.Field != "author" || m.Snippet != "agent (otter-session)" {
			t.Errorf("%s author match = %+v", feed.name, m)
		}
		if got := joinIDs(feed.get(t, "q=agent").Events); got != sess+","+agent {
			t.Errorf("%s q=agent = %s", feed.name, got)
		}
		if got := joinIDs(feed.get(t, "q=you").Events); got != user {
			t.Errorf("%s q=you = %s", feed.name, got)
		}
	}
}

// pageAll follows next_cursor until a short page, as useTimeline does, and
// returns every id it saw in order.
func pageAll(t *testing.T, get func(*testing.T, string) timelineResponse, limit int, extra string) []string {
	t.Helper()
	var all []string
	before := ""
	for page := 0; page < 20; page++ {
		q := "limit=" + strconv.Itoa(limit) + extra
		if before != "" {
			q += "&before=" + url.QueryEscape(before)
		}
		resp := get(t, q)
		all = append(all, eventIDs(resp.Events)...)
		if len(resp.Events) < limit {
			return all
		}
		before = resp.NextCursor
	}
	t.Fatalf("paging did not end: %v", all)
	return nil
}

// assertSameIDs fails unless got holds exactly want's ids, each once.
func assertSameIDs(t *testing.T, name string, got, want []string) {
	t.Helper()
	seen := map[string]int{}
	for _, id := range got {
		seen[id]++
	}
	for _, id := range want {
		if seen[id] != 1 {
			t.Errorf("%s: %s seen %d times; paged %v", name, id, seen[id], got)
		}
		delete(seen, id)
	}
	for id := range seen {
		t.Errorf("%s: unexpected %s; paged %v", name, id, got)
	}
}

// Task ts values have one-second resolution, so a cluster of events in one
// second can straddle a page boundary. The strict `before` cursor would skip
// the rest of the cluster, so the page overfills with every row sharing the
// last kept row's ts.
func TestTimelinePagingSameTSTaskCluster(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	want := []string{insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(9), tasks.EventTaskStateChanged, tasks.ActorAgent, "")}
	for i := 0; i < 5; i++ {
		want = append(want, insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(5), tasks.EventTaskStateChanged, tasks.ActorAgent, ""))
	}
	want = append(want, insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(1), tasks.EventTaskStateChanged, tasks.ActorAgent, ""))
	for _, feed := range []struct {
		name string
		get  func(*testing.T, string) timelineResponse
	}{{"home", f.home}, {"worktree", f.worktree}} {
		// The plain path (SQL LIMIT) and the Go-filtered ones.
		for _, extra := range []string{"", "&q=alpha", "&unread_only=true"} {
			assertSameIDs(t, feed.name+extra, pageAll(t, feed.get, 3, extra), want)
		}
	}
}

// A watcher/task tie at the boundary: both sides' rows at that ts land on
// the same page, and neither side's are lost or repeated.
func TestTimelinePagingSameTSWatcherTaskTie(t *testing.T) {
	t.Parallel()
	f := taskFeedFixture(t)
	insertEvent(t, f.s.DB, "w9", tts(9), "github", "pr_comment", "c", "pr", "o/r#1", "u1")
	want := []string{"w9"}
	for _, id := range []string{"w5a", "w5b", "w5c"} {
		insertEvent(t, f.s.DB, id, tts(5), "github", "pr_comment", "c", "pr", "o/r#1", "u1")
		want = append(want, id)
	}
	for i := 0; i < 3; i++ {
		want = append(want, insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(5), tasks.EventTaskStateChanged, tasks.ActorUser, ""))
	}
	insertEvent(t, f.s.DB, "w1", tts(1), "github", "pr_comment", "c", "pr", "o/r#1", "u1")
	want = append(want, "w1", insertTaskEvent(t, f.s.DB, f.alpha.ID, tts(1), tasks.EventTaskStateChanged, tasks.ActorUser, ""))
	for _, feed := range []struct {
		name string
		get  func(*testing.T, string) timelineResponse
	}{{"home", f.home}, {"worktree", f.worktree}} {
		for _, limit := range []int{2, 3, 4} {
			assertSameIDs(t, feed.name+" limit="+strconv.Itoa(limit), pageAll(t, feed.get, limit, ""), want)
		}
		// The watcher-only path overfills too.
		assertSameIDs(t, feed.name+" watcher only", pageAll(t, feed.get, 2, "&resource_types=pr"),
			[]string{"w9", "w5a", "w5b", "w5c", "w1"})
	}
}
