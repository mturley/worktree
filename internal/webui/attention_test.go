package webui

import (
	"database/sql"
	"io"
	"log"
	"os"
	"slices"
	"strconv"
	"testing"

	watcher "github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/attention"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/reviewcomments"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/testgit"
	"github.com/mturley/worktree/internal/unread"
)

// attentionFixture has two registered worktrees and a Server holding only
// the DB, the way the CLI builds it.
func attentionFixture(t *testing.T) (s *Server, a, b string) {
	t.Helper()
	conn := seededDB(t)
	a, b = testgit.Worktree(t), testgit.Worktree(t)
	must(t, registry.Register(conn, registry.Entry{Path: a, Repo: "r", RepoRoot: a, Branch: "a", CreatedAt: "2026-01-01T00:00:00Z"}))
	must(t, registry.Register(conn, registry.Entry{Path: b, Repo: "r", RepoRoot: b, Branch: "b", CreatedAt: "2026-01-02T00:00:00Z"}))
	return &Server{DB: conn}, a, b
}

// attentionEvent records one event on a resource.
func attentionEvent(t *testing.T, conn *sql.DB, id, ts, source, typ, resType, resID, body string, externalTS *string) {
	t.Helper()
	author := "Someone"
	must(t, watcherdb.InsertEvent(conn, watcher.Event{
		ID: id, TS: ts, ExternalTS: externalTS, Source: source, Type: watcher.EventType(typ),
		Title: "title " + id, Body: &body, Author: &author,
	}, watcher.Resource{Type: resType, ID: resID}))
}

func resourceIDs(rs []attention.Resource) []string {
	out := []string{}
	for _, r := range rs {
		out = append(out, r.ID)
	}
	slices.Sort(out)
	return out
}

func taskTitles(ts []attention.OpenTask) []string {
	out := []string{}
	for _, t := range ts {
		out = append(out, t.Title)
	}
	slices.Sort(out)
	return out
}

func findResource(t *testing.T, rs []attention.Resource, id string) attention.Resource {
	t.Helper()
	for _, r := range rs {
		if r.ID == id {
			return r
		}
	}
	t.Fatalf("no resource %q in %v", id, resourceIDs(rs))
	return attention.Resource{}
}

func findTask(t *testing.T, ts []attention.OpenTask, title string) attention.OpenTask {
	t.Helper()
	for _, o := range ts {
		if o.Title == title {
			return o
		}
	}
	t.Fatalf("no task %q in %v", title, taskTitles(ts))
	return attention.OpenTask{}
}

func TestAttentionInputScopes(t *testing.T) {
	t.Parallel()
	s, a, b := attentionFixture(t)
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "pr", ID: "o/r#shared", URL: "u1"}))
	must(t, resources.Add(s.DB, b, resources.Resource{Type: "pr", ID: "o/r#shared", URL: "u1"}))
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "jira", ID: "J-a", URL: "u2"}))
	must(t, resources.Add(s.DB, b, resources.Resource{Type: "pr", ID: "o/r#b", URL: "u3"}))

	wtTask := func(title, path string) tasks.Task {
		return mustTask(t, s, tasks.NewTask{Title: title, Focus: []tasks.LinkTarget{{Kind: tasks.LinkWorktree, Worktree: path}}})
	}
	wtTask("linked-a", a)
	wtTask("linked-b", b)
	mustTask(t, s, tasks.NewTask{Title: "implicit-a", Focus: []tasks.LinkTarget{resLink("jira", "J-a")}})
	mustTask(t, s, tasks.NewTask{Title: "global"})
	// A resource only a task's blocker holds is polled but followed by no
	// worktree.
	holder := mustTask(t, s, tasks.NewTask{Title: "holder"})
	if _, err := tasks.AddBlocker(s.DB, webUser, holder.ID, tasks.BlockerTarget{Kind: tasks.BlockerResource, ResourceType: "pr", ResourceID: "o/r#held", URL: "u9"}); err != nil {
		t.Fatal(err)
	}
	must(t, tasks.ReconcileHolds(s.DB))
	must(t, unread.MarkRead(s.DB, "pr", "o/r#held", "2026-01-01T00:00:00Z"))
	attentionEvent(t, s.DB, "held-1", "2026-02-01T00:00:00Z", "github", "pr_comment", "pr", "o/r#held", "b", nil)

	cases := []struct {
		path      string
		resources []string
		tasks     []string
	}{
		{"", []string{"J-a", "o/r#b", "o/r#shared"}, []string{"global", "holder", "implicit-a", "linked-a", "linked-b"}},
		{a, []string{"J-a", "o/r#shared"}, []string{"implicit-a", "linked-a"}},
		{b, []string{"o/r#b", "o/r#shared"}, []string{"linked-b"}},
	}
	for _, c := range cases {
		rs, ts, _, _, err := s.AttentionInput(c.path)
		if err != nil {
			t.Fatal(err)
		}
		if got := resourceIDs(rs); !slices.Equal(got, c.resources) {
			t.Errorf("path %q: resources = %v, want %v", c.path, got, c.resources)
		}
		if got := taskTitles(ts); !slices.Equal(got, c.tasks) {
			t.Errorf("path %q: tasks = %v, want %v", c.path, got, c.tasks)
		}
	}

	// A scoped resource still names every worktree following it.
	rs, _, _, _, err := s.AttentionInput(a)
	if err != nil {
		t.Fatal(err)
	}
	if got := findResource(t, rs, "o/r#shared").Worktrees; len(got) != 2 {
		t.Fatalf("worktrees = %v", got)
	}
}

func TestAttentionInputFacts(t *testing.T) {
	t.Parallel()
	s, a, _ := attentionFixture(t)
	const me = "101"
	must(t, selfid.Set(s.DB, "github", me))
	must(t, selfid.Set(s.DB, "jira", "acct-me"))
	must(t, selfid.Set(s.DB, "slack", "U-ME"))
	state := func(typ, id, json string) {
		must(t, watcherdb.UpsertResourceState(s.DB, typ, id, json, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
	}
	for _, r := range []resources.Resource{
		{Type: "pr", ID: "o/r#mine", URL: "https://pr/mine"},
		{Type: "pr", ID: "o/r#review", URL: "u"},
		{Type: "jira", ID: "J-assigned", URL: "u"},
		{Type: "jira", ID: "J-reported", URL: "u"},
	} {
		must(t, resources.Add(s.DB, a, r))
	}
	must(t, watcherdb.SetResourceMeta(s.DB, watcher.Resource{Type: "pr", ID: "o/r#mine"}, "My name", ""))
	state("pr", "o/r#mine", `{"title":"Mine","state":"OPEN","author_id":"101","review_decision":"CHANGES_REQUESTED","ci_status":"FAILURE"}`)
	state("pr", "o/r#review", `{"title":"Theirs","state":"OPEN","author_id":"202","requested_reviewer_ids":["9","101"]}`)
	state("jira", "J-assigned", `{"summary":"A","status":"New","priority":"Major","priority_rank":2,"assignee":"Me","assignee_id":"acct-me","reporter_id":"other"}`)
	state("jira", "J-reported", `{"summary":"R","priority":"Minor","priority_rank":4,"assignee_id":"other","reporter_id":"acct-me"}`)

	// resources.Add seeded the cursor at now, and MarkRead only moves it forward.
	if _, err := s.DB.Exec(`UPDATE resource_read_cursor SET last_read_ts = ? WHERE resource_id = ?`, "2026-02-01T00:00:00Z", "o/r#mine"); err != nil {
		t.Fatal(err)
	}
	attentionEvent(t, s.DB, "old", "2026-01-15T00:00:00Z", "github", "pr_comment", "pr", "o/r#mine", "read already", nil)
	attentionEvent(t, s.DB, "e1", "2026-02-02T00:00:00Z", "github", "pr_comment", "pr", "o/r#mine", "first", nil)
	attentionEvent(t, s.DB, "e2", "2026-02-03T00:00:00Z", "github", "pr_comment", "pr", "o/r#mine", "second", nil)

	linked := mustTask(t, s, tasks.NewTask{Title: "linked", Priority: tasks.PriorityHigh, Due: "2026-11-06", Focus: []tasks.LinkTarget{resLink("pr", "o/r#mine")}})

	_, err := reviewcomments.Create(s.DB, a, reviewcomments.NewComment{
		File: "f.go", Side: reviewcomments.SideNew, Body: "draft",
		Anchor: reviewcomments.Anchor{Start: 1, End: 1, Snippet: []string{"x"}},
	})
	must(t, err)

	rs, ts, linkedJira, self, err := s.AttentionInput("")
	if err != nil {
		t.Fatal(err)
	}
	if self.SlackID != "U-ME" {
		t.Errorf("self = %+v", self)
	}

	mine := findResource(t, rs, "o/r#mine")
	if !mine.Mine || mine.AssignedToMe || mine.ReviewRequestedFromMe {
		t.Errorf("mine flags: %+v", mine)
	}
	if mine.Title != "Mine" || mine.CustomName != "My name" || mine.URL != "https://pr/mine" || mine.State != "OPEN" ||
		mine.ReviewDecision != "CHANGES_REQUESTED" || mine.CIStatus != "FAILURE" {
		t.Errorf("mine fields: %+v", mine)
	}
	if mine.UnreadCount != 2 || mine.NewestUnreadTS != "2026-02-03T00:00:00Z" {
		t.Errorf("mine unread: %+v", mine)
	}
	if len(mine.Unread) != 2 || mine.Unread[0].ID != "e2" || mine.Unread[1].ID != "e1" {
		t.Fatalf("unread events = %+v", mine.Unread)
	}
	if e := mine.Unread[0]; e.Body != "second" || e.Author != "Someone" || e.Source != "github" || e.Type != "pr_comment" || e.Title != "title e2" {
		t.Errorf("event = %+v", e)
	}
	if mine.DraftComments != 1 {
		t.Errorf("draft comments = %d", mine.DraftComments)
	}
	wantTask := attention.Task{ID: strconv.FormatInt(linked.ID, 10), Title: "linked", State: "not_started", Priority: "high", Due: "2026-11-06"}
	if len(mine.Tasks) != 1 || mine.Tasks[0] != wantTask {
		t.Errorf("tasks = %+v, want %+v", mine.Tasks, wantTask)
	}

	review := findResource(t, rs, "o/r#review")
	if review.Mine || !review.ReviewRequestedFromMe || review.DraftComments != 1 {
		t.Errorf("review: %+v", review)
	}

	assigned := findResource(t, rs, "J-assigned")
	if !assigned.AssignedToMe || assigned.Mine {
		t.Errorf("assigned: %+v", assigned)
	}
	if assigned.PriorityRank == nil || *assigned.PriorityRank != 2 || assigned.Priority != "Major" || assigned.Status != "New" || assigned.Assignee != "Me" {
		t.Errorf("assigned fields: %+v", assigned)
	}
	if assigned.DraftComments != 0 {
		t.Errorf("a Jira issue has no drafts: %+v", assigned)
	}
	// Reporting an issue is not "mine" here, though the UI's filter counts it.
	if reported := findResource(t, rs, "J-reported"); reported.Mine || reported.AssignedToMe {
		t.Errorf("reported: %+v", reported)
	}

	for _, pr := range []string{"pr:o/r#mine", "pr:o/r#review"} {
		got := slices.Clone(linkedJira[pr])
		slices.Sort(got)
		if !slices.Equal(got, []int{2, 4}) {
			t.Errorf("linkedJira[%s] = %v", pr, got)
		}
	}

	task := findTask(t, ts, "linked")
	if task.Task != wantTask || task.UnblockedUnread || task.UpdatedAt == "" {
		t.Errorf("open task = %+v", task)
	}
	if len(task.Worktrees) != 1 {
		t.Errorf("implicit worktree missing: %+v", task)
	}
}

// A PR's linked ranks don't depend on the scope: a Jira issue outside the
// selected worktree, but sharing another with the PR, still lifts it.
func TestAttentionInputLinkedJiraIgnoresScope(t *testing.T) {
	t.Parallel()
	s, a, b := attentionFixture(t)
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}))
	must(t, resources.Add(s.DB, b, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}))
	must(t, resources.Add(s.DB, b, resources.Resource{Type: "jira", ID: "J-b", URL: "u"}))
	must(t, resources.Add(s.DB, b, resources.Resource{Type: "jira", ID: "J-unranked", URL: "u"}))
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u"}))
	must(t, watcherdb.UpsertResourceState(s.DB, "jira", "J-b", `{"priority_rank":0}`, "x", "x"))
	_, _, linked, _, err := s.AttentionInput(a)
	if err != nil {
		t.Fatal(err)
	}
	if got := linked["pr:o/r#1"]; !slices.Equal(got, []int{0}) {
		t.Fatalf("o/r#1 = %v", got)
	}
	if got := linked["pr:o/r#2"]; len(got) != 0 {
		t.Fatalf("o/r#2 shares no worktree with a Jira issue: %v", got)
	}
}

func TestAttentionInputDraftsSumAcrossFollowers(t *testing.T) {
	t.Parallel()
	s, a, b := attentionFixture(t)
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}))
	must(t, resources.Add(s.DB, b, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}))
	for _, p := range []string{a, b} {
		_, err := reviewcomments.Create(s.DB, p, reviewcomments.NewComment{
			File: "f.go", Side: reviewcomments.SideNew, Body: "draft",
			Anchor: reviewcomments.Anchor{Start: 1, End: 1, Snippet: []string{"x"}},
		})
		must(t, err)
	}
	rs, _, _, _, err := s.AttentionInput(a)
	if err != nil {
		t.Fatal(err)
	}
	if got := findResource(t, rs, "o/r#1").DraftComments; got != 2 {
		t.Fatalf("drafts = %d", got)
	}
}

// Task events are in the unread timeline under resource type "task". They
// are neither resources nor a resource's own unread.
func TestAttentionInputKeepsTaskEventsOutOfResources(t *testing.T) {
	t.Parallel()
	s, a, _ := attentionFixture(t)
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}))
	tk := mustTask(t, s, tasks.NewTask{Title: "t", Focus: []tasks.LinkTarget{resLink("pr", "o/r#1")}})
	insertTaskEvent(t, s.DB, tk.ID, "2026-02-01T00:00:00Z", "task_updated", "agent", "")

	// The fixture is only meaningful if the UI's count does include it.
	all, err := s.AllResources()
	if err != nil {
		t.Fatal(err)
	}
	if all[0].TaskUnreadCount == 0 || all[0].UnreadCount == 0 {
		t.Fatalf("fixture: %+v", all[0])
	}

	rs, ts, _, _, err := s.AttentionInput("")
	if err != nil {
		t.Fatal(err)
	}
	if len(rs) != 1 {
		t.Fatalf("resources = %v", resourceIDs(rs))
	}
	r := rs[0]
	if r.UnreadCount != 0 || len(r.Unread) != 0 || r.NewestUnreadTS != "" {
		t.Fatalf("task events counted on the resource: %+v", r)
	}
	if findTask(t, ts, "t").UnblockedUnread {
		t.Fatal("task_updated is not a blocker resolution")
	}
}

func TestAttentionInputUnblockedUnread(t *testing.T) {
	t.Parallel()
	const auto = `{"auto":true}`
	cases := []struct {
		name, actor, typ, payload string
		cursor                    string
		want                      bool
	}{
		{"automatic, no cursor", "system", tasks.EventTaskBlockerResolved, auto, "", true},
		{"automatic, newer than cursor", "system", tasks.EventTaskBlockerResolved, auto, "2026-01-01T00:00:00Z", true},
		{"automatic, at the cursor", "system", tasks.EventTaskBlockerResolved, auto, "2026-02-01T00:00:00Z", false},
		{"automatic, older than cursor", "system", tasks.EventTaskBlockerResolved, auto, "2026-03-01T00:00:00Z", false},
		{"by hand", "user", tasks.EventTaskBlockerResolved, `{}`, "", false},
		{"on add", "system", tasks.EventTaskBlockerResolved, `{"auto":true,"on_add":true}`, "", false},
		{"on undo", "system", tasks.EventTaskBlockerResolved, `{"auto":true,"on_undo":true}`, "", false},
		{"another event", "agent", "task_updated", `{}`, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			s, _, _ := attentionFixture(t)
			tk := mustTask(t, s, tasks.NewTask{Title: "t"})
			insertTaskEvent(t, s.DB, tk.ID, "2026-02-01T00:00:00Z", c.typ, c.actor, c.payload)
			if c.cursor != "" {
				must(t, unread.MarkRead(s.DB, "task", strconv.FormatInt(tk.ID, 10), c.cursor))
			}
			_, ts, _, _, err := s.AttentionInput("")
			if err != nil {
				t.Fatal(err)
			}
			if got := findTask(t, ts, "t").UnblockedUnread; got != c.want {
				t.Fatalf("UnblockedUnread = %v, want %v", got, c.want)
			}
		})
	}
}

func TestAttentionInputExcludesDoneTasks(t *testing.T) {
	t.Parallel()
	s, _, _ := attentionFixture(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "done", Due: "2026-01-01"})
	if _, err := tasks.SetState(s.DB, webUser, tk.ID, tasks.StateDone); err != nil {
		t.Fatal(err)
	}
	_, ts, _, _, err := s.AttentionInput("")
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != 0 {
		t.Fatalf("tasks = %v", taskTitles(ts))
	}
}

func TestAttentionInputSlack(t *testing.T) {
	t.Parallel()
	s, a, _ := attentionFixture(t)
	const id = "C1:100.000"
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "slack", ID: id, URL: "u"}))
	must(t, watcherdb.UpsertResourceState(s.DB, "slack", id,
		`{"channel_name":"dev","has_unread":true,"last_read":"200.000"}`, "x", "x"))
	ext := "300.000"
	attentionEvent(t, s.DB, "m1", "2026-02-01T00:00:00Z", "slack", "slack_message", "slack", id, "hi <@U-ME>", &ext)
	rs, _, _, _, err := s.AttentionInput("")
	if err != nil {
		t.Fatal(err)
	}
	r := findResource(t, rs, id)
	if r.UnreadCount != 1 || len(r.Unread) != 1 || r.Unread[0].Body != "hi <@U-ME>" {
		t.Fatalf("slack: %+v", r)
	}
	// A thread has no unread_through_ts: its newest time is its newest event's.
	if r.NewestUnreadTS != "2026-02-01T00:00:00Z" {
		t.Fatalf("newest = %q", r.NewestUnreadTS)
	}
	if r.Title != "#dev" {
		t.Fatalf("title = %q", r.Title)
	}
}

// A worktree deleted from disk keeps its registry row. It must not break the
// command or hide what the other worktrees hold.
func TestAttentionInputSurvivesDeletedWorktree(t *testing.T) {
	t.Parallel()
	s, a, b := attentionFixture(t)
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "pr", ID: "o/r#a", URL: "u"}))
	must(t, resources.Add(s.DB, b, resources.Resource{Type: "pr", ID: "o/r#b", URL: "u"}))
	must(t, os.RemoveAll(a))
	rs, _, _, _, err := s.AttentionInput("")
	if err != nil {
		t.Fatal(err)
	}
	findResource(t, rs, "o/r#b")
	if _, _, _, _, err := s.AttentionInput(a); err != nil {
		t.Fatalf("scoped to the deleted worktree: %v", err)
	}
}

func TestAttentionInputDraftFailureCountsZero(t *testing.T) {
	t.Parallel()
	s, a, _ := attentionFixture(t)
	s.Logger = log.New(io.Discard, "", 0)
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}))
	if _, err := s.DB.Exec(`DROP TABLE review_comments`); err != nil {
		t.Fatal(err)
	}
	rs, _, _, _, err := s.AttentionInput("")
	if err != nil {
		t.Fatalf("a reviewcomments failure must not fail the command: %v", err)
	}
	if got := findResource(t, rs, "o/r#1").DraftComments; got != 0 {
		t.Fatalf("drafts = %d", got)
	}
}

// Read-only: neither a read cursor nor a self identity appears as a side
// effect, even for a resource with no cursor yet.
func TestAttentionInputDoesNotWrite(t *testing.T) {
	t.Parallel()
	s, a, _ := attentionFixture(t)
	must(t, resources.Add(s.DB, a, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}))
	attentionEvent(t, s.DB, "e1", "2026-02-01T00:00:00Z", "github", "pr_comment", "pr", "o/r#1", "b", nil)
	if _, err := s.DB.Exec(`DELETE FROM resource_read_cursor`); err != nil {
		t.Fatal(err)
	}
	if _, _, _, _, err := s.AttentionInput(""); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"resource_read_cursor", "self_identity"} {
		var n int
		if err := s.DB.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Errorf("%s has %d rows", table, n)
		}
	}
}
