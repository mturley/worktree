package tasks

import (
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"sort"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
)

var user = Actor{Kind: ActorUser}

func newDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func count(t *testing.T, conn *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func mustCreate(t *testing.T, conn *sql.DB, title string) Task {
	t.Helper()
	tk, err := Create(conn, user, NewTask{Title: title})
	if err != nil {
		t.Fatal(err)
	}
	return tk
}

func TestCreateGetDefaults(t *testing.T) {
	conn := newDB(t)
	tk, err := Create(conn, user, NewTask{Title: "Write repro"})
	if err != nil {
		t.Fatal(err)
	}
	if tk.ID <= 0 || tk.State != StateNotStarted || tk.Priority != PriorityNone || tk.Starred || tk.Rank == "" {
		t.Fatalf("defaults wrong: %+v", tk)
	}
	if tk.CreatedAt == "" || tk.UpdatedAt == "" || tk.StartedAt != "" || tk.CompletedAt != "" || tk.Due != "" {
		t.Fatalf("timestamps wrong: %+v", tk)
	}
	got, err := Get(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != tk.Title || got.State != tk.State || got.Rank != tk.Rank || got.Priority != tk.Priority {
		t.Fatalf("Get = %+v, want %+v", got, tk)
	}
}

func TestCreateTrimsAndStoresFields(t *testing.T) {
	conn := newDB(t)
	tk, err := Create(conn, user, NewTask{Title: "  x  ", Description: "d", Priority: PriorityHigh, Starred: true, Due: "2026-11-02"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := Get(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "x" || got.Description != "d" || got.Priority != PriorityHigh || !got.Starred || got.Due != "2026-11-02" {
		t.Fatalf("got %+v", got)
	}
}

func TestGetMissing(t *testing.T) {
	conn := newDB(t)
	if _, err := Get(conn, 999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestCreateAppendsAtBottom(t *testing.T) {
	conn := newDB(t)
	a := mustCreate(t, conn, "a")
	b := mustCreate(t, conn, "b")
	c := mustCreate(t, conn, "c")
	if !(a.Rank < b.Rank && b.Rank < c.Rank) {
		t.Fatalf("ranks not increasing: %q %q %q", a.Rank, b.Rank, c.Rank)
	}
}

func TestCreateRankCountsDeletedRows(t *testing.T) {
	conn := newDB(t)
	a := mustCreate(t, conn, "a")
	b := mustCreate(t, conn, "b")
	if err := Delete(conn, user, b.ID); err != nil {
		t.Fatal(err)
	}
	c := mustCreate(t, conn, "c")
	if !(a.Rank < b.Rank && b.Rank < c.Rank) {
		t.Fatalf("new rank %q collides with deleted %q", c.Rank, b.Rank)
	}
}

func TestSetStateTimestamps(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "t")

	sc, err := SetState(conn, user, tk.ID, StateInProgress)
	if err != nil {
		t.Fatal(err)
	}
	if sc.From != StateNotStarted || sc.To != StateInProgress || sc.StartedAt == "" || sc.CompletedAt != "" ||
		sc.PrevStartedAt != "" || sc.PrevCompletedAt != "" || sc.EventID == 0 {
		t.Fatalf("-> in_progress: %+v", sc)
	}
	started := sc.StartedAt

	sc, err = SetState(conn, user, tk.ID, StateDone)
	if err != nil {
		t.Fatal(err)
	}
	if sc.From != StateInProgress || sc.To != StateDone || sc.StartedAt != started || sc.CompletedAt == "" ||
		sc.PrevStartedAt != started || sc.PrevCompletedAt != "" || sc.EventID == 0 {
		t.Fatalf("-> done: %+v", sc)
	}
	completed := sc.CompletedAt

	sc, err = SetState(conn, user, tk.ID, StateInProgress)
	if err != nil {
		t.Fatal(err)
	}
	if sc.From != StateDone || sc.StartedAt != started || sc.CompletedAt != "" ||
		sc.PrevStartedAt != started || sc.PrevCompletedAt != completed {
		t.Fatalf("done -> in_progress: %+v", sc)
	}

	sc, err = SetState(conn, user, tk.ID, StateNotStarted)
	if err != nil {
		t.Fatal(err)
	}
	if sc.From != StateInProgress || sc.To != StateNotStarted || sc.StartedAt != "" || sc.CompletedAt != "" ||
		sc.PrevStartedAt != started {
		t.Fatalf("-> not_started: %+v", sc)
	}
	got, err := Get(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != StateNotStarted || got.StartedAt != "" || got.CompletedAt != "" {
		t.Fatalf("stored: %+v", got)
	}

	fresh := mustCreate(t, conn, "fresh")
	sc, err = SetState(conn, user, fresh.ID, StateDone)
	if err != nil {
		t.Fatal(err)
	}
	if sc.StartedAt == "" || sc.CompletedAt == "" {
		t.Fatalf("not_started -> done: %+v", sc)
	}
	got, err = Get(conn, fresh.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != StateDone || got.StartedAt != sc.StartedAt || got.CompletedAt != sc.CompletedAt {
		t.Fatalf("stored: %+v", got)
	}

	before := count(t, conn, "task_events")
	sc, err = SetState(conn, user, fresh.ID, StateDone)
	if err != nil {
		t.Fatal(err)
	}
	if sc.EventID != 0 || sc.From != StateDone || sc.To != StateDone {
		t.Fatalf("no-op: %+v", sc)
	}
	if after := count(t, conn, "task_events"); after != before {
		t.Fatalf("no-op wrote an event: %d -> %d", before, after)
	}

	ev, err := Events(conn, fresh.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ev[0].Type != EventTaskStateChanged {
		t.Fatalf("latest event %q", ev[0].Type)
	}
	var p struct{ From, To string }
	if err := json.Unmarshal(ev[0].Payload, &p); err != nil {
		t.Fatal(err)
	}
	if p.From != "not_started" || p.To != "done" {
		t.Fatalf("payload %s", ev[0].Payload)
	}
}

func TestRejectsInvalidInput(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "valid")
	events := count(t, conn, "task_events")

	for _, n := range []NewTask{
		{Title: "  "},
		{Title: "x", Due: "2026-13-01"},
		{Title: "x", Priority: "urgent"},
	} {
		if _, err := Create(conn, user, n); !errors.Is(err, ErrInvalid) {
			t.Errorf("Create(%+v) err = %v, want ErrInvalid", n, err)
		}
	}
	if _, err := SetState(conn, user, tk.ID, "blocked"); !errors.Is(err, ErrInvalid) {
		t.Errorf("SetState(blocked) err = %v, want ErrInvalid", err)
	}
	blank := " "
	if _, err := Update(conn, user, tk.ID, Patch{Title: &blank}); !errors.Is(err, ErrInvalid) {
		t.Errorf("Update(blank title) err = %v, want ErrInvalid", err)
	}
	if n := count(t, conn, "tasks"); n != 1 {
		t.Fatalf("tasks = %d, want 1", n)
	}
	if n := count(t, conn, "task_events"); n != events {
		t.Fatalf("task_events = %d, want %d", n, events)
	}
}

func TestUpdateRecordsChangedFieldsOnly(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "old")
	title, starred := "new", true
	got, err := Update(conn, user, tk.ID, Patch{Title: &title, Starred: &starred})
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "new" || !got.Starred {
		t.Fatalf("Update returned %+v", got)
	}
	ev, err := Events(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ev[0].Type != EventTaskEdited {
		t.Fatalf("latest event %q", ev[0].Type)
	}
	var p struct {
		Changes map[string]struct{ From, To any } `json:"changes"`
	}
	if err := json.Unmarshal(ev[0].Payload, &p); err != nil {
		t.Fatal(err)
	}
	var keys []string
	for k := range p.Changes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) != 2 || keys[0] != "starred" || keys[1] != "title" {
		t.Fatalf("changed keys %v (payload %s)", keys, ev[0].Payload)
	}
	if p.Changes["title"].From != "old" || p.Changes["title"].To != "new" ||
		p.Changes["starred"].From != false || p.Changes["starred"].To != true {
		t.Fatalf("payload %s", ev[0].Payload)
	}

	before := count(t, conn, "task_events")
	if _, err := Update(conn, user, tk.ID, Patch{Title: &title, Starred: &starred}); err != nil {
		t.Fatal(err)
	}
	if n := count(t, conn, "task_events"); n != before {
		t.Fatalf("no-op update wrote an event")
	}
}

func TestUpdateClearsDue(t *testing.T) {
	conn := newDB(t)
	tk, err := Create(conn, user, NewTask{Title: "x", Due: "2026-11-02"})
	if err != nil {
		t.Fatal(err)
	}
	none := ""
	got, err := Update(conn, user, tk.ID, Patch{Due: &none})
	if err != nil {
		t.Fatal(err)
	}
	if got.Due != "" {
		t.Fatalf("due = %q", got.Due)
	}
}

func TestDeleteHidesTask(t *testing.T) {
	conn := newDB(t)
	tk := mustCreate(t, conn, "x")
	if err := Delete(conn, user, tk.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := Get(conn, tk.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete err = %v", err)
	}
	ev, err := Events(conn, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ev) == 0 || ev[0].Type != EventTaskDeleted {
		t.Fatalf("events %+v", ev)
	}
	if err := Delete(conn, user, tk.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Delete err = %v", err)
	}
	if _, err := SetState(conn, user, tk.ID, StateDone); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetState on deleted err = %v", err)
	}
}
