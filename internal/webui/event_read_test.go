package webui

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/testgit"
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
	must(t, unread.SetEventMark(s.DB, unread.TaskEventID(id), "2026-02-01T00:00:00Z", unread.StateRead))
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
	must(t, unread.SetEventMark(conn, "e2", "2099-01-02T00:00:00Z", unread.StateRead))
	got, _, err := readNewEvents(conn, notifyCursor{ts: "2098-01-01T00:00:00Z", seen: map[string]bool{}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].id != "e1" {
		t.Fatalf("events = %+v, want only e1", got)
	}
}

func postEventUnread(t *testing.T, base, body string) (int, eventReadResponse) {
	t.Helper()
	resp, err := http.Post(base+"/api/event-unread", "application/json", strings.NewReader(body))
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

func restoreBody(t *testing.T, ch EventReadChange) string {
	t.Helper()
	b, err := json.Marshal(ch)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// p1 sits at its cursor. Marked unread it reads unread everywhere, then the
// undo puts it back.
func TestMarkEventUnreadBehindTheCursor(t *testing.T) {
	t.Parallel()
	conn, wt := unreadOnlyFixture(t)
	s := &Server{DB: conn}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	code, got := postEventUnread(t, ts.URL, `{"id":"p1","ts":"2099-01-01T00:00:00Z"}`)
	if code != http.StatusOK || !got.Changed || got.Previous != "" {
		t.Fatalf("mark: %d %+v", code, got)
	}
	want := []string{"p3", "s1", "p2", "p1"}
	if got := unreadIDs(getTimeline(t, ts.URL, "/api/timeline?limit=100").Events); !sameIDs(got, want) {
		t.Fatalf("unread flags = %v", got)
	}
	if got := eventIDs(getTimeline(t, ts.URL, "/api/timeline?limit=100&unread_only=true").Events); !sameIDs(got, want) {
		t.Fatalf("unread_only = %v", got)
	}
	dtos, err := s.WorktreeResources(wt)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range dtos {
		if d.Type == "pr" && d.UnreadCount != 3 {
			t.Fatalf("pr count = %d", d.UnreadCount)
		}
	}

	if code := postJSON(t, ts.URL+"/api/event-read/restore", restoreBody(t, got)); code != http.StatusNoContent {
		t.Fatalf("restore: %d", code)
	}
	if got := unreadIDs(getTimeline(t, ts.URL, "/api/timeline?limit=100").Events); !sameIDs(got, []string{"p3", "s1", "p2"}) {
		t.Fatalf("after undo = %v", got)
	}
}

// A no-cursor resource's event can be marked unread too.
func TestMarkEventUnreadWithoutACursorRow(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	s := &Server{DB: conn}
	if got, err := s.MarkEventUnread("j1", ""); err != nil || !got.Changed {
		t.Fatalf("%+v, %v", got, err)
	}
	events, err := s.Timeline(TimelineQuery{UnreadOnly: true, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if !sameIDs(eventIDs(events), []string{"p3", "s1", "p2", "j1"}) {
		t.Fatalf("unread = %v", eventIDs(events))
	}
}

// Toggling writes the least it can: past the cursor an event is already
// unread, so marking it unread only removes a read mark, and undo restores it.
func TestMarkUnreadOverAReadMarkAndBack(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	s := &Server{DB: conn}
	if _, err := s.MarkEventRead("p3", ""); err != nil {
		t.Fatal(err)
	}
	got, err := s.MarkEventUnread("p3", "")
	if err != nil || !got.Changed || got.Previous != unread.StateRead {
		t.Fatalf("%+v, %v", got, err)
	}
	if marks, _ := unread.EventMarks(conn); len(marks) != 0 {
		t.Fatalf("marks = %+v, want none: the cursor already says unread", marks)
	}
	if _, err := s.RestoreEventRead(got.ID, got.TS, got.Previous); err != nil {
		t.Fatal(err)
	}
	marks, _ := unread.EventMarks(conn)
	if marks["p3"].State != unread.StateRead {
		t.Fatalf("marks = %+v", marks)
	}
}

// And the reverse: behind the cursor, mark read just takes the unread mark off.
func TestMarkReadOverAnUnreadMarkAndBack(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	s := &Server{DB: conn}
	if _, err := s.MarkEventUnread("p1", ""); err != nil {
		t.Fatal(err)
	}
	got, err := s.MarkEventRead("p1", "")
	if err != nil || !got.Changed || got.Previous != unread.StateUnread {
		t.Fatalf("%+v, %v", got, err)
	}
	if marks, _ := unread.EventMarks(conn); len(marks) != 0 {
		t.Fatalf("marks = %+v", marks)
	}
	if _, err := s.RestoreEventRead(got.ID, got.TS, got.Previous); err != nil {
		t.Fatal(err)
	}
	if marks, _ := unread.EventMarks(conn); marks["p1"].State != unread.StateUnread {
		t.Fatalf("marks = %+v", marks)
	}
}

func TestMarkEventUnreadIsANoOpOnAnUnreadEvent(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	got, err := (&Server{DB: conn}).MarkEventUnread("p3", "")
	if err != nil || got.Changed {
		t.Fatalf("%+v, %v", got, err)
	}
	if marks, _ := unread.EventMarks(conn); len(marks) != 0 {
		t.Fatalf("marks = %+v", marks)
	}
}

func TestMarkEventUnreadRefusals(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	insertUnreadEvent(t, conn, "mine", "2098-01-01T00:00:00Z", "github", "pr", "o/r#1")
	if _, err := conn.Exec(`UPDATE watcher_events SET author_id='101' WHERE id='mine'`); err != nil {
		t.Fatal(err)
	}
	must(t, selfid.Set(conn, "github", "101"))
	insertUnreadEvent(t, conn, "running", "2098-01-01T00:00:01Z", "github", "pr", "o/r#1")
	if _, err := conn.Exec(`UPDATE watcher_events SET type='ci_pending' WHERE id='running'`); err != nil {
		t.Fatal(err)
	}
	insertUnreadEvent(t, conn, "gone", "2098-01-01T00:00:02Z", "github", "pr", "o/r#99")

	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()
	for _, c := range []struct {
		name, body string
		want       int
	}{
		{"missing id", `{}`, http.StatusBadRequest},
		{"unknown", `{"id":"nope"}`, http.StatusNotFound},
		{"slack", `{"id":"s2"}`, http.StatusBadRequest},
		{"own event", `{"id":"mine"}`, http.StatusBadRequest},
		{"running CI", `{"id":"running"}`, http.StatusBadRequest},
		{"no worktree follows it", `{"id":"gone"}`, http.StatusBadRequest},
		{"rewritten", `{"id":"p1","ts":"2098-06-01T00:00:00Z"}`, http.StatusConflict},
	} {
		if code, _ := postEventUnread(t, ts.URL, c.body); code != c.want {
			t.Errorf("%s: status %d, want %d", c.name, code, c.want)
		}
	}
	if marks, _ := unread.EventMarks(conn); len(marks) != 0 {
		t.Fatalf("marks = %+v", marks)
	}
}

func TestTimelineSaysWhichEventsCanBeMarkedUnread(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	insertUnreadEvent(t, conn, "mine", "2098-01-01T00:00:00Z", "github", "pr", "o/r#1")
	if _, err := conn.Exec(`UPDATE watcher_events SET author_id='101' WHERE id='mine'`); err != nil {
		t.Fatal(err)
	}
	must(t, selfid.Set(conn, "github", "101"))
	insertUnreadEvent(t, conn, "running", "2098-01-01T00:00:01Z", "github", "pr", "o/r#1")
	if _, err := conn.Exec(`UPDATE watcher_events SET type='ci_pending' WHERE id='running'`); err != nil {
		t.Fatal(err)
	}
	events, err := (&Server{DB: conn}).Timeline(TimelineQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, e := range events {
		got[e.ID] = e.CanMarkUnread
	}
	for id, want := range map[string]bool{"p1": true, "p3": true, "j1": true, "s1": false, "mine": false, "running": false} {
		if got[id] != want {
			t.Errorf("%s: can_mark_unread = %v, want %v", id, got[id], want)
		}
	}
}

// Mark all read's HTTP round trip: the only unread is an old marked event, so
// the cursor stays put, yet the response carries an undo.
func TestResourceReadClearsAndRestoresUnreadMarks(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	wt := testgit.Worktree(t)
	must(t, resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}))
	insertUnreadEvent(t, conn, "older", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	insertUnreadEvent(t, conn, "newer", "2099-01-05T00:00:00Z", "github", "pr", "o/r#1")
	must(t, unread.MarkRead(conn, "pr", "o/r#1", "2099-01-05T00:00:00Z"))
	s := &Server{DB: conn}
	if _, err := s.MarkEventUnread("older", ""); err != nil {
		t.Fatal(err)
	}
	dtos, err := s.WorktreeResources(wt)
	if err != nil || len(dtos) != 1 || dtos[0].UnreadCount != 1 || dtos[0].UnreadThroughTS != "2099-01-01T00:00:00Z" {
		t.Fatalf("before: %+v %v", dtos, err)
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp := postResourceRead(t, ts.URL, `{"type":"pr","id":"o/r#1","through_ts":"2099-01-01T00:00:00Z"}`)
	var ch resourceReadResponse
	if err := json.NewDecoder(resp.Body).Decode(&ch); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(ch.ClearedUnread) != 1 || ch.ClearedUnread[0].ID != "older" {
		t.Fatalf("response = %+v", ch)
	}
	dtos, _ = s.WorktreeResources(wt)
	if dtos[0].UnreadCount != 0 {
		t.Fatalf("after mark: count %d", dtos[0].UnreadCount)
	}
	body, _ := json.Marshal(map[string]any{"type": "pr", "id": "o/r#1", "last_read_ts": ch.LastReadTS, "previous_ts": ch.PreviousTS, "cleared_unread": ch.ClearedUnread})
	if code := postJSON(t, ts.URL+"/api/resource-read/restore", string(body)); code != http.StatusNoContent {
		t.Fatalf("restore: %d", code)
	}
	dtos, _ = s.WorktreeResources(wt)
	if dtos[0].UnreadCount != 1 {
		t.Fatalf("after undo: count %d", dtos[0].UnreadCount)
	}
}

func TestTaskReadClearsAndRestoresUnreadMarks(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	insertTaskEvent(t, f.s.DB, f.both.ID, tts(1), "task_updated", "agent", "")
	insertTaskEvent(t, f.s.DB, f.both.ID, tts(5), "task_updated", "agent", "")
	taskID := strconv.FormatInt(f.both.ID, 10)
	must(t, unread.MarkRead(f.s.DB, "task", taskID, tts(5)))
	var oldest int64
	if err := f.s.DB.QueryRow(`SELECT MIN(id) FROM task_events WHERE task_id = ?`, f.both.ID).Scan(&oldest); err != nil {
		t.Fatal(err)
	}
	if got, err := f.s.MarkEventUnread(unread.TaskEventID(oldest), ""); err != nil || !got.Changed {
		t.Fatalf("%+v %v", got, err)
	}
	rec := serveAll(t, f.s, "POST", "/api/task-read", map[string]any{"id": f.both.ID, "through_ts": tts(1)})
	var ch resourceReadResponse
	if err := json.NewDecoder(rec.Body).Decode(&ch); err != nil {
		t.Fatal(err)
	}
	if len(ch.ClearedUnread) != 1 {
		t.Fatalf("response %d = %+v", rec.Code, ch)
	}
	sums, _ := unread.TaskSummaries(f.s.DB)
	if sums[f.both.ID].Count != 0 {
		t.Fatalf("after mark: %+v", sums[f.both.ID])
	}
	rec = serveAll(t, f.s, "POST", "/api/task-read/restore", map[string]any{"id": f.both.ID, "last_read_ts": ch.LastReadTS, "previous_ts": ch.PreviousTS, "cleared_unread": ch.ClearedUnread})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("restore: %d", rec.Code)
	}
	sums, _ = unread.TaskSummaries(f.s.DB)
	if sums[f.both.ID].Count != 1 {
		t.Fatalf("after undo: %+v", sums[f.both.ID])
	}
}

func TestMarkTaskEventUnreadBehindTheCursor(t *testing.T) {
	t.Parallel()
	f := taskUnreadFixture(t)
	f.seed(t)
	must(t, unread.MarkRead(f.s.DB, "task", strconv.FormatInt(f.both.ID, 10), tts(5)))
	var oldest, mine int64
	if err := f.s.DB.QueryRow(`SELECT MIN(id) FROM task_events WHERE task_id = ?`, f.both.ID).Scan(&oldest); err != nil {
		t.Fatal(err)
	}
	if err := f.s.DB.QueryRow(`SELECT id FROM task_events WHERE actor = 'user' LIMIT 1`).Scan(&mine); err != nil {
		t.Fatal(err)
	}
	id := unread.TaskEventID(oldest)
	if got, err := f.s.MarkEventUnread(id, ""); err != nil || !got.Changed {
		t.Fatalf("%+v %v", got, err)
	}
	events, err := f.s.Timeline(TimelineQuery{UnreadOnly: true, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		found = found || e.ID == id
	}
	if !found {
		t.Fatalf("%s not in the unread feed: %v", id, eventIDs(events))
	}
	if _, err := f.s.MarkEventUnread(unread.TaskEventID(mine), ""); !errors.Is(err, unread.ErrNeverUnread) {
		t.Fatalf("own task event: %v", err)
	}
	all, err := f.s.Timeline(TimelineQuery{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range all {
		if e.ID == unread.TaskEventID(mine) && e.CanMarkUnread {
			t.Fatal("own task event offered Mark unread")
		}
		if e.ID == id && !e.CanMarkUnread {
			t.Fatal("agent task event not offered Mark unread")
		}
	}
}

func TestUnblockEventMarkedUnreadBehindTheCursorIsInAttention(t *testing.T) {
	t.Parallel()
	s, _, _ := attentionFixture(t)
	tk := mustTask(t, s, tasks.NewTask{Title: "t"})
	insertTaskEvent(t, s.DB, tk.ID, "2026-02-01T00:00:00Z", tasks.EventTaskBlockerResolved, "system", `{"auto":true}`)
	must(t, unread.MarkRead(s.DB, "task", strconv.FormatInt(tk.ID, 10), "2026-03-01T00:00:00Z"))
	var id int64
	if err := s.DB.QueryRow(`SELECT MAX(id) FROM task_events WHERE task_id = ?`, tk.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	must(t, unread.SetEventMark(s.DB, unread.TaskEventID(id), "2026-02-01T00:00:00Z", unread.StateUnread))
	_, ts, _, _, err := s.AttentionInput("")
	if err != nil {
		t.Fatal(err)
	}
	if !findTask(t, ts, "t").UnblockedUnread {
		t.Fatal("an old unblock marked unread must read as unread")
	}
}

// Marking and taking back must not make an already-seen event look new to the
// notifier, whose lookback re-reads recent rows on every pass.
func TestNotifierDoesNotRenotifyAfterAMarkIsTakenBack(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	c := notifyCursor{ts: "2098-01-01T00:00:00Z", seen: map[string]bool{}}
	got, c, err := readNewEvents(conn, c)
	if err != nil || len(got) != 1 {
		t.Fatalf("first pass: %+v %v", got, err)
	}
	must(t, unread.SetEventMark(conn, "e1", "2099-01-01T00:00:00Z", unread.StateRead))
	got, c, err = readNewEvents(conn, c)
	if err != nil || len(got) != 0 {
		t.Fatalf("while marked: %+v %v", got, err)
	}
	if _, err := unread.UnmarkEvent(conn, "e1", ""); err != nil {
		t.Fatal(err)
	}
	if got, _, err := readNewEvents(conn, c); err != nil || len(got) != 0 {
		t.Fatalf("after unmark: %+v %v", got, err)
	}
}

// Marking an old event unread never notifies: it is not news.
func TestMarkedUnreadEventIsNotNotified(t *testing.T) {
	t.Parallel()
	conn := unreadTestDB(t)
	insertUnreadEvent(t, conn, "e1", "2099-01-01T00:00:00Z", "github", "pr", "o/r#1")
	c := notifyCursor{ts: "2099-01-01T00:00:00Z", seen: map[string]bool{}}
	_, c, err := readNewEvents(conn, c)
	if err != nil {
		t.Fatal(err)
	}
	must(t, unread.SetEventMark(conn, "e1", "2099-01-01T00:00:00Z", unread.StateUnread))
	if got, _, err := readNewEvents(conn, c); err != nil || len(got) != 0 {
		t.Fatalf("%+v %v", got, err)
	}
}

// insertBotDescriptionEdit adds a bot's PR description edit to o/r#1, past
// unreadOnlyFixture's cursor.
func insertBotDescriptionEdit(t *testing.T, conn *sql.DB, id, ts string) {
	t.Helper()
	insertTypedEvent(t, conn, id, ts, "pr_description_changed", "x", "pr", "o/r#1")
	if _, err := conn.Exec(`UPDATE watcher_events SET author_type = 'bot' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
}

// A bot's description edit is never unread on its own, but it can still be
// marked so.
func TestMarkEventUnread_BotDescriptionEditAllowed(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	insertBotDescriptionEdit(t, conn, "botdesc", "2099-01-09T00:00:00Z")
	s := &Server{DB: conn}

	events, err := s.Timeline(TimelineQuery{Limit: 100})
	must(t, err)
	found := false
	for _, e := range events {
		if e.ID == "botdesc" {
			found = true
			if e.Unread || !e.CanMarkUnread {
				t.Fatalf("before: unread=%v can_mark_unread=%v, want false/true", e.Unread, e.CanMarkUnread)
			}
		}
	}
	if !found {
		t.Fatalf("before: botdesc missing from timeline %v", eventIDs(events))
	}
	got, err := s.MarkEventUnread("botdesc", "2099-01-09T00:00:00Z")
	if err != nil || !got.Changed {
		t.Fatalf("mark unread: %+v, %v", got, err)
	}
	events, err = s.Timeline(TimelineQuery{UnreadOnly: true, Limit: 100})
	must(t, err)
	if !sameIDs(eventIDs(events), []string{"botdesc", "p3", "s1", "p2"}) {
		t.Fatalf("unread after mark = %v", eventIDs(events))
	}
}

func TestTimeline_UnreadOnlyExcludesBotDescriptionEdit(t *testing.T) {
	t.Parallel()
	conn, wt := unreadOnlyFixture(t)
	insertBotDescriptionEdit(t, conn, "botdesc", "2099-01-09T00:00:00Z")
	s := &Server{DB: conn}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	want := []string{"p3", "s1", "p2"}
	for _, path := range []string{
		"/api/timeline?limit=100&unread_only=true",
		"/api/worktree-timeline?limit=100&unread_only=true&path=" + url.QueryEscape(wt),
	} {
		if got := eventIDs(getTimeline(t, ts.URL, path).Events); !sameIDs(got, want) {
			t.Errorf("%s = %v, want %v", path, got, want)
		}
	}
	if got := unreadIDs(getTimeline(t, ts.URL, "/api/timeline?limit=100").Events); !sameIDs(got, want) {
		t.Errorf("unread flags = %v, want %v", got, want)
	}
}
