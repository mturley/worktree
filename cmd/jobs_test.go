package cmd

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
)

// stubPidAlive makes pidAlive true only for the given pids.
func stubPidAlive(t *testing.T, alive ...int) {
	t.Helper()
	old := pidAlive
	t.Cleanup(func() { pidAlive = old })
	pidAlive = func(pid int) bool {
		for _, p := range alive {
			if p == pid {
				return true
			}
		}
		return false
	}
}

type jobSeed struct {
	id, title, state string
	pid              int
}

// seedJobs selects a fresh DB through WORKTREE_DB and inserts the rows, each
// with a done step and a second step that is running (needs_force when the
// job is parked on a question).
func seedJobs(t *testing.T, rows ...jobSeed) {
	t.Helper()
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for i, r := range rows {
		steps := `[{"key":"a","label":"Prepare","status":"done"},{"key":"b","label":"Remove worktree directory","status":"running"}]`
		if r.state == "needs_answer" {
			steps = `[{"key":"a","label":"Prepare","status":"done"},{"key":"b","label":"Remove worktree directory","status":"needs_force"}]`
		}
		created := "2026-01-01T00:00:0" + string(rune('0'+i)) + "Z"
		if _, err := conn.Exec(`INSERT INTO jobs (id, kind, title, target, request, state, steps, error, pid, created_at, updated_at)
			VALUES (?, 'k', ?, 't', '{}', ?, ?, '', ?, ?, ?)`,
			r.id, r.title, r.state, steps, r.pid, created, created); err != nil {
			t.Fatal(err)
		}
	}
}

func TestJobsListsUnfinished(t *testing.T) {
	stubPidAlive(t, 111)
	seedJobs(t,
		jobSeed{"j1", "Delete worktree foo", "running", 111},
		jobSeed{"j2", "New worktree x", "needs_answer", 222},
		jobSeed{"j3", "Old", "failed", 111},
	)
	out, err := runCLI(t, "jobs")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	// The parked job has no running step, so it reads as its state.
	want := "Delete worktree foo — Remove worktree directory\nNew worktree x — needs_answer\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

func TestJobsRunningFiltersDeadPid(t *testing.T) {
	stubPidAlive(t)
	seedJobs(t, jobSeed{"j1", "Delete worktree foo", "running", 111})
	out, err := runCLI(t, "jobs", "--running")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if out != "" {
		t.Fatalf("want no output, got %q", out)
	}
}

func TestJobsJSONShape(t *testing.T) {
	stubPidAlive(t, 111)
	seedJobs(t,
		jobSeed{"j1", "Delete worktree foo", "running", 111},
		jobSeed{"j2", "New worktree x", "running", 222},
	)
	out, err := runCLI(t, "jobs", "--json")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var list []map[string]json.RawMessage
	decodeEnvelope(t, out, "jobs", &list)
	if len(list) != 2 {
		t.Fatalf("jobs = %v\n%s", list, out)
	}
	for _, k := range []string{"id", "kind", "title", "state", "live", "current_step", "created_at"} {
		if _, ok := list[0][k]; !ok {
			t.Fatalf("missing %q: %s", k, out)
		}
	}
	if string(list[0]["live"]) != "true" || string(list[1]["live"]) != "false" {
		t.Fatalf("live = %s, %s", list[0]["live"], list[1]["live"])
	}
	if string(list[0]["current_step"]) != `"Remove worktree directory"` {
		t.Fatalf("current_step = %s", list[0]["current_step"])
	}

	seedJobs(t)
	out, err = runCLI(t, "jobs", "--json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"jobs":[]`) {
		t.Fatalf("want empty array, got %s", out)
	}
}

func TestJobsNoDatabase(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "missing.db"))
	for _, args := range [][]string{{"jobs"}, {"jobs", "--running"}} {
		out, err := runCLI(t, args...)
		if err != nil || out != "" {
			t.Fatalf("%v: err=%v out=%q", args, err, out)
		}
	}
	out, err := runCLI(t, "jobs", "--json")
	if err != nil || !strings.Contains(out, `"jobs":[]`) {
		t.Fatalf("err=%v out=%q", err, out)
	}
}
