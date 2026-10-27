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
	s := New(context.Background(), interval)
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
	s.Maybe(dir, []string{"origin", "upstream"})
	s.Maybe(dir, []string{"origin", "upstream"})
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
	s.Maybe(a, []string{"origin"})
	settle(t, s, a)
	s.Maybe(b, []string{"origin"})
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
	s.Maybe(dir, []string{"origin"})
	settle(t, s, dir)
	f.advance(time.Minute - time.Second)
	s.Maybe(dir, []string{"origin"})
	settle(t, s, dir)
	if got := f.count(); got != 1 {
		t.Fatalf("fetches = %d before interval elapsed, want 1", got)
	}
	f.advance(time.Second)
	s.Maybe(dir, []string{"origin"})
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
	s.Maybe(dir, []string{"origin"})
	settle(t, s, dir)
	if st := s.State(dir); st.LastError == "" || st.LastOKAt != nil {
		t.Fatalf("state = %+v, want error and no LastOKAt", st)
	}
	s.Maybe(dir, []string{"origin"})
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
	s.Maybe(dir, []string{"origin"})
	settle(t, s, dir)
	if f.count() != 0 {
		t.Fatal("fetched while index.lock was present")
	}
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
	s.Maybe(dir, []string{"origin"})
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
	s.Maybe(dir, []string{"origin"})
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
	s.Maybe(dir, []string{"origin"})
	f.advance(time.Hour)
	s.Maybe(dir, []string{"origin"})
	if !s.State(dir).InProgress {
		t.Fatal("InProgress should be true")
	}
	close(f.block)
	settle(t, s, dir)
	if got := f.count(); got != 1 {
		t.Fatalf("fetches = %d, want 1", got)
	}
}

func TestMaybeCancelledWithLifetimeContext(t *testing.T) {
	dir := testgit.Worktree(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := New(ctx, time.Minute)
	started := make(chan struct{})
	var sawCancel sync.WaitGroup
	sawCancel.Add(1)
	s.Fetch = func(c context.Context, dir, remote string) error {
		close(started)
		<-c.Done()
		sawCancel.Done()
		return c.Err()
	}
	s.Maybe(dir, []string{"origin"})
	<-started
	if !s.State(dir).InProgress {
		t.Fatal("InProgress should be true")
	}
	cancel()
	sawCancel.Wait()
	settle(t, s, dir)

	// With the lifetime context done, Maybe must not start anything.
	s.Fetch = func(context.Context, string, string) error { t.Error("fetch after shutdown"); return nil }
	s.Now = func() time.Time { return time.Now().Add(time.Hour) }
	s.Maybe(dir, []string{"origin"})
	if s.State(dir).InProgress {
		t.Fatal("started a fetch after shutdown")
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

func TestFetchCommandNeverPrompts(t *testing.T) {
	args, env := fetchCommand("/repo", "origin", "ssh -i key")
	want := []string{"-C", "/repo", "fetch", "--prune", "--no-auto-maintenance", "--no-write-fetch-head", "origin"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %q, want %q", args, want)
	}
	for _, kv := range []string{
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
		"GCM_INTERACTIVE=never",
		"GIT_SSH_COMMAND=ssh -i key -o BatchMode=yes",
	} {
		found := false
		for _, e := range env {
			if e == kv {
				found = true
			}
		}
		if !found {
			t.Errorf("env %q missing from %q", kv, env)
		}
	}
}

func TestRedactErrorHidesCredentials(t *testing.T) {
	got := redactError("fatal: unable to access 'https://user:tok@github.com/x.git/': 403")
	want := "fatal: unable to access 'https://***@github.com/x.git/': 403"
	if got != want {
		t.Errorf("redactError = %q, want %q", got, want)
	}
	// Scp-style SSH remotes carry no secret and keep their user.
	if s := "git@github.com:x.git: Permission denied"; redactError(s) != s {
		t.Errorf("redactError changed %q to %q", s, redactError(s))
	}
}

// A password may itself hold "@" or "/" (unencoded, as git echoes it back):
// everything up to the last "@" of the URL is userinfo, never just the first.
func TestRedactErrorHidesPasswordsWithAtOrSlash(t *testing.T) {
	for _, in := range []string{
		"fatal: unable to access 'https://user:p@ss@github.com/x.git/': 403",
		"fatal: unable to access 'https://user:p/w@github.com/x.git/': 403",
		"fatal: unable to access 'https://user:a@b/c@github.com/x.git/': 403",
	} {
		got := redactError(in)
		want := "fatal: unable to access 'https://***@github.com/x.git/': 403"
		if got != want {
			t.Errorf("redactError(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRedactErrorTruncates(t *testing.T) {
	got := redactError(strings.Repeat("é", 2000))
	if n := len([]rune(got)); n > maxErrorRunes+1 {
		t.Errorf("redacted error is %d runes, want at most %d", n, maxErrorRunes+1)
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncated error does not end with an ellipsis")
	}
}

// The UI shows LastError verbatim, so the scheduler must redact what Fetch
// returns before storing it.
func TestMaybeStoresRedactedError(t *testing.T) {
	dir := testgit.Worktree(t)
	f := newFakes()
	f.err = errors.New("fatal: could not read from https://me:secret@example.com/r.git")
	s := f.scheduler(time.Minute)
	s.Maybe(dir, []string{"origin"})
	settle(t, s, dir)
	if st := s.State(dir); strings.Contains(st.LastError, "secret") || !strings.Contains(st.LastError, "https://***@example.com") {
		t.Errorf("LastError = %q, want credentials redacted", st.LastError)
	}
}

func TestRefsCommandNeverPrompts(t *testing.T) {
	args, env := refsCommand("/repo", "origin", "ssh", []string{"+refs/pull/7/head:refs/pr-review/7"})
	want := []string{"-C", "/repo", "fetch", "--no-auto-maintenance", "--no-write-fetch-head", "origin", "+refs/pull/7/head:refs/pr-review/7"}
	if !reflect.DeepEqual(args, want) {
		t.Errorf("args = %q, want %q", args, want)
	}
	if _, base := fetchCommand("/repo", "origin", "ssh"); !reflect.DeepEqual(env, base) {
		t.Errorf("env = %q, want the background fetch's %q", env, base)
	}
}

// FetchRefs's error reaches the server log, so it must be redacted like
// the background fetch's. git redacts remote URLs itself, but echoes a
// directory it cannot enter verbatim, so a credential-shaped dir shows
// what comes back unredacted otherwise.
func TestFetchRefsReturnsRedactedError(t *testing.T) {
	// Not filepath.Join, which would clean "//" away.
	dir := t.TempDir() + "/https://me:secret@example.com/r"
	err := FetchRefs(context.Background(), dir, "origin", "+refs/heads/x:refs/x")
	if err == nil {
		t.Fatal("FetchRefs into a missing dir succeeded")
	}
	if msg := err.Error(); strings.Contains(msg, "secret") || !strings.Contains(msg, "https://***@") {
		t.Errorf("FetchRefs error = %q, want credentials redacted", msg)
	}
}
