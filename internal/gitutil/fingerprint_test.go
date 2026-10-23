package gitutil

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func mustFingerprint(t *testing.T, dir string, refs ...string) Fingerprint {
	t.Helper()
	fp, err := ComputeFingerprint(dir, refs...)
	if err != nil {
		t.Fatal(err)
	}
	return fp
}

func TestFingerprintStableWhenNothingChanges(t *testing.T) {
	repo, _ := newRemoteRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := mustFingerprint(t, repo, "origin/main")
	b := mustFingerprint(t, repo, "origin/main")
	if a != b {
		t.Errorf("fingerprint unstable: %+v vs %+v", a, b)
	}
}

func TestFingerprintChangesOnReEditOfModifiedFile(t *testing.T) {
	repo, _ := newRemoteRepo(t)
	path := filepath.Join(repo, "a.txt")
	if err := os.WriteFile(path, []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := mustFingerprint(t, repo)
	// Same size, so only the mtime can tell the edits apart; status output
	// is identical (" M a.txt") both times.
	if err := os.WriteFile(path, []byte("tre\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Minute)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
	after := mustFingerprint(t, repo)
	if before.Working == after.Working {
		t.Error("Working fingerprint did not change after re-editing a modified file")
	}
}

func TestFingerprintChangesOnNewFileInNewUntrackedDir(t *testing.T) {
	repo, _ := newRemoteRepo(t)
	if err := os.Mkdir(filepath.Join(repo, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "a", "b.txt"), []byte("b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := mustFingerprint(t, repo)
	if err := os.WriteFile(filepath.Join(repo, "a", "c.txt"), []byte("c\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	after := mustFingerprint(t, repo)
	if before.Working == after.Working {
		t.Error("Working fingerprint did not change when a file joined an untracked dir")
	}
}

func TestFingerprintHandlesDeletedAndRenamedFiles(t *testing.T) {
	repo, run := newRemoteRepo(t)
	commitFile(t, repo, "keep me.txt", "x\n")
	before := mustFingerprint(t, repo)
	run("mv", "keep me.txt", "moved file.txt")
	renamed := mustFingerprint(t, repo)
	if before.Working == renamed.Working {
		t.Error("rename not reflected")
	}
	if err := os.Remove(filepath.Join(repo, "a.txt")); err != nil {
		t.Fatal(err)
	}
	deleted := mustFingerprint(t, repo)
	if renamed.Working == deleted.Working {
		t.Error("deletion not reflected")
	}
}

func TestFingerprintFullChangesWhenRefMoves(t *testing.T) {
	repo, run := newRemoteRepo(t)
	before := mustFingerprint(t, repo, "origin/main")
	commitFile(t, repo, "b.txt", "b\n")
	run("push", "origin", "main")
	run("reset", "--hard", "HEAD~1") // HEAD back where it was; only the ref moved
	after := mustFingerprint(t, repo, "origin/main")
	if before.Working != after.Working {
		t.Errorf("Working changed though the tree is clean: %q vs %q", before.Working, after.Working)
	}
	if before.Full == after.Full {
		t.Error("Full did not change when origin/main advanced")
	}
}

func TestFingerprintOnRepoWithNoCommits(t *testing.T) {
	repo := t.TempDir()
	runIn(t, repo, "init", "-b", "main")
	if _, err := ComputeFingerprint(repo, "origin/main"); err != nil {
		t.Fatal(err)
	}
}
