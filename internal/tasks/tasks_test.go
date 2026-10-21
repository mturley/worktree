package tasks

import (
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"sort"
	"sync"
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
	if _, err := Delete(conn, user, b.ID); err != nil {
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
	eventID, err := Delete(conn, user, tk.ID)
	if err != nil {
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
	if eventID == 0 || eventID != ev[0].ID {
		t.Fatalf("Delete returned event id %d, want the task_deleted event %d", eventID, ev[0].ID)
	}
	if id, err := Delete(conn, user, tk.ID); !errors.Is(err, ErrNotFound) || id != 0 {
		t.Fatalf("second Delete = %d, %v", id, err)
	}
	if _, err := SetState(conn, user, tk.ID, StateDone); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetState on deleted err = %v", err)
	}
}

// TestConcurrentWritersAcrossConnections drives writes from two separate
// pools on one file, as the CLI and `worktree ui` do. A deferred BEGIN that
// reads before writing fails its lock upgrade at once with "database is
// locked"; BEGIN IMMEDIATE waits under busy_timeout instead.
func TestConcurrentWritersAcrossConnections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "w.db")
	var conns []*sql.DB
	for i := 0; i < 2; i++ {
		c, err := wdb.OpenAt(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		conns = append(conns, c)
	}
	const workers, perWorker = 4, 10
	total := len(conns) * workers * perWorker
	var wg sync.WaitGroup
	errs := make(chan error, 2*total)
	idCh := make(chan int64, total)
	for _, c := range conns {
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func(c *sql.DB) {
				defer wg.Done()
				for i := 0; i < perWorker; i++ {
					tk, err := Create(c, user, NewTask{Title: "t"})
					if err != nil {
						errs <- err
						continue
					}
					idCh <- tk.ID
					if _, err := SetState(c, user, tk.ID, StateInProgress); err != nil {
						errs <- err
					}
				}
			}(c)
		}
	}
	wg.Wait()
	close(errs)
	close(idCh)
	for err := range errs {
		t.Errorf("concurrent write: %v", err)
	}
	seen := map[int64]bool{}
	for id := range idCh {
		if seen[id] {
			t.Errorf("duplicate id %d", id)
		}
		seen[id] = true
	}
	if len(seen) != total {
		t.Errorf("created %d tasks, want %d", len(seen), total)
	}
}

func TestCreatePlacement(t *testing.T) {
	conn := newDB(t)
	a, b, c := mustCreate(t, conn, "A"), mustCreate(t, conn, "B"), mustCreate(t, conn, "C")
	d, err := Create(conn, user, NewTask{Title: "D", After: a.ID})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := masterOrder(t, conn), []int64{a.ID, d.ID, b.ID, c.ID}; !equalIDs(got, want) {
		t.Fatalf("after: order = %v, want %v", got, want)
	}
	e, err := Create(conn, user, NewTask{Title: "E", Before: a.ID})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := masterOrder(t, conn), []int64{e.ID, a.ID, d.ID, b.ID, c.ID}; !equalIDs(got, want) {
		t.Fatalf("before: order = %v, want %v", got, want)
	}

	n := count(t, conn, "tasks")
	if _, err := Create(conn, user, NewTask{Title: "F", After: a.ID, Before: b.ID}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("both set: err = %v, want ErrInvalid", err)
	}
	if _, err := Create(conn, user, NewTask{Title: "G", After: 9999}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing after: err = %v, want ErrNotFound", err)
	}
	if _, err := Create(conn, user, NewTask{Title: "H", Before: 9999}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing before: err = %v, want ErrNotFound", err)
	}
	if got := count(t, conn, "tasks"); got != n {
		t.Fatalf("rejected creates wrote rows: %d -> %d", n, got)
	}
}

func TestCreatePlacementAroundDeletedNeighbour(t *testing.T) {
	conn := newDB(t)
	a, b, c := mustCreate(t, conn, "A"), mustCreate(t, conn, "B"), mustCreate(t, conn, "C")
	if _, err := Delete(conn, user, b.ID); err != nil {
		t.Fatal(err)
	}
	// As MoveAfter: the deleted B keeps its slot right after A.
	d, err := Create(conn, user, NewTask{Title: "D", After: a.ID})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := masterOrder(t, conn), []int64{a.ID, d.ID, b.ID, c.ID}; !equalIDs(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func equalIDs(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func mustVersion(t *testing.T, conn *sql.DB) int64 {
	t.Helper()
	v, err := Version(conn)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestVersionBumpsOnEveryWrite(t *testing.T) {
	conn := newDB(t)
	v0 := mustVersion(t, conn)
	a := mustCreate(t, conn, "A")
	if v := mustVersion(t, conn); v != v0+1 {
		t.Fatalf("after Create: v = %d, want %d", v, v0+1)
	}
	b := mustCreate(t, conn, "B")
	v1 := mustVersion(t, conn)
	if err := MoveToTop(conn, b.ID); err != nil {
		t.Fatal(err)
	}
	if v := mustVersion(t, conn); v != v1+1 {
		t.Fatalf("after MoveToTop: v = %d, want %d", v, v1+1)
	}
	s1, err := AddSubtask(conn, user, a.ID, "one")
	if err != nil {
		t.Fatal(err)
	}
	s2, err := AddSubtask(conn, user, a.ID, "two")
	if err != nil {
		t.Fatal(err)
	}
	v2 := mustVersion(t, conn)
	if err := SetSubtaskOrder(conn, a.ID, []int64{s2.ID, s1.ID}); err != nil {
		t.Fatal(err)
	}
	if v := mustVersion(t, conn); v != v2+1 {
		t.Fatalf("after SetSubtaskOrder: v = %d, want %d", v, v2+1)
	}
	v3 := mustVersion(t, conn)
	if _, err := SetState(conn, user, a.ID, StateNotStarted); err != nil {
		t.Fatal(err)
	}
	if v := mustVersion(t, conn); v != v3 {
		t.Fatalf("no-op SetState bumped: v = %d, want %d", v, v3)
	}
	same := "A"
	if _, err := Update(conn, user, a.ID, Patch{Title: &same}); err != nil {
		t.Fatal(err)
	}
	if v := mustVersion(t, conn); v != v3 {
		t.Fatalf("no-op Update bumped: v = %d, want %d", v, v3)
	}
	// A failed write rolls back, bump included.
	if _, err := SetState(conn, user, 9999, StateDone); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
	if v := mustVersion(t, conn); v != v3 {
		t.Fatalf("failed write bumped: v = %d, want %d", v, v3)
	}
	if _, err := SetState(conn, user, a.ID, StateDone); err != nil {
		t.Fatal(err)
	}
	if v := mustVersion(t, conn); v != v3+1 {
		t.Fatalf("after SetState: v = %d, want %d", v, v3+1)
	}
}
