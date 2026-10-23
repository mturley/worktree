package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// asUser makes the CLI act as the user, whatever session runs the tests.
func asUser(t *testing.T) {
	t.Helper()
	t.Setenv("CLAUDECODE", "")
	t.Setenv("HANDLER_SESSION_ID", "")
}

// An agent may undo only an agent's change: undoing the user's is refused
// with an error exit and changes nothing; the user may undo anything.
func TestTasksUndoAgentRefusedForUserChange(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	asUser(t)
	if out, err := runTasks(t, "add", "Mine", "--global"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	userID := strconv.FormatInt(undoIDFrom(t, "state", "T1", "done", "--json"), 10)
	out, err := runTasks(t, "undo", userID, "--as-agent")
	if err == nil || !strings.Contains(err.Error(), "only the user can undo the user's changes") {
		t.Fatalf("agent undo of the user's change: err %v\n%s", err, out)
	}
	shown, _ := runTasks(t, "show", "T1", "--json")
	if !strings.Contains(shown, `"state": "done"`) && !strings.Contains(shown, `"state":"done"`) {
		t.Fatalf("a refused undo changed the task:\n%s", shown)
	}

	agentID := strconv.FormatInt(undoIDFrom(t, "state", "T1", "in_progress", "--json", "--as-agent"), 10)
	if out, err := runTasks(t, "undo", agentID, "--as-agent"); err != nil {
		t.Fatalf("agent undo of its own change: %v\n%s", err, out)
	}
	if out, err := runTasks(t, "undo", userID); err != nil {
		t.Fatalf("user undo of the user's change: %v\n%s", err, out)
	}
}

func TestTasksSubtaskCheckJSONCarriesUndoEventID(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	if out, err := runTasks(t, "add", "A", "--global"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	if out, err := runTasks(t, "subtask", "add", "T1", "a"); err != nil {
		t.Fatalf("subtask add: %v\n%s", err, out)
	}
	id := undoIDFrom(t, "subtask", "check", "1", "--json")
	if id == 0 {
		t.Fatal("subtask check --json has no undo_event_id")
	}
	if id := undoIDFrom(t, "subtask", "check", "1", "--json"); id != 0 {
		t.Fatalf("a no-op check carried undo_event_id %d", id)
	}
	if out, err := runTasks(t, "undo", strconv.FormatInt(id, 10)); err != nil {
		t.Fatalf("undo: %v\n%s", err, out)
	}
	if id := undoIDFrom(t, "subtask", "uncheck", "1", "--json"); id != 0 {
		t.Fatalf("a no-op uncheck carried undo_event_id %d", id)
	}
}

// A failing undo prints its error once, with no usage block, and exits 1.
// The process is re-run as a child so Execute's own printing and exit are
// what is checked.
func TestTasksUndoConflictPrintsOnce(t *testing.T) {
	if args := os.Getenv("WORKTREE_TEST_EXECUTE_ARGS"); args != "" {
		rootCmd.SetArgs(strings.Fields(args))
		Execute()
		os.Exit(0)
	}
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	if out, err := runTasks(t, "add", "A", "--global"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}
	id := strconv.FormatInt(undoIDFrom(t, "state", "T1", "done", "--json"), 10)
	if out, err := runTasks(t, "undo", id); err != nil {
		t.Fatalf("undo: %v\n%s", err, out)
	}

	child := exec.Command(os.Args[0], "-test.run=^TestTasksUndoConflictPrintsOnce$")
	child.Env = append(os.Environ(), "WORKTREE_TEST_EXECUTE_ARGS=tasks undo "+id)
	var stdout, stderr bytes.Buffer
	child.Stdout, child.Stderr = &stdout, &stderr
	err := child.Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 {
		t.Fatalf("second undo: err %v, want exit 1\nstdout: %s\nstderr: %s", err, stdout.String(), stderr.String())
	}
	if got := stderr.String(); got != "changed since; nothing was undone\n" {
		t.Fatalf("stderr = %q, want the error once", got)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q, want nothing", stdout.String())
	}
}

// undoIDFrom runs a --json command and returns its undo_event_id, 0 if absent.
func undoIDFrom(t *testing.T, args ...string) int64 {
	t.Helper()
	out, err := runTasks(t, args...)
	if err != nil {
		t.Fatalf("%v: %v\n%s", args, err, out)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("%v json: %v\n%s", args, err, out)
	}
	id, _ := m["undo_event_id"].(float64)
	return int64(id)
}

func TestTasksUndoCLI(t *testing.T) {
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	if out, err := runTasks(t, "add", "Undo me", "--global"); err != nil {
		t.Fatalf("add: %v\n%s", err, out)
	}

	if id := undoIDFrom(t, "state", "T1", "not_started", "--json"); id != 0 {
		t.Fatalf("a no-op state change carried undo_event_id %d", id)
	}
	id := undoIDFrom(t, "state", "T1", "done", "--json")
	if id == 0 {
		t.Fatal("state --json has no undo_event_id")
	}
	arg := strconv.FormatInt(id, 10)

	if out, err := runTasks(t, "undo", arg); err != nil || strings.TrimSpace(out) != "Undone." {
		t.Fatalf("undo: %v\n%s", err, out)
	}
	out, _ := runTasks(t, "show", "T1", "--json")
	var shown map[string]any
	if err := json.Unmarshal([]byte(out), &shown); err != nil || shown["state"] != "not_started" {
		t.Fatalf("state not restored: %v\n%s", err, out)
	}
	// Already undone: a conflict, with an error exit.
	if out, err := runTasks(t, "undo", arg); err == nil || !strings.Contains(err.Error(), "nothing was undone") {
		t.Fatalf("second undo: err %v\n%s", err, out)
	}

	did := undoIDFrom(t, "delete", "T1", "--json")
	if did == 0 {
		t.Fatal("delete --json has no undo_event_id")
	}
	if out, err := runTasks(t, "undo", strconv.FormatInt(did, 10)); err != nil {
		t.Fatalf("undo delete: %v\n%s", err, out)
	}
	if out, err := runTasks(t, "show", "T1"); err != nil {
		t.Fatalf("task not back: %v\n%s", err, out)
	}
	if _, err := runTasks(t, "undo", "abc"); err == nil {
		t.Fatal("a non-numeric event id was accepted")
	}
}
