package cmd

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

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
