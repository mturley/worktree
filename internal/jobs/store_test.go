package jobs

import (
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	wdb "github.com/mturley/worktree/internal/db"
)

func openDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func sample(id string, state State, created string) Job {
	return Job{
		ID: id, Kind: "create", Title: "Create " + id, Target: "/x",
		State: state, Steps: []Step{}, CreatedAt: created, UpdatedAt: created,
		Request: json.RawMessage(`{"path":"/x"}`), PID: 42,
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	t.Parallel()
	conn := openDB(t)
	j := sample("a", StateNeedsAnswer, "2026-01-01T00:00:00Z")
	j.Steps = []Step{
		{Key: "one", Label: "One", Status: StepDone},
		{Key: "two", Label: "Two", Status: StepNeedsForce, Detail: "dirty"},
	}
	j.Question = json.RawMessage(`{"key":"reuse_branch"}`)
	if err := save(conn, j); err != nil {
		t.Fatal(err)
	}
	got, err := load(conn, "a")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, j) {
		t.Fatalf("got %+v, want %+v", got, j)
	}
}

func TestSaveUpserts(t *testing.T) {
	t.Parallel()
	conn := openDB(t)
	j := sample("a", StateRunning, "2026-01-01T00:00:00Z")
	if err := save(conn, j); err != nil {
		t.Fatal(err)
	}
	j.State = StateFailed
	if err := save(conn, j); err != nil {
		t.Fatal(err)
	}
	list, err := all(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].State != StateFailed {
		t.Fatalf("got %+v", list)
	}
}

func TestLoadMissing(t *testing.T) {
	t.Parallel()
	if _, err := load(openDB(t), "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestRemove(t *testing.T) {
	t.Parallel()
	conn := openDB(t)
	if err := save(conn, sample("a", StateRunning, "2026-01-01T00:00:00Z")); err != nil {
		t.Fatal(err)
	}
	if err := remove(conn, "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := load(conn, "a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestUnfinishedFilters(t *testing.T) {
	t.Parallel()
	conn := openDB(t)
	states := []State{StateSucceeded, StateRunning, StateFailed, StateNeedsAnswer, StateInterrupted}
	for i, s := range states {
		ts := "2026-01-01T00:00:0" + string(rune('0'+i)) + "Z"
		if err := save(conn, sample(string(s), s, ts)); err != nil {
			t.Fatal(err)
		}
	}
	got, err := Unfinished(conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].State != StateRunning || got[1].State != StateNeedsAnswer {
		t.Fatalf("got %+v", got)
	}
}

func TestUnfinishedWithoutTable(t *testing.T) {
	t.Parallel()
	conn, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "bare.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	got, err := Unfinished(conn)
	if err != nil || got != nil {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestJobJSONShape(t *testing.T) {
	t.Parallel()
	b, err := json.Marshal(Job{Steps: []Step{}, Request: json.RawMessage(`{}`), PID: 1})
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{`"steps":[]`, `"question":null`} {
		if !strings.Contains(s, want) {
			t.Errorf("%s missing %s", s, want)
		}
	}
	for _, bad := range []string{`"request"`, `"pid"`} {
		if strings.Contains(s, bad) {
			t.Errorf("%s contains %s", s, bad)
		}
	}
}
