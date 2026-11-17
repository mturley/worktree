package gitutil

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/testgit"
)

func evalSym(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatalf("EvalSymlinks(%s): %v", p, err)
	}
	return r
}

func TestGitDirs_Plain(t *testing.T) {
	dir := t.TempDir()
	runIn(t, dir, "init", "-b", "main")

	gitDir, commonDir, err := GitDirs(dir)
	if err != nil {
		t.Fatal(err)
	}
	wantDotGit := evalSym(t, filepath.Join(dir, ".git"))
	if evalSym(t, gitDir) != wantDotGit {
		t.Errorf("gitDir = %s, want %s", gitDir, wantDotGit)
	}
	if evalSym(t, commonDir) != wantDotGit {
		t.Errorf("commonDir = %s, want %s", commonDir, wantDotGit)
	}
}

func TestGitDirs_Linked(t *testing.T) {
	wt := testgit.Worktree(t)
	main := filepath.Join(filepath.Dir(wt), "repo")

	gitDir, commonDir, err := GitDirs(wt)
	if err != nil {
		t.Fatal(err)
	}
	gitDir = evalSym(t, gitDir)
	wantSuffix := filepath.Join(".git", "worktrees", "wt")
	if filepath.Base(filepath.Dir(gitDir)) != "worktrees" || filepath.Base(gitDir) != "wt" {
		t.Errorf("gitDir = %s, want to end with %s", gitDir, wantSuffix)
	}

	wantCommon := evalSym(t, filepath.Join(main, ".git"))
	if evalSym(t, commonDir) != wantCommon {
		t.Errorf("commonDir = %s, want %s", commonDir, wantCommon)
	}
}

func touchForward(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		// Not all files exist yet (e.g. ORIG_HEAD); that's fine.
		return
	}
	newTime := info.ModTime().Add(1 * time.Second)
	if err := os.Chtimes(path, newTime, newTime); err != nil {
		t.Fatal(err)
	}
}

func TestStateStamp_ChangesOnCommit(t *testing.T) {
	wt := testgit.Worktree(t)

	s1, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(wt, "g"), []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	runIn(t, wt, "add", "g")
	runIn(t, wt, "commit", "-m", "second")

	gitDir, _, err := GitDirs(wt)
	if err != nil {
		t.Fatal(err)
	}
	touchForward(t, filepath.Join(gitDir, "HEAD"))

	s2, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}
	if s1.Refs == s2.Refs {
		t.Errorf("Refs unchanged after commit: %s", s1.Refs)
	}
}

func TestStateStamp_ChangesOnRefUpdateInMain(t *testing.T) {
	wt := testgit.Worktree(t)
	main := filepath.Join(filepath.Dir(wt), "repo")

	s1, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}

	runIn(t, main, "update-ref", "refs/remotes/origin/main", "HEAD")

	_, commonDir, err := GitDirs(wt)
	if err != nil {
		t.Fatal(err)
	}
	touchForward(t, filepath.Join(commonDir, "refs", "remotes", "origin", "main"))

	s2, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}
	if s1.Refs == s2.Refs {
		t.Errorf("Refs unchanged after update-ref in main: %s", s1.Refs)
	}
}

func TestStateStamp_ChangesOnBranchSwitch(t *testing.T) {
	wt := testgit.Worktree(t)

	s1, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}

	runIn(t, wt, "checkout", "-b", "other")

	gitDir, _, err := GitDirs(wt)
	if err != nil {
		t.Fatal(err)
	}
	touchForward(t, filepath.Join(gitDir, "HEAD"))

	s2, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}
	if s1.Refs == s2.Refs {
		t.Errorf("Refs unchanged after branch switch: %s", s1.Refs)
	}
}

func TestStateStamp_ChangesOnRemoteConfig(t *testing.T) {
	wt := testgit.Worktree(t)

	s1, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}

	runIn(t, wt, "remote", "add", "up", "https://example.invalid/repo.git")

	_, commonDir, err := GitDirs(wt)
	if err != nil {
		t.Fatal(err)
	}
	touchForward(t, filepath.Join(commonDir, "config"))

	s2, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}
	if s1.Refs == s2.Refs {
		t.Errorf("Refs unchanged after remote add: %s", s1.Refs)
	}
}

func TestStateStamp_StableAndSpawnFree(t *testing.T) {
	wt := testgit.Worktree(t)

	before := SpawnCount()
	s1, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}
	s2, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}
	after := SpawnCount()

	if s1 != s2 {
		t.Errorf("StateStamp not stable: %+v != %+v", s1, s2)
	}
	if before != after {
		t.Errorf("SpawnCount changed: before=%d after=%d", before, after)
	}
}

func TestStateStamp_StageChangesIndexOnly(t *testing.T) {
	wt := testgit.Worktree(t)

	s1, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(wt, "newfile"), []byte("z"), 0o644); err != nil {
		t.Fatal(err)
	}
	runIn(t, wt, "add", "newfile")

	gitDir, _, err := GitDirs(wt)
	if err != nil {
		t.Fatal(err)
	}
	touchForward(t, filepath.Join(gitDir, "index"))

	s2, err := StateStamp(wt)
	if err != nil {
		t.Fatal(err)
	}
	if s1.Index == s2.Index {
		t.Errorf("Index unchanged after git add: %s", s1.Index)
	}
	if s1.Refs != s2.Refs {
		t.Errorf("Refs changed after git add (index-only op): %s != %s", s1.Refs, s2.Refs)
	}
}
