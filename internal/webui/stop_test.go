package webui

import (
	"bytes"
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/jobs"
)

// guardRun drives GuardStop through a channel the test owns: one signal per
// entry of offsets (each the fake clock's reading, in seconds from a fixed
// start), then the channel closes. It returns the recorded exit codes and
// the log once GuardStop has handled every signal and returned.
func guardRun(t *testing.T, s *Server, offsets ...time.Duration) (codes []int, logged string) {
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
		s.GuardStop(sigs, func(code int) { codes = append(codes, code) }, now)
	}()
	for range offsets {
		sigs <- os.Interrupt
	}
	close(sigs)
	<-done
	return codes, buf.String()
}

func TestGuardStopExitsWhenIdle(t *testing.T) {
	t.Parallel()
	srv := jobsTestDB(t)
	codes, _ := guardRun(t, srv, 0)
	if len(codes) != 1 || codes[0] != 0 {
		t.Fatalf("exit codes = %v, want [0]", codes)
	}
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

	codes, logged := guardRun(t, srv, 0)
	if len(codes) != 0 {
		t.Fatalf("exit codes = %v, want none", codes)
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

	codes, logged := guardRun(t, srv, 0, 2*time.Second)
	if len(codes) != 1 || codes[0] != 1 {
		t.Fatalf("exit codes = %v, want [1]", codes)
	}
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

	codes, logged := guardRun(t, srv, 0, 6*time.Second)
	if len(codes) != 0 {
		t.Fatalf("exit codes = %v, want none", codes)
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

	codes, _ := guardRun(t, srv, 0)
	if len(codes) != 1 || codes[0] != 0 {
		t.Fatalf("exit codes = %v, want [0]", codes)
	}
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
	var codes []int
	sigs := make(chan os.Signal)
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.GuardStop(sigs, func(code int) { codes = append(codes, code) }, func() time.Time { return <-clock })
	}()

	sigs <- os.Interrupt // refused
	// The second send only returns once the first signal is fully handled.
	close(release)
	srv.jobs().Wait()
	sigs <- os.Interrupt
	close(sigs)
	<-done

	if len(codes) != 1 || codes[0] != 0 {
		t.Fatalf("exit codes = %v, want [0]", codes)
	}
}
