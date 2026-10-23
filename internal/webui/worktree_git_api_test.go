package webui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/gitfetch"
	"github.com/mturley/worktree/internal/registry"
)

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func commitFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, dir, "add", name)
	gitIn(t, dir, "commit", "-m", "add "+name)
}

// gitTestServer registers path and serves a Server whose scheduler (if any)
// is the one given.
func gitTestServer(t *testing.T, path string, sched *gitfetch.Scheduler) (*Server, *httptest.Server) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	registry.Register(conn, registry.Entry{
		Path: path, Repo: "odh", RepoRoot: "/r", Branch: "feature",
		CreatedAt: "2026-08-13T00:00:00Z",
	})
	srv := &Server{DB: conn, ConfigPath: filepath.Join(t.TempDir(), "config.yaml"), fetcher: sched}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

func getWorktreeGit(t *testing.T, ts *httptest.Server, path, query string) (*http.Response, worktreeGitDTO) {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/worktree-git?path=" + url.QueryEscape(path) + query)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got worktreeGitDTO
	_ = json.NewDecoder(resp.Body).Decode(&got)
	return resp, got
}

// forkRepo builds origin (bare) + a clone on branch `feature`, where
// origin/main has moved one commit past the branch point and the branch has
// one pushed commit plus one local one.
func forkRepo(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	origin := filepath.Join(base, "origin.git")
	gitIn(t, base, "init", "--bare", "-b", "main", origin)
	wt := filepath.Join(base, "wt")
	gitIn(t, base, "clone", origin, wt)
	gitIn(t, wt, "checkout", "-b", "main")
	commitFile(t, wt, "base", "1")
	gitIn(t, wt, "push", "-u", "origin", "main")
	gitIn(t, wt, "remote", "set-head", "origin", "main")

	other := filepath.Join(base, "other")
	gitIn(t, base, "clone", origin, other)
	commitFile(t, other, "upstream-change", "u")
	gitIn(t, other, "push", "origin", "main")
	gitIn(t, wt, "fetch", "origin")

	gitIn(t, wt, "checkout", "-b", "feature")
	commitFile(t, wt, "f1", "1")
	gitIn(t, wt, "push", "-u", "origin", "feature")
	commitFile(t, wt, "f2", "2")
	return wt
}

func TestWorktreeGitReportsMergeBaseAndTracking(t *testing.T) {
	wt := forkRepo(t)
	// staged, modified, and two untracked files inside a directory.
	os.WriteFile(filepath.Join(wt, "staged"), []byte("s"), 0o644)
	gitIn(t, wt, "add", "staged")
	os.WriteFile(filepath.Join(wt, "f1"), []byte("changed"), 0o644)
	os.MkdirAll(filepath.Join(wt, "dir"), 0o755)
	os.WriteFile(filepath.Join(wt, "dir", "a"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(wt, "dir", "b"), []byte("b"), 0o644)

	_, ts := gitTestServer(t, wt, nil)
	resp, got := getWorktreeGit(t, ts, wt, "")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if !got.OnDisk || got.Branch != "feature" {
		t.Fatalf("on_disk/branch: %+v", got)
	}
	if got.MainUpstream == nil || *got.MainUpstream != "origin/main" {
		t.Fatalf("main_upstream = %v", got.MainUpstream)
	}
	if got.Tracking == nil || *got.Tracking != "origin/feature" {
		t.Fatalf("tracking = %v", got.Tracking)
	}
	if got.MergeBase == nil || len(*got.MergeBase) != 40 {
		t.Fatalf("merge_base = %v", got.MergeBase)
	}
	if got.VsMergeBase == nil || got.VsMergeBase.Ahead != 2 || got.VsMergeBase.Behind != 1 {
		t.Fatalf("vs_merge_base = %+v", got.VsMergeBase)
	}
	if got.VsTracking == nil || got.VsTracking.Ahead != 1 || got.VsTracking.Behind != 0 {
		t.Fatalf("vs_tracking = %+v", got.VsTracking)
	}
	w := got.Working
	if w.Staged != 1 || w.Modified != 1 || w.Untracked != 2 || w.Files != 4 {
		t.Fatalf("working = %+v", w)
	}
	if got.Fingerprint == "" || got.WorkingFingerprint == "" {
		t.Fatalf("fingerprints empty: %+v", got)
	}
}

func TestWorktreeGitUnregisteredPath404(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	resp, _ := getWorktreeGit(t, ts, t.TempDir(), "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d, want 404", resp.StatusCode)
	}
}

func TestWorktreeGitMissingFromDisk(t *testing.T) {
	wt := forkRepo(t)
	_, ts := gitTestServer(t, wt, nil)
	if err := os.RemoveAll(wt); err != nil {
		t.Fatal(err)
	}
	resp, got := getWorktreeGit(t, ts, wt, "")
	if resp.StatusCode != 200 || got.OnDisk {
		t.Fatalf("status %d, %+v", resp.StatusCode, got)
	}
	if got.Fingerprint != "" || got.MergeBase != nil {
		t.Fatalf("computed something for a missing dir: %+v", got)
	}
}

func TestWorktreeGitNoCommits(t *testing.T) {
	dir := t.TempDir()
	gitIn(t, dir, "init", "-b", "feature")
	os.WriteFile(filepath.Join(dir, "u"), []byte("x"), 0o644)
	_, ts := gitTestServer(t, dir, nil)
	resp, got := getWorktreeGit(t, ts, dir, "")
	if resp.StatusCode != 200 || !got.OnDisk {
		t.Fatalf("status %d, %+v", resp.StatusCode, got)
	}
	if got.MergeBase != nil || got.VsMergeBase != nil {
		t.Fatalf("merge base on an empty repo: %+v", got)
	}
	if got.Working.Untracked != 1 {
		t.Fatalf("working = %+v", got.Working)
	}
}

func TestWorktreeGitDetachedHEAD(t *testing.T) {
	wt := forkRepo(t)
	gitIn(t, wt, "checkout", "--detach")
	_, ts := gitTestServer(t, wt, nil)
	resp, got := getWorktreeGit(t, ts, wt, "")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if got.Tracking != nil || got.VsTracking != nil {
		t.Fatalf("tracking on a detached HEAD: %+v", got)
	}
	if got.MergeBase == nil {
		t.Fatal("merge base should still resolve against main")
	}
	if got.Branch != "" {
		t.Fatalf("branch = %q, want empty when detached", got.Branch)
	}
}

func TestWorktreeGitFetchOnlyWithParam(t *testing.T) {
	wt := forkRepo(t)
	var calls atomic.Int32
	sched := gitfetch.New(context.Background(), time.Minute)
	sched.Fetch = func(ctx context.Context, dir, remote string) error {
		calls.Add(1)
		return nil
	}
	srv, ts := gitTestServer(t, wt, sched)

	wait := func(want int32) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for calls.Load() < want && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		// Let any stray extra call land before asserting the exact count.
		time.Sleep(100 * time.Millisecond)
		if got := calls.Load(); got != want {
			t.Fatalf("fetch calls = %d, want %d", got, want)
		}
	}

	getWorktreeGit(t, ts, wt, "")
	wait(0)

	getWorktreeGit(t, ts, wt, "&fetch=1")
	wait(1)

	// Switch off in config: no further fetch even once the interval allows it.
	if err := os.WriteFile(srv.ConfigPath, []byte("git:\n  background_fetch: false\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(time.Hour)
	sched.Now = func() time.Time { return now }
	getWorktreeGit(t, ts, wt, "&fetch=1")
	wait(1)
}
