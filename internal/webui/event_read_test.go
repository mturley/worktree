package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/unread"
)

func postEventRead(t *testing.T, base, body string) (int, eventReadResponse) {
	t.Helper()
	resp, err := http.Post(base+"/api/event-read", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got eventReadResponse
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode, got
}

// A marked event reads as read on every surface that asks: the row's flag,
// the unread-only filter and the resource's count, whose through-ts falls
// back to the newest event still unread.
func TestMarkEventReadClearsItEverywhere(t *testing.T) {
	t.Parallel()
	conn, wt := unreadOnlyFixture(t)
	s := &Server{DB: conn}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	code, got := postEventRead(t, ts.URL, `{"id":"p3","ts":"2099-01-05T00:00:00Z"}`)
	if code != http.StatusOK || !got.Changed || got.TS != "2099-01-05T00:00:00Z" {
		t.Fatalf("mark: %d %+v", code, got)
	}

	all := getTimeline(t, ts.URL, "/api/timeline?limit=100")
	if got := unreadIDs(all.Events); !sameIDs(got, []string{"s1", "p2"}) {
		t.Fatalf("unread flags = %v", got)
	}
	only := getTimeline(t, ts.URL, "/api/timeline?limit=100&unread_only=true")
	if got := eventIDs(only.Events); !sameIDs(got, []string{"s1", "p2"}) {
		t.Fatalf("unread_only = %v", got)
	}
	dtos, err := s.WorktreeResources(wt)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range dtos {
		if d.Type == "pr" && (d.UnreadCount != 1 || d.UnreadThroughTS != "2099-01-03T00:00:00Z") {
			t.Fatalf("pr dto: count %d through %q", d.UnreadCount, d.UnreadThroughTS)
		}
	}
}

func TestEventReadRestoreBringsItBack(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()

	if code, _ := postEventRead(t, ts.URL, `{"id":"p3","ts":"2099-01-05T00:00:00Z"}`); code != http.StatusOK {
		t.Fatalf("mark: %d", code)
	}
	if code := postJSON(t, ts.URL+"/api/event-read/restore", `{"id":"p3","ts":"2099-01-05T00:00:00Z"}`); code != http.StatusNoContent {
		t.Fatalf("restore: %d", code)
	}
	all := getTimeline(t, ts.URL, "/api/timeline?limit=100")
	if got := unreadIDs(all.Events); !sameIDs(got, []string{"p3", "s1", "p2"}) {
		t.Fatalf("unread flags = %v", got)
	}
}

// Undoing Mark all read restores the cursor; a mark made before it survives.
func TestCursorRestoreLeavesEventMarks(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	s := &Server{DB: conn}
	if _, err := s.MarkEventRead("p3", ""); err != nil {
		t.Fatal(err)
	}
	ch, err := unread.Mark(conn, "pr", "o/r#1", "2099-01-05T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if err := unread.Restore(conn, "pr", "o/r#1", ch.Current, ch.Previous); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	all := getTimeline(t, ts.URL, "/api/timeline?limit=100")
	if got := unreadIDs(all.Events); !sameIDs(got, []string{"s1", "p2"}) {
		t.Fatalf("unread flags = %v", got)
	}
}

// Nothing to undo when the event already reads as read, whichever rule says so.
func TestMarkEventReadIsANoOpOnAReadEvent(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	insertUnreadEvent(t, conn, "mine", "2099-01-09T00:00:00Z", "github", "pr", "o/r#1")
	if _, err := conn.Exec(`UPDATE watcher_events SET author_id='101' WHERE id='mine'`); err != nil {
		t.Fatal(err)
	}
	if err := selfid.Set(conn, "github", "101"); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "pending", "2099-01-09T00:00:01Z", "github", "pr", "o/r#1")
	if _, err := conn.Exec(`UPDATE watcher_events SET type='ci_pending' WHERE id='pending'`); err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: conn}
	for _, id := range []string{"p1" /* behind the cursor */, "mine", "pending"} {
		got, err := s.MarkEventRead(id, "")
		if err != nil || got.Changed {
			t.Errorf("%s: %+v, %v; want unchanged", id, got, err)
		}
	}
	if _, err := s.MarkEventRead("p2", ""); err != nil {
		t.Fatal(err)
	}
	if got, err := s.MarkEventRead("p2", ""); err != nil || got.Changed {
		t.Errorf("second mark: %+v, %v; want unchanged", got, err)
	}
	marks, err := unread.EventMarks(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(marks) != 1 {
		t.Fatalf("marks = %v, want only p2's", marks)
	}
}

func TestEventReadErrors(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()
	for _, c := range []struct {
		name, body string
		want       int
	}{
		{"missing id", `{"ts":"2099-01-05T00:00:00Z"}`, http.StatusBadRequest},
		{"unknown event", `{"id":"nope"}`, http.StatusNotFound},
		{"slack event", `{"id":"s1"}`, http.StatusBadRequest},
		{"row changed since it was shown", `{"id":"p3","ts":"2099-01-04T00:00:00Z"}`, http.StatusConflict},
	} {
		if code, _ := postEventRead(t, ts.URL, c.body); code != c.want {
			t.Errorf("%s: status %d, want %d", c.name, code, c.want)
		}
	}
	if code := postJSON(t, ts.URL+"/api/event-read/restore", `{"ts":"x"}`); code != http.StatusBadRequest {
		t.Errorf("restore without id: %d", code)
	}
}

func TestMarkEventReadRefusesSlackByError(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	if _, err := (&Server{DB: conn}).MarkEventRead("s1", ""); !errors.Is(err, unread.ErrSlackNotSupported) {
		t.Fatalf("err = %v", err)
	}
}

func TestMarkTaskEventRead(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	f.seed(t)
	var newest int64
	if err := f.s.DB.QueryRow(`SELECT MAX(id) FROM task_events WHERE task_id = ? AND actor = 'agent'`, f.both.ID).Scan(&newest); err != nil {
		t.Fatal(err)
	}
	id := unread.TaskEventID(newest)
	got, err := f.s.MarkEventRead(id, "")
	if err != nil || !got.Changed {
		t.Fatalf("mark: %+v, %v", got, err)
	}
	sums, err := unread.TaskSummaries(f.s.DB)
	if err != nil {
		t.Fatal(err)
	}
	if n := sums[f.both.ID].Count; n != 1 {
		t.Fatalf("task count = %d, want 1", n)
	}
	events, err := f.s.Timeline(TimelineQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.ID == id {
			found = true
			if e.Unread {
				t.Fatal("the marked task event's row still reads unread")
			}
		}
	}
	if !found {
		t.Fatalf("task event %s not in the feed", id)
	}
	// A user's own task event is already read.
	var mine int64
	if err := f.s.DB.QueryRow(`SELECT id FROM task_events WHERE actor = 'user' LIMIT 1`).Scan(&mine); err != nil {
		t.Fatal(err)
	}
	if got, err := f.s.MarkEventRead(unread.TaskEventID(mine), ""); err != nil || got.Changed {
		t.Fatalf("own task event: %+v, %v", got, err)
	}
}

func TestMarkedUnblockEventLeavesAttention(t *testing.T) {
	t.Parallel()
	s, _, _ := attentionFixture(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "t"})
	insertTaskEvent(t, s.DB, tk.ID, "2026-02-01T00:00:00Z", tasks.EventTaskBlockerResolved, "system", `{"auto":true}`)
	var id int64
	if err := s.DB.QueryRow(`SELECT MAX(id) FROM task_events WHERE task_id = ?`, tk.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	must(t, unread.MarkEvent(s.DB, unread.TaskEventID(id), "2026-02-01T00:00:00Z"))
	_, ts, _, _, err := s.AttentionInput("")
	if err != nil {
		t.Fatal(err)
	}
	if findTask(t, ts, "t").UnblockedUnread {
		t.Fatalf("task %s: a marked unblock must not read as unread", strconv.FormatInt(tk.ID, 10))
	}
}

func TestMarkedEventIsNotNotified(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "e2", "2099-01-02T00:00:00Z", "github", "pr", "o/r#1")
	must(t, unread.MarkEvent(conn, "e2", "2099-01-02T00:00:00Z"))
	got, _, err := readNewEvents(conn, notifyCursor{ts: "2098-01-01T00:00:00Z", seen: map[string]bool{}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].id != "e1" {
		t.Fatalf("events = %+v, want only e1", got)
	}
}
