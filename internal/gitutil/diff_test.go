package gitutil

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestDiffFilesCountsAndStatuses(t *testing.T) {
	repo, run := newRemoteRepo(t)
	commitFile(t, repo, "mod.txt", "1\n2\n3\n")
	commitFile(t, repo, "del.txt", "x\ny\n")
	old := run("rev-parse", "HEAD")
	writeFile(t, repo, "mod.txt", "1\nTWO\n3\n4\n")
	writeFile(t, repo, "new.txt", "a\nb\nc\n")
	run("rm", "-q", "del.txt")
	run("add", "-A")
	run("commit", "-m", "change")

	got, err := DiffFiles(repo, old, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	want := []FileChange{
		{Path: "del.txt", Status: "D", Deletions: 2},
		{Path: "mod.txt", Status: "M", Additions: 2, Deletions: 1},
		{Path: "new.txt", Status: "A", Additions: 3},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestDiffFilesRename(t *testing.T) {
	repo, run := newRemoteRepo(t)
	commitFile(t, repo, "big.txt", "1\n2\n3\n4\n5\n6\n7\n8\n")
	old := run("rev-parse", "HEAD")
	run("mv", "big.txt", "moved.txt")
	writeFile(t, repo, "moved.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n")
	run("add", "-A")
	run("commit", "-m", "rename")

	got, err := DiffFiles(repo, old, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	want := []FileChange{{Path: "moved.txt", OldPath: "big.txt", Status: "R", Additions: 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestDiffFilesBinary(t *testing.T) {
	repo, run := newRemoteRepo(t)
	old := run("rev-parse", "HEAD")
	writeFile(t, repo, "img.png", "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x01")
	run("add", "img.png")
	run("commit", "-m", "png")

	got, err := DiffFiles(repo, old, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	want := []FileChange{{Path: "img.png", Status: "A", Binary: true}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestDiffFilesOddPaths(t *testing.T) {
	repo, run := newRemoteRepo(t)
	old := run("rev-parse", "HEAD")
	odd := "dir with space/naïve \"q\".go"
	writeFile(t, repo, odd, "package x\n")
	run("add", "-A")
	run("commit", "-m", "odd")

	got, err := DiffFiles(repo, old, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Path != odd || got[0].Status != "A" || got[0].Additions != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestDiffFilesAgainstSnapshotTree(t *testing.T) {
	repo, run := newRemoteRepo(t)
	old := run("rev-parse", "HEAD")
	writeFile(t, repo, "wip.txt", "untracked\n")
	tree, err := SnapshotWorkingTree(repo)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DiffFiles(repo, old, tree)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Path != "wip.txt" || got[0].Status != "A" {
		t.Fatalf("got %+v", got)
	}
}

func TestDiffPatchIgnoreWhitespace(t *testing.T) {
	repo, run := newRemoteRepo(t)
	old := run("rev-parse", "HEAD")
	writeFile(t, repo, "a.txt", "one \n")
	run("commit", "-qam", "ws")

	p, err := DiffPatch(repo, old, "HEAD", false)
	if err != nil || !strings.Contains(p, "+one ") {
		t.Fatalf("patch=%q err=%v", p, err)
	}
	p, err = DiffPatch(repo, old, "HEAD", true)
	if err != nil || p != "" {
		t.Fatalf("expected empty patch with -w, got %q err=%v", p, err)
	}
}

func TestDiffPatchTooLarge(t *testing.T) {
	repo, run := newRemoteRepo(t)
	old := run("rev-parse", "HEAD")
	writeFile(t, repo, "a.txt", strings.Repeat("line\n", 100))
	run("commit", "-qam", "big")

	defer func(n int) { MaxPatchBytes = n }(MaxPatchBytes)
	MaxPatchBytes = 50
	if _, err := DiffPatch(repo, old, "HEAD", false); !errors.Is(err, ErrPatchTooLarge) {
		t.Fatalf("err=%v, want ErrPatchTooLarge", err)
	}
}

func TestShowFileFromSnapshotTree(t *testing.T) {
	repo, _ := newRemoteRepo(t)
	writeFile(t, repo, "a.txt", "at snapshot\n")
	tree, err := SnapshotWorkingTree(repo)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, repo, "a.txt", "edited later\n")

	got, err := ShowFile(repo, tree, "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "at snapshot\n" {
		t.Fatalf("got %q", got)
	}
}

// The user's git config must not leak into output the server parses or the
// UI renders: colour codes, missing a/ b/ prefixes or signature lines would
// all break it.
func TestDiffAndLogIgnoreUserConfig(t *testing.T) {
	repo, run := newRemoteRepo(t)
	run("config", "color.diff", "always")
	run("config", "color.ui", "always")
	run("config", "diff.noprefix", "true")
	run("config", "log.showSignature", "true")
	commitFile(t, repo, "b.txt", "two\n")

	patch, err := DiffPatch(repo, "origin/main", "HEAD", false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(patch, "diff --git a/b.txt b/b.txt") {
		t.Errorf("patch does not start with an a/ b/ header: %q", patch)
	}
	if strings.Contains(patch, "\x1b") {
		t.Errorf("patch contains ESC bytes: %q", patch)
	}
	files, err := DiffFiles(repo, "origin/main", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Path != "b.txt" {
		t.Errorf("DiffFiles = %+v, want b.txt", files)
	}
	commits, err := FirstParentCommits(repo, "origin/main")
	if err != nil {
		t.Fatal(err)
	}
	if len(commits) != 1 || commits[0].Subject != "add b.txt" {
		t.Errorf("FirstParentCommits = %+v, want one 'add b.txt'", commits)
	}
}
