package gitfetch

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/testgit"
)

type fakes struct {
	mu    sync.Mutex
	now   time.Time
	calls []string
	err   error
	block chan struct{} // when non-nil, Fetch waits on it
}

func newFakes() *fakes { return &fakes{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)} }

func (f *fakes) scheduler(interval time.Duration) *Scheduler {
	s := New(interval)
	s.Now = func() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.now }
	s.Fetch = func(ctx context.Context, dir, remote string) error {
		f.mu.Lock()
		f.calls = append(f.calls, remote)
		block, err := f.block, f.err
		f.mu.Unlock()
		if block != nil {
			<-block
		}
		return err
	}
	return s
}

func (f *fakes) advance(d time.Duration) { f.mu.Lock(); f.now = f.now.Add(d); f.mu.Unlock() }

func (f *fakes) count() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }

// settle waits until the scheduler reports no fetch in flight for dir.
func settle(t *testing.T, s *Scheduler, dir string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for s.State(dir).InProgress {
		if time.Now().After(deadline) {
			t.Fatal("fetch never finished")
		}
		time.Sleep(time.Millisecond)
	}
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

// addSibling adds a second linked worktree to the repo that wt belongs to.
func addSibling(t *testing.T, wt string) string {
	t.Helper()
	repo := filepath.Dir(gitOut(t, wt, "rev-parse", "--path-format=absolute", "--git-common-dir"))
	sib := filepath.Join(filepath.Dir(wt), "sibling")
	cmd := exec.Command("git", "-C", repo, "worktree", "add", "-b", "sibling", sib)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if o, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("worktree add: %v\n%s", err, o)
	}
	return sib
}

func TestMaybeFetchesOnceWhenDue(t *testing.T) {
	dir := testgit.Worktree(t)
	f := newFakes()
	s := f.scheduler(time.Minute)
	s.Maybe(context.Background(), dir, []string{"origin", "upstream"})
	s.Maybe(context.Background(), dir, []string{"origin", "upstream"})
	settle(t, s, dir)
	if got := f.count(); got != 2 {
		t.Fatalf("fetches = %d, want 2 (one per remote)", got)
	}
	if s.State(dir).LastOKAt == nil {
		t.Fatal("LastOKAt not set")
	}
}

func TestMaybeDedupsAcrossWorktreesOfSameRepo(t *testing.T) {
	a := testgit.Worktree(t)
	b := addSibling(t, a)
	f := newFakes()
	s := f.scheduler(time.Minute)
	s.Maybe(context.Background(), a, []string{"origin"})
	settle(t, s, a)
	s.Maybe(context.Background(), b, []string{"origin"})
	settle(t, s, b)
	if got := f.count(); got != 1 {
		t.Fatalf("fetches = %d, want 1", got)
	}
	if s.State(b).LastOKAt == nil {
		t.Fatal("sibling worktree should see the shared state")
	}
}

func TestMaybeWaitsOutInterval(t *testing.T) {
	dir := testgit.Worktree(t)
	f := newFakes()
	s := f.scheduler(time.Minute)
	s.Maybe(context.Background(), dir, []string{"origin"})
	settle(t, s, dir)
	f.advance(time.Minute - time.Second)
	s.Maybe(context.Background(), dir, []string{"origin"})
	settle(t, s, dir)
	if got := f.count(); got != 1 {
		t.Fatalf("fetches = %d before interval elapsed, want 1", got)
	}
	f.advance(time.Second)
	s.Maybe(context.Background(), dir, []string{"origin"})
	settle(t, s, dir)
	if got := f.count(); got != 2 {
		t.Fatalf("fetches = %d after interval, want 2", got)
	}
}

func TestMaybeFailureWaitsOutInterval(t *testing.T) {
	dir := testgit.Worktree(t)
	f := newFakes()
	f.err = errors.New("boom")
	s := f.scheduler(time.Minute)
	s.Maybe(context.Background(), dir, []string{"origin"})
	settle(t, s, dir)
	if st := s.State(dir); st.LastError == "" || st.LastOKAt != nil {
		t.Fatalf("state = %+v, want error and no LastOKAt", st)
	}
	s.Maybe(context.Background(), dir, []string{"origin"})
	settle(t, s, dir)
	if got := f.count(); got != 1 {
		t.Fatalf("fetches = %d, want 1 (failure must wait out the interval)", got)
	}
}

func TestMaybeSkipsWhileLockFilePresent(t *testing.T) {
	dir := testgit.Worktree(t)
	f := newFakes()
	s := f.scheduler(time.Minute)
	lock := filepath.Join(gitOut(t, dir, "rev-parse", "--absolute-git-dir"), "index.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	s.Maybe(context.Background(), dir, []string{"origin"})
	settle(t, s, dir)
	if f.count() != 0 {
		t.Fatal("fetched while index.lock was present")
	}
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
	s.Maybe(context.Background(), dir, []string{"origin"})
	settle(t, s, dir)
	if f.count() != 1 {
		t.Fatal("a skipped attempt must not count against the interval")
	}
}

func TestMaybeSkipsWhileRefLockPresent(t *testing.T) {
	dir := testgit.Worktree(t)
	f := newFakes()
	s := f.scheduler(time.Minute)
	common := gitOut(t, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	lock := filepath.Join(common, "refs", "heads", "main.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	s.Maybe(context.Background(), dir, []string{"origin"})
	settle(t, s, dir)
	if f.count() != 0 {
		t.Fatal("fetched while a ref lock was present")
	}
}

func TestMaybeNeverConcurrentPerRepo(t *testing.T) {
	dir := testgit.Worktree(t)
	f := newFakes()
	f.block = make(chan struct{})
	s := f.scheduler(time.Minute)
	s.Maybe(context.Background(), dir, []string{"origin"})
	f.advance(time.Hour)
	s.Maybe(context.Background(), dir, []string{"origin"})
	if !s.State(dir).InProgress {
		t.Fatal("InProgress should be true")
	}
	close(f.block)
	settle(t, s, dir)
	if got := f.count(); got != 1 {
		t.Fatalf("fetches = %d, want 1", got)
	}
}

func TestRemotesForForkSetup(t *testing.T) {
	dir := testgit.Worktree(t)
	for _, r := range []string{"origin", "upstream"} {
		if out, err := exec.Command("git", "-C", dir, "remote", "add", r, "https://example.invalid/"+r).CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
	}
	got := RemotesFor(dir, "upstream/main", "origin/feat", "origin/other", "HEAD", "nosuch/x")
	if want := []string{"origin", "upstream"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("RemotesFor = %v, want %v", got, want)
	}
}
