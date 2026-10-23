package gitutil

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// staleStatCacheRepo returns a repo whose index stat cache is stale for
// a.txt: its mtime moved but its content did not, so a plain `git status`
// would refresh the cache and rewrite .git/index (taking index.lock to do it).
func staleStatCacheRepo(t *testing.T) string {
	t.Helper()
	repo, _ := newRemoteRepo(t)
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(repo, "a.txt"), future, future); err != nil {
		t.Fatal(err)
	}
	return repo
}

func indexHash(t *testing.T, repo string) [32]byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repo, ".git", "index"))
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(b)
}

func assertIndexUntouched(t *testing.T, name string, call func(repo string)) {
	t.Helper()
	repo := staleStatCacheRepo(t)
	before := indexHash(t, repo)
	call(repo)
	if indexHash(t, repo) != before {
		t.Errorf("%s rewrote .git/index; background status must use --no-optional-locks", name)
	}
	if _, err := os.Lstat(filepath.Join(repo, ".git", "index.lock")); err == nil {
		t.Errorf("%s left .git/index.lock behind", name)
	}
}

// The Code tab polls status every few seconds; a status that refreshes the
// index takes index.lock and races the user's own git commands.
func TestReadOnlyStatusCallsDoNotRewriteIndex(t *testing.T) {
	assertIndexUntouched(t, "WorkingState", func(repo string) {
		if _, _, err := WorkingState(repo, "origin/main"); err != nil {
			t.Fatal(err)
		}
	})
	assertIndexUntouched(t, "ComputeFingerprint", func(repo string) {
		if _, err := ComputeFingerprint(repo, "origin/main"); err != nil {
			t.Fatal(err)
		}
	})
	assertIndexUntouched(t, "ShortStatus", func(repo string) {
		if _, ok := ShortStatus(repo); !ok {
			t.Fatal("ShortStatus not ok")
		}
	})
}

func TestWorkingStateCountsAndMatchesFingerprint(t *testing.T) {
	repo, run := newRemoteRepo(t)
	commitFile(t, repo, "r.txt", "rename me\n")
	run("mv", "r.txt", "renamed.txt") // staged rename: one path, one file
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, "new", "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"new/x.txt", "new/dir/y.txt"} {
		if err := os.WriteFile(filepath.Join(repo, p), []byte("u\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	ws, fp, err := WorkingState(repo, "origin/main")
	if err != nil {
		t.Fatal(err)
	}
	want := WorkingSummary{Staged: 1, Modified: 1, Untracked: 2, Files: 4}
	if ws != want {
		t.Errorf("WorkingState counts = %+v, want %+v", ws, want)
	}
	if fp != mustFingerprint(t, repo, "origin/main") {
		t.Error("WorkingState fingerprint differs from ComputeFingerprint")
	}
}

func TestWorkingStateNotARepo(t *testing.T) {
	if _, _, err := WorkingState(t.TempDir()); err == nil {
		t.Error("WorkingState on a non-repo returned no error")
	}
}
