package gitutil

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/testgit"
)

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotIncludesModifiedAndUntracked(t *testing.T) {
	repo, run := newRemoteRepo(t)
	writeFile(t, repo, "a.txt", "changed\n")
	writeFile(t, repo, "new/deep/file.txt", "fresh\n")

	tree, err := SnapshotWorkingTree(repo)
	if err != nil {
		t.Fatal(err)
	}
	if got := run("show", tree+":new/deep/file.txt"); got != "fresh" {
		t.Fatalf("untracked file = %q, want fresh", got)
	}
	if got := run("show", tree+":a.txt"); got != "changed" {
		t.Fatalf("modified file = %q, want changed", got)
	}
}

func TestSnapshotExcludesIgnored(t *testing.T) {
	repo, run := newRemoteRepo(t)
	commitFile(t, repo, ".gitignore", ".env.local\n")
	writeFile(t, repo, ".env.local", "SECRET=1\n")

	tree, err := SnapshotWorkingTree(repo)
	if err != nil {
		t.Fatal(err)
	}
	if listing := run("ls-tree", "-r", tree); strings.Contains(listing, ".env.local") {
		t.Fatalf("ignored file in snapshot:\n%s", listing)
	}
}

func TestSnapshotLeavesRealIndexUntouched(t *testing.T) {
	repo, run := newRemoteRepo(t)
	writeFile(t, repo, "a.txt", "changed\n")
	writeFile(t, repo, "untracked.txt", "x\n")
	indexPath := run("rev-parse", "--absolute-git-dir") + "/index"
	hash := func() [32]byte {
		b, err := os.ReadFile(indexPath)
		if err != nil {
			t.Fatal(err)
		}
		return sha256.Sum256(b)
	}
	beforeHash, beforeStatus := hash(), run("status", "--porcelain")

	if _, err := SnapshotWorkingTree(repo); err != nil {
		t.Fatal(err)
	}
	if hash() != beforeHash {
		t.Fatal("real index file changed")
	}
	if got := run("status", "--porcelain"); got != beforeStatus {
		t.Fatalf("status changed:\nbefore %q\nafter  %q", beforeStatus, got)
	}
}

func TestSnapshotInLinkedWorktree(t *testing.T) {
	wt := testgit.Worktree(t)
	writeFile(t, wt, "linked.txt", "from worktree\n")

	tree, err := SnapshotWorkingTree(wt)
	if err != nil {
		t.Fatal(err)
	}
	if got := runIn(t, wt, "show", tree+":linked.txt"); got != "from worktree" {
		t.Fatalf("linked.txt = %q", got)
	}
}
