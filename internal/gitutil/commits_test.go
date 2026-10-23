package gitutil

import (
	"errors"
	"path/filepath"
	"testing"
)

// commitSubject commits a file whose subject is exactly subject.
func commitSubject(t *testing.T, dir, name, subject string) {
	t.Helper()
	commitFile(t, dir, name, name+"\n")
	runIn(t, dir, "commit", "--amend", "-m", subject)
}

// advanceOriginMain pushes n commits to origin/main from a second clone and
// fetches them into repo.
func advanceOriginMain(t *testing.T, repo string, n int) {
	t.Helper()
	otherBase := t.TempDir()
	other := filepath.Join(otherBase, "other")
	runIn(t, otherBase, "clone", runIn(t, repo, "config", "remote.origin.url"), other)
	for i := 0; i < n; i++ {
		commitFile(t, other, "m"+string(rune('1'+i))+".txt", "m")
	}
	runIn(t, other, "push", "origin", "main")
	runIn(t, repo, "fetch", "origin")
}

func subjects(commits []Commit) []string {
	var out []string
	for _, c := range commits {
		out = append(out, c.Subject)
	}
	return out
}

// threeCommits builds a feature branch with c1..c3 (oldest to newest).
func threeCommits(t *testing.T) (repo string, run func(args ...string) string, shas [3]string) {
	repo, run = newRemoteRepo(t)
	run("checkout", "-b", "feature")
	for i, n := range []string{"c1", "c2", "c3"} {
		commitSubject(t, repo, n+".txt", n)
		shas[i] = run("rev-parse", "HEAD")
	}
	return
}

func TestFirstParentCommitsNewestFirst(t *testing.T) {
	repo, _, shas := threeCommits(t)
	got, err := FirstParentCommits(repo, "origin/main")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"c3", "c2", "c1"}
	gs := subjects(got)
	if len(gs) != 3 || gs[0] != want[0] || gs[1] != want[1] || gs[2] != want[2] {
		t.Fatalf("subjects = %v, want %v", gs, want)
	}
	if got[0].SHA != shas[2] || got[0].Short == "" || got[0].Author != "t" || got[0].Date.IsZero() {
		t.Fatalf("commit fields = %+v", got[0])
	}
}

func TestFirstParentCommitsSkipsMergedMainCommits(t *testing.T) {
	repo, run := newRemoteRepo(t)
	run("checkout", "-b", "feature")
	commitSubject(t, repo, "f1.txt", "f1")
	advanceOriginMain(t, repo, 2)
	run("merge", "--no-ff", "-m", "merge main", "origin/main")
	got, err := FirstParentCommits(repo, "origin/main")
	if err != nil {
		t.Fatal(err)
	}
	gs := subjects(got)
	if len(gs) != 2 || gs[0] != "merge main" || gs[1] != "f1" {
		t.Fatalf("subjects = %v, want [merge main f1]", gs)
	}
}

func TestFirstParentCommitsNoCommits(t *testing.T) {
	dir := t.TempDir()
	runIn(t, dir, "init", "-b", "main")
	got, err := FirstParentCommits(dir, "origin/main")
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("got (%v, %v), want empty, nil", got, err)
	}
}

func TestResolveAllChanges(t *testing.T) {
	repo, _, _ := threeCommits(t)
	commits, _ := FirstParentCommits(repo, "origin/main")
	mb, _ := MergeBase(repo, "origin/main")
	old, nw, err := ResolveRange(repo, "origin/main", commits, Range{})
	if err != nil {
		t.Fatal(err)
	}
	if old != mb {
		t.Errorf("old = %s, want merge base %s", old, mb)
	}
	if typ := runIn(t, repo, "cat-file", "-t", nw); typ != "tree" {
		t.Errorf("new %s is a %s, want tree", nw, typ)
	}
}

func TestResolveAllCommits(t *testing.T) {
	repo, run, shas := threeCommits(t)
	commits, _ := FirstParentCommits(repo, "origin/main")
	mb, _ := MergeBase(repo, "origin/main")
	old, nw, err := ResolveRange(repo, "origin/main", commits, Range{From: shas[0], To: shas[2]})
	if err != nil {
		t.Fatal(err)
	}
	if old != mb || nw != run("rev-parse", "HEAD") {
		t.Errorf("got (%s, %s), want (%s, HEAD)", old, nw, mb)
	}
}

func TestResolveFullRunAfterMergingMainUsesMergeBase(t *testing.T) {
	repo, run := newRemoteRepo(t)
	run("checkout", "-b", "feature")
	commitSubject(t, repo, "f1.txt", "f1")
	advanceOriginMain(t, repo, 1)
	run("merge", "--no-ff", "-m", "merge main", "origin/main")
	commits, _ := FirstParentCommits(repo, "origin/main")
	mb, _ := MergeBase(repo, "origin/main")
	oldest := commits[len(commits)-1].SHA
	old, _, err := ResolveRange(repo, "origin/main", commits, Range{From: oldest, To: commits[0].SHA})
	if err != nil {
		t.Fatal(err)
	}
	if old != mb {
		t.Errorf("old = %s, want merge base %s", old, mb)
	}
	// Merging main in moves the merge base to main's tip; oldest^1 is the
	// pre-merge commit and must not be what we diff from.
	if parent := run("rev-parse", oldest+"^"); old == parent {
		t.Errorf("old must be the merge base, not oldest^1 (%s)", parent)
	}
}

func TestResolveMiddleRun(t *testing.T) {
	repo, run, shas := threeCommits(t)
	commits, _ := FirstParentCommits(repo, "origin/main")
	old, nw, err := ResolveRange(repo, "origin/main", commits, Range{From: shas[1], To: shas[2]})
	if err != nil {
		t.Fatal(err)
	}
	if old != run("rev-parse", shas[1]+"^") || nw != shas[2] {
		t.Errorf("got (%s, %s), want (c2^, c3)", old, nw)
	}
}

func TestResolveUncommittedPlusCommit(t *testing.T) {
	repo, _, shas := threeCommits(t)
	commits, _ := FirstParentCommits(repo, "origin/main")
	old, nw, err := ResolveRange(repo, "origin/main", commits, Range{From: shas[2], To: Uncommitted})
	if err != nil {
		t.Fatal(err)
	}
	if old != runIn(t, repo, "rev-parse", shas[2]+"^") {
		t.Errorf("old = %s", old)
	}
	if typ := runIn(t, repo, "cat-file", "-t", nw); typ != "tree" {
		t.Errorf("new is a %s, want tree", typ)
	}
}

func TestResolveUncommittedOnly(t *testing.T) {
	repo, run, _ := threeCommits(t)
	commits, _ := FirstParentCommits(repo, "origin/main")
	old, nw, err := ResolveRange(repo, "origin/main", commits, Range{From: Uncommitted, To: Uncommitted})
	if err != nil {
		t.Fatal(err)
	}
	if old != run("rev-parse", "HEAD") {
		t.Errorf("old = %s, want HEAD", old)
	}
	if typ := run("cat-file", "-t", nw); typ != "tree" {
		t.Errorf("new is a %s, want tree", typ)
	}
}

func TestResolveRejectsUnknownSHA(t *testing.T) {
	repo, _, shas := threeCommits(t)
	commits, _ := FirstParentCommits(repo, "origin/main")
	for _, r := range []Range{
		{From: "deadbeef", To: shas[2]},
		{From: shas[0], To: "deadbeef"},
		{From: shas[0]}, // half-specified
	} {
		if _, _, err := ResolveRange(repo, "origin/main", commits, r); !errors.Is(err, ErrInvalidRange) {
			t.Errorf("%+v: err = %v, want ErrInvalidRange", r, err)
		}
	}
}

func TestResolveRejectsReversedRange(t *testing.T) {
	repo, _, shas := threeCommits(t)
	commits, _ := FirstParentCommits(repo, "origin/main")
	for _, r := range []Range{
		{From: shas[2], To: shas[0]},
		{From: Uncommitted, To: shas[2]},
	} {
		if _, _, err := ResolveRange(repo, "origin/main", commits, r); !errors.Is(err, ErrInvalidRange) {
			t.Errorf("%+v: err = %v, want ErrInvalidRange", r, err)
		}
	}
}

func TestResolveMissingBaseRefErrors(t *testing.T) {
	repo, _, _ := threeCommits(t)
	if _, _, err := ResolveRange(repo, "origin/nope", nil, Range{}); err == nil {
		t.Fatal("want error for unresolvable merge base")
	}
}

func TestListIDChangesOnNewCommitNotOnMainAdvance(t *testing.T) {
	repo, _, _ := threeCommits(t)
	id := func() string {
		commits, err := FirstParentCommits(repo, "origin/main")
		if err != nil {
			t.Fatal(err)
		}
		mb, _ := MergeBase(repo, "origin/main")
		return ListID(commits, mb)
	}
	before := id()
	if len(before) != 16 {
		t.Fatalf("ListID = %q, want 16 chars", before)
	}
	advanceOriginMain(t, repo, 1)
	if got := id(); got != before {
		t.Errorf("main advancing changed ListID: %s -> %s", before, got)
	}
	commitSubject(t, repo, "c4.txt", "c4")
	if got := id(); got == before {
		t.Errorf("new commit did not change ListID")
	}
}
