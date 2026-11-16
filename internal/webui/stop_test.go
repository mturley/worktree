package webui

import (
	"bytes"
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/jobs"
)

// guardRun drives GuardStop through a channel the test owns: one SIGTERM per
// entry of offsets (each the fake clock's reading, in seconds from a fixed
// start), then the channel closes. It returns the signals GuardStop chose to
// die by and the log, once it has handled every signal and returned. No real
// signal is ever sent: die only records.
func guardRun(t *testing.T, s *Server, offsets ...time.Duration) (died []os.Signal, logged string) {
	t.Helper()
	var buf bytes.Buffer
	s.Logger = log.New(&buf, "", 0)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	next := 0
	now := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		at := start
		if next < len(offsets) {
			at = start.Add(offsets[next])
		}
		next++
		return at
	}
	sigs := make(chan os.Signal)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.GuardStop(sigs, func(sig os.Signal) { died = append(died, sig) }, now)
	}()
	for range offsets {
		sigs <- syscall.SIGTERM
	}
	close(sigs)
	<-done
	return died, buf.String()
}

// wantDied fails unless GuardStop ended the process exactly once, by the
// signal it was handed. A status of its own instead would change what the
// shell, and anything supervising the server, sees when it is stopped.
func wantDied(t *testing.T, died []os.Signal) {
	t.Helper()
	if len(died) != 1 || died[0] != syscall.SIGTERM {
		t.Fatalf("died by %v, want [terminated]", died)
	}
}

func TestGuardStopExitsWhenIdle(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	died, _ := guardRun(t, srv, 0)
	wantDied(t, died)
}

func TestGuardStopRefusesWhileRunning(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	release := make(chan struct{})
	srv.jobs().Register(blockingJobKind("test_block", release))
	defer func() {
		close(release)
		srv.jobs().Wait()
	}()
	if _, _, err := srv.jobs().Start("test_block", "Delete worktree foo", "t", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}

	died, logged := guardRun(t, srv, 0)
	if len(died) != 0 {
		t.Fatalf("died by %v, want not at all", died)
	}
	want := "refusing to stop: Delete worktree foo is running; signal again within 5s to force"
	if !strings.Contains(logged, want) {
		t.Fatalf("log = %q, want it to contain %q", logged, want)
	}
}

func TestGuardStopSecondSignalForces(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	release := make(chan struct{})
	srv.jobs().Register(blockingJobKind("test_block", release))
	defer func() {
		close(release)
		srv.jobs().Wait()
	}()
	if _, _, err := srv.jobs().Start("test_block", "Delete worktree foo", "t", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}

	died, logged := guardRun(t, srv, 0, 2*time.Second)
	wantDied(t, died)
	want := "forced stop: Delete worktree foo will be marked interrupted"
	if !strings.Contains(logged, want) {
		t.Fatalf("log = %q, want it to contain %q", logged, want)
	}
}

func TestGuardStopSecondSignalAfterWindowRefusesAgain(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	release := make(chan struct{})
	srv.jobs().Register(blockingJobKind("test_block", release))
	defer func() {
		close(release)
		srv.jobs().Wait()
	}()
	if _, _, err := srv.jobs().Start("test_block", "Delete worktree foo", "t", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}

	died, logged := guardRun(t, srv, 0, 6*time.Second)
	if len(died) != 0 {
		t.Fatalf("died by %v, want not at all", died)
	}
	if n := strings.Count(logged, "refusing to stop:"); n != 2 {
		t.Fatalf("refusal lines = %d in %q, want 2", n, logged)
	}
}

func TestGuardStopNamesEveryRunningJob(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	release := make(chan struct{})
	srv.jobs().Register(blockingJobKind("test_block", release))
	defer func() {
		close(release)
		srv.jobs().Wait()
	}()
	for _, title := range []string{"Delete worktree b", "Delete worktree a"} {
		if _, _, err := srv.jobs().Start("test_block", title, title, json.RawMessage(`{}`)); err != nil {
			t.Fatal(err)
		}
	}

	_, logged := guardRun(t, srv, 0)
	want := "refusing to stop: Delete worktree a, Delete worktree b is running; signal again within 5s to force"
	if !strings.Contains(logged, want) {
		t.Fatalf("log = %q, want it to contain %q", logged, want)
	}
}

func TestGuardStopParkedJobDoesNotBlock(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	srv.jobs().Register(fixedJobKind("test_park", jobs.Outcome{
		State: jobs.StateNeedsAnswer, Question: json.RawMessage(`{"key":"delete_branch"}`),
	}))
	if _, _, err := srv.jobs().Start("test_park", "parked", "t1", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	srv.jobs().Wait()

	died, _ := guardRun(t, srv, 0)
	wantDied(t, died)
}

func TestGuardStopExitsOnceJobFinishes(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	release := make(chan struct{})
	srv.jobs().Register(blockingJobKind("test_block", release))
	if _, _, err := srv.jobs().Start("test_block", "Delete worktree foo", "t", json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	srv.Logger = log.New(&buf, "", 0)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := make(chan time.Time, 2)
	clock <- start
	clock <- start.Add(10 * time.Second)
	var died []os.Signal
	sigs := make(chan os.Signal)
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.GuardStop(sigs, func(sig os.Signal) { died = append(died, sig) }, func() time.Time { return <-clock })
	}()

	sigs <- syscall.SIGTERM // refused
	// The second send only returns once the first signal is fully handled.
	close(release)
	srv.jobs().Wait()
	sigs <- syscall.SIGTERM
	close(sigs)
	<-done

	wantDied(t, died)
}
