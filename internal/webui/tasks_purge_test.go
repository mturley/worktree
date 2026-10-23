package webui

import (
	"fmt"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
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

// StartPolling starts the deleted-task purge: its first sweep runs at once.
func TestStartPollingStartsPurgeSweep(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // the poll reads no real watcher config
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	s, _ := tasksServer(t)
	s.githubOff.Store(true)
	s.jiraOff.Store(true)
	s.slackOff.Store(true)
	swept := make(chan struct{}, 1)
	s.purgeSweep = func() {
		select {
		case swept <- struct{}{}:
		default:
		}
	}
	stop := s.StartPolling(time.Hour)
	defer stop()
	select {
	case <-swept:
	case <-time.After(5 * time.Second):
		t.Fatal("StartPolling did not run the purge sweep")
	}
	// Let the first poll finish before the test's DB closes.
	deadline := time.Now().Add(5 * time.Second)
	for s.pollInFlight.Load() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
}

// A failed read of the blocking tasks labels them neutrally ("T<id>", no
// status), never "(deleted)". A soft-deleted, not yet purged, blocking task
// keeps its title, with status "deleted".
func TestBlockerLabelerHeadsReadFailureAndSoftDeleted(t *testing.T) {
	s, _ := tasksServer(t)
	dep := mustTask(t, s, tasks.NewTask{Title: "dep"})
	tk := mustTask(t, s, tasks.NewTask{Title: "main"})
	addBlockerReq(t, s, map[string]any{"id": tk.ID, "kind": "task", "task_id": dep.ID})
	if _, err := tasks.Delete(s.DB, webUser, dep.ID); err != nil {
		t.Fatal(err)
	}
	b := blockerByKind(t, getDetail(t, s, tk.ID), fmt.Sprintf("T%d dep", dep.ID))
	if b.StatusLabel != "deleted" {
		t.Fatalf("soft-deleted blocking task status = %q, want deleted", b.StatusLabel)
	}

	bs, err := tasks.Blockers(s.DB, tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	closed, err := wdb.OpenAt(filepath.Join(t.TempDir(), "closed.db"))
	if err != nil {
		t.Fatal(err)
	}
	closed.Close()
	l := (&Server{DB: closed}).newBlockerLabeler(bs, nil)
	if got, want := l.label(bs[0]), fmt.Sprintf("T%d", dep.ID); got != want {
		t.Errorf("label after a failed read = %q, want %q", got, want)
	}
	if got := l.statusLabel(bs[0]); got != "" {
		t.Errorf("status after a failed read = %q, want none", got)
	}
}
