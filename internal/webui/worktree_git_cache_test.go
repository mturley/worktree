package webui

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/gitutil"
)

// Tests here that assert gitutil.SpawnCount deltas must not run in parallel:
// the counter is process-wide.

func rawWorktreeGit(t *testing.T, ts *httptest.Server, path string) []byte {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/worktree-git?path=" + url.QueryEscape(path) + "&fetch=0")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, b)
	}
	return b
}

// fakeClock installs a controllable clock on srv's git cache.
func fakeClock(srv *Server) *time.Time {
	now := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	srv.worktreeGitCache().now = func() time.Time { return now }
	return &now
}

func TestWorktreeGit_WarmCacheSpawnsNoGit(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	first := rawWorktreeGit(t, ts, wt)
	before := gitutil.SpawnCount()
	second := rawWorktreeGit(t, ts, wt)
	if d := gitutil.SpawnCount() - before; d != 0 {
		t.Fatalf("warm request spawned %d git processes", d)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("bodies differ:\n%s\n%s", first, second)
	}
}

func TestWorktreeGit_LinkedWorktreeCached(t *testing.T) {
	wt := forkRepo(t)
	linked := filepath.Join(t.TempDir(), "linked")
	gitIn(t, wt, "worktree", "add", "-b", "linked", linked)
	_, ts := gitTestServer(t, linked, nil)
	first := rawWorktreeGit(t, ts, linked)
	before := gitutil.SpawnCount()
	second := rawWorktreeGit(t, ts, linked)
	if d := gitutil.SpawnCount() - before; d != 0 {
		t.Fatalf("warm request spawned %d git processes", d)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("bodies differ:\n%s\n%s", first, second)
	}
}

func TestWorktreeGit_FingerprintsMatchWorkingState(t *testing.T) {
	wt := forkRepo(t)
	os.WriteFile(filepath.Join(wt, "f1"), []byte("changed"), 0o644)
	srv, ts := gitTestServer(t, wt, nil)
	now := fakeClock(srv)
	check := func(label string) {
		t.Helper()
		_, got := getWorktreeGit(t, ts, wt, "")
		_, fp, err := gitutil.WorkingState(wt, "origin/main", "origin/feature")
		if err != nil {
			t.Fatal(err)
		}
		if got.Fingerprint != fp.Full || got.WorkingFingerprint != fp.Working {
			t.Fatalf("%s: got %s/%s, want %s/%s", label, got.Fingerprint, got.WorkingFingerprint, fp.Full, fp.Working)
		}
	}
	check("full compute")
	os.WriteFile(filepath.Join(wt, "f2"), []byte("changed too"), 0o644)
	*now = now.Add(11 * time.Second)
	check("working refresh")
}

func TestWorktreeGit_CommitInvalidates(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	_, a := getWorktreeGit(t, ts, wt, "")
	commitFile(t, wt, "f3", "3")
	_, b := getWorktreeGit(t, ts, wt, "")
	if a.Fingerprint == b.Fingerprint {
		t.Fatal("fingerprint did not move on commit")
	}
	if b.Branch != "feature" || b.VsMergeBase == nil || b.VsMergeBase.Ahead != a.VsMergeBase.Ahead+1 {
		t.Fatalf("after commit: %+v (before %+v)", b.VsMergeBase, a.VsMergeBase)
	}
}

func TestWorktreeGitCache_WorkingEditVisibleAfterTTL(t *testing.T) {
	wt := forkRepo(t)
	srv, ts := gitTestServer(t, wt, nil)
	now := fakeClock(srv)
	_, a := getWorktreeGit(t, ts, wt, "")
	os.WriteFile(filepath.Join(wt, "f1"), []byte("edited"), 0o644)
	*now = now.Add(11 * time.Second)
	_, b := getWorktreeGit(t, ts, wt, "")
	if a.WorkingFingerprint == b.WorkingFingerprint {
		t.Fatal("working_fingerprint did not move")
	}
	if b.Working.Modified != 1 {
		t.Fatalf("working = %+v", b.Working)
	}
}

func TestWorktreeGit_TTLExpiredUnchangedRefsSpawnsOne(t *testing.T) {
	wt := forkRepo(t)
	srv, ts := gitTestServer(t, wt, nil)
	now := fakeClock(srv)
	first := rawWorktreeGit(t, ts, wt)
	*now = now.Add(11 * time.Second)
	before := gitutil.SpawnCount()
	second := rawWorktreeGit(t, ts, wt)
	if d := gitutil.SpawnCount() - before; d != 1 {
		t.Fatalf("spawned %d, want 1", d)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("bodies differ:\n%s\n%s", first, second)
	}
}

func TestWorktreeGit_StageSpawnsOne(t *testing.T) {
	wt := forkRepo(t)
	srv, ts := gitTestServer(t, wt, nil)
	fakeClock(srv)
	rawWorktreeGit(t, ts, wt)
	os.WriteFile(filepath.Join(wt, "new"), []byte("n"), 0o644)
	gitIn(t, wt, "add", "new")
	before := gitutil.SpawnCount()
	_, got := getWorktreeGit(t, ts, wt, "&fetch=0")
	if d := gitutil.SpawnCount() - before; d != 1 {
		t.Fatalf("spawned %d, want 1", d)
	}
	if got.Working.Staged != 1 {
		t.Fatalf("working = %+v", got.Working)
	}
}

func TestWorktreeGit_FetchedUpstreamInvalidates(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	_, a := getWorktreeGit(t, ts, wt, "")
	// Move origin/main one commit forward: a child of it, not on our branch.
	tree := gitIn(t, wt, "rev-parse", "origin/main^{tree}")
	parent := gitIn(t, wt, "rev-parse", "origin/main")
	next := gitIn(t, wt, "commit-tree", trim(tree), "-p", trim(parent), "-m", "upstream")
	gitIn(t, wt, "update-ref", "refs/remotes/origin/main", trim(next))
	_, b := getWorktreeGit(t, ts, wt, "")
	if b.VsMergeBase == nil || b.VsMergeBase.Behind != a.VsMergeBase.Behind+1 {
		t.Fatalf("vs_merge_base %+v (before %+v)", b.VsMergeBase, a.VsMergeBase)
	}
	if a.Fingerprint == b.Fingerprint {
		t.Fatal("fingerprint did not move on fetch")
	}
}

func trim(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

func TestWorktreeGitCache_StampTakenBeforeCompute(t *testing.T) {
	wt := forkRepo(t)
	c := newWorktreeGitCache()
	calls := 0
	compute := func() gitComputed {
		calls++
		if calls == 1 {
			commitFile(t, wt, "mid", "m")
		}
		return gitComputed{}
	}
	c.get(wt, "", compute, nil)
	c.get(wt, "", compute, nil)
	if calls != 2 {
		t.Fatalf("compute ran %d times, want 2", calls)
	}
}

func TestWorktreeGitCache_Singleflight(t *testing.T) {
	wt := forkRepo(t)
	c := newWorktreeGitCache()
	release := make(chan struct{})
	var calls atomic.Int32
	compute := func() gitComputed {
		calls.Add(1)
		<-release
		return gitComputed{baseRemote: "shared"}
	}
	var wg sync.WaitGroup
	results := make([]gitComputed, 5)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = c.get(wt, "", compute, nil)
		}(i)
	}
	// Release the one compute only once the other four requests have joined
	// it, so none can arrive late and start a second compute.
	deadline := time.Now().Add(5 * time.Second)
	for {
		c.mu.Lock()
		joined := 0
		if call, ok := c.inflight[wt]; ok {
			joined = call.waiters
		}
		c.mu.Unlock()
		if joined == len(results)-1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d requests joined the in-flight compute", joined, len(results)-1)
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	wg.Wait()
	if n := calls.Load(); n != 1 {
		t.Fatalf("compute ran %d times, want 1", n)
	}
	for i, r := range results {
		if r.baseRemote != "shared" {
			t.Fatalf("result %d = %+v", i, r)
		}
	}
}

func TestWorktreeGit_OffDiskBypassesCache(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	_, a := getWorktreeGit(t, ts, wt, "")
	if !a.OnDisk {
		t.Fatal("expected on disk")
	}
	if err := os.RemoveAll(wt); err != nil {
		t.Fatal(err)
	}
	_, b := getWorktreeGit(t, ts, wt, "")
	if b.OnDisk {
		t.Fatalf("expected off disk: %+v", b)
	}
}

func TestWorktreeGitCache_PanicReleasesPath(t *testing.T) {
	wt := forkRepo(t)
	c := newWorktreeGitCache()
	func() {
		defer func() { _ = recover() }()
		c.get(wt, "", func() gitComputed { panic("boom") }, nil)
	}()
	done := make(chan gitComputed, 1)
	go func() { done <- c.get(wt, "", func() gitComputed { return gitComputed{baseRemote: "ok"} }, nil) }()
	select {
	case v := <-done:
		if v.baseRemote != "ok" {
			t.Fatalf("got %+v", v)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("get blocked after a panicking compute")
	}
}

func TestWorktreeGit_PatchExpiresWorkingTier(t *testing.T) {
	wt := forkRepo(t)
	srv, ts := gitTestServer(t, wt, nil)
	fakeClock(srv) // clock frozen: only expiry can refresh the working tier
	_, a := getWorktreeGit(t, ts, wt, "")
	if err := os.WriteFile(filepath.Join(wt, "f1"), []byte("edited for patch"), 0o644); err != nil {
		t.Fatal(err)
	}
	p := getPatch(t, ts, wt, "")
	if p.WorkingFingerprint == a.WorkingFingerprint {
		t.Fatal("patch fingerprint did not move")
	}
	before := gitutil.SpawnCount()
	_, b := getWorktreeGit(t, ts, wt, "")
	if b.WorkingFingerprint != p.WorkingFingerprint {
		t.Fatalf("status working_fingerprint %s, patch %s", b.WorkingFingerprint, p.WorkingFingerprint)
	}
	if d := gitutil.SpawnCount() - before; d != 1 {
		t.Fatalf("refresh spawned %d git processes, want 1", d)
	}
}

func TestWorktreeGit_OffDiskDropsCacheEntry(t *testing.T) {
	wt := forkRepo(t)
	srv, ts := gitTestServer(t, wt, nil)
	getWorktreeGit(t, ts, wt, "")
	if err := os.RemoveAll(wt); err != nil {
		t.Fatal(err)
	}
	getWorktreeGit(t, ts, wt, "")
	c := srv.worktreeGitCache()
	c.mu.Lock()
	_, ok := c.entries[wt]
	c.mu.Unlock()
	if ok {
		t.Fatal("cache entry kept for off-disk worktree")
	}
}
