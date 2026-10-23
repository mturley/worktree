package webui

import (
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/tasks"
)

func TestRunEverySweepsOnStartAndOnEachTick(t *testing.T) {
	var calls atomic.Int32
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		runEvery(5*time.Millisecond, done, func() { calls.Add(1) })
		close(finished)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	close(done)
	<-finished
	if calls.Load() < 3 {
		t.Fatalf("sweep ran %d times, want at least 3 (start + ticks)", calls.Load())
	}
}

func TestPurgeDeletedTasksSweepAndBlockerLabel(t *testing.T) {
	s, _ := tasksServer(t)
	gone := mustTask(t, s, tasks.NewTask{Title: "gone"})
	recent := mustTask(t, s, tasks.NewTask{Title: "recent"})
	tk := mustTask(t, s, tasks.NewTask{Title: "main"})
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "task", "task_id": gone.ID})
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "task", "task_id": recent.ID})
	for _, id := range []int64{gone.ID, recent.ID} {
		if _, err := tasks.Delete(s.DB, webUser, id); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339)
	if _, err := s.DB.Exec(`UPDATE tasks SET deleted_at = ? WHERE id = ?`, old, gone.ID); err != nil {
		t.Fatal(err)
	}

	s.purgeDeletedTasks()

	var n int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM tasks WHERE id IN (?, ?)`, gone.ID, recent.ID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("tasks left = %d (%v), want only the recent one", n, err)
	}
	d := getDetail(t, s, tk.ID)
	blockerByKind(t, d, fmt.Sprintf("T%d (deleted)", gone.ID))
	blockerByKind(t, d, fmt.Sprintf("T%d recent", recent.ID))
}
