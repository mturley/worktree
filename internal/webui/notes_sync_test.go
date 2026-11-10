package webui

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/notes"
)

// syncFixture is a server with one registered worktree whose cmux listing
// and description pushes are stubs the test can change between syncs.
type syncFixture struct {
	s    *Server
	path string

	mu      sync.Mutex
	listing []cmux.Workspace
	pushes  [][2]string
	pushErr error
}

func strp(s string) *string { return &s }

func newSyncFixture(t *testing.T, workspaces ...cmux.Workspace) *syncFixture {
	t.Helper()
	s, path, _ := notesServer(t, nil, nil)
	f := &syncFixture{s: s, path: path}
	f.setListing(workspaces...)
	s.cmuxAvailable = func() bool { return true }
	s.cmuxList = func() ([]cmux.Workspace, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		return append([]cmux.Workspace(nil), f.listing...), nil
	}
	s.cmuxSetDescription = func(id, desc string) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.pushes = append(f.pushes, [2]string{id, desc})
		if f.pushErr != nil {
			return f.pushErr
		}
		for i := range f.listing {
			if f.listing[i].ID == id {
				f.listing[i].Description = strp(desc)
			}
		}
		return nil
	}
	return f
}

// setListing replaces the stubbed cmux listing; every workspace sits in the
// fixture's worktree.
func (f *syncFixture) setListing(workspaces ...cmux.Workspace) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range workspaces {
		workspaces[i].CurrentDirectory = f.path
	}
	f.listing = workspaces
}

// seed stores notes with sync on and the given base.
func (f *syncFixture) seed(t *testing.T, text string, base *string, baseWorkspace string) {
	t.Helper()
	if _, ok, err := notes.CompareAndSet(f.s.DB, f.path, 0, text, true, true, base, baseWorkspace); err != nil || !ok {
		t.Fatalf("seed: ok=%v err=%v", ok, err)
	}
}

func (f *syncFixture) sync(t *testing.T, listed *cmux.Workspace) string {
	t.Helper()
	unlock := f.s.notesLock(f.path)
	defer unlock()
	outcome, msg := f.s.syncNotesLocked(f.path, listed)
	if outcome == cmuxSyncFailed || outcome == cmuxSyncSkipped {
		t.Logf("sync %s: %s", outcome, msg)
	}
	return outcome
}

func (f *syncFixture) notes(t *testing.T) notes.Notes {
	t.Helper()
	n, err := notes.Get(f.s.DB, f.path)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func (f *syncFixture) pushed() [][2]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][2]string(nil), f.pushes...)
}

func baseIs(n notes.Notes, text, ws string) bool {
	return n.CmuxBase != nil && *n.CmuxBase == text && n.CmuxBaseWorkspace == ws
}

func TestSyncNotesPullsCmuxEdit(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("a\nb")})
	f.seed(t, "a", strp("a"), "W1")
	if got := f.sync(t, nil); got != cmuxSyncOK {
		t.Fatalf("outcome = %q", got)
	}
	n := f.notes(t)
	if n.Text != "a\nb" || !baseIs(n, "a\nb", "W1") {
		t.Fatalf("notes = %q base = %v/%q", n.Text, n.CmuxBase, n.CmuxBaseWorkspace)
	}
	if p := f.pushed(); len(p) != 0 {
		t.Fatalf("a pull must not push, got %v", p)
	}
}

func TestSyncNotesPushesNotesEdit(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Ref: "workspace:2", Description: strp("a")})
	f.seed(t, "a\nn", strp("a"), "W1")
	if got := f.sync(t, nil); got != cmuxSyncOK {
		t.Fatalf("outcome = %q", got)
	}
	if p := f.pushed(); len(p) != 1 || p[0] != [2]string{"W1", "a\nn"} {
		t.Fatalf("pushes = %v, want one push of the notes by ID", p)
	}
	n := f.notes(t)
	if n.Text != "a\nn" || n.Version != 1 || !baseIs(n, "a\nn", "W1") {
		t.Fatalf("notes = %+v base %v", n, n.CmuxBase)
	}
}

func TestSyncNotesPushFailureKeepsBase(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("a")})
	f.pushErr = errors.New("cmux said no")
	f.seed(t, "a\nn", strp("a"), "W1")
	if got := f.sync(t, nil); got != cmuxSyncFailed {
		t.Fatalf("outcome = %q", got)
	}
	if n := f.notes(t); n.Text != "a\nn" || !baseIs(n, "a", "W1") {
		t.Fatalf("notes = %q base = %v", n.Text, n.CmuxBase)
	}
}

func TestSyncNotesMergesBoth(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("one\ntwo\nthree\ncmux")})
	f.seed(t, "notes\none\ntwo\nthree", strp("one\ntwo\nthree"), "W1")
	if got := f.sync(t, nil); got != cmuxSyncOK {
		t.Fatalf("outcome = %q", got)
	}
	want := "notes\none\ntwo\nthree\ncmux"
	n := f.notes(t)
	if n.Text != want || !baseIs(n, want, "W1") {
		t.Fatalf("notes = %q base = %v", n.Text, n.CmuxBase)
	}
	if p := f.pushed(); len(p) != 1 || p[0] != [2]string{"W1", want} {
		t.Fatalf("pushes = %v", p)
	}
}

func TestSyncNotesRelistsBeforePull(t *testing.T) {
	t.Parallel()
	// The fresh listing says cmux still holds the base: the stale "old" in the
	// caller's listing must not be pulled.
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("a")})
	f.seed(t, "a", strp("a"), "W1")
	stale := cmux.Workspace{ID: "W1", CurrentDirectory: f.path, Description: strp("old")}
	if got := f.sync(t, &stale); got != cmuxSyncOK {
		t.Fatalf("outcome = %q", got)
	}
	if n := f.notes(t); n.Text != "a" || n.Version != 1 {
		t.Fatalf("notes = %q v%d, want unchanged", n.Text, n.Version)
	}
	if p := f.pushed(); len(p) != 0 {
		t.Fatalf("pushes = %v", p)
	}
}

func TestSyncNotesRelistSkipsWhenWorkspaceGone(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t)
	f.seed(t, "a", strp("a"), "W1")
	stale := cmux.Workspace{ID: "W1", CurrentDirectory: f.path, Description: strp("old")}
	if got := f.sync(t, &stale); got != cmuxSyncSkipped {
		t.Fatalf("outcome = %q", got)
	}
	if n := f.notes(t); n.Text != "a" {
		t.Fatalf("notes = %q", n.Text)
	}
}

func TestSyncNotesNewWorkspaceDoesNotWipe(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W2"})
	f.seed(t, "n", strp("n"), "W1")
	listed := cmux.Workspace{ID: "W2", CurrentDirectory: f.path}
	if got := f.sync(t, &listed); got != cmuxSyncOK {
		t.Fatalf("outcome = %q", got)
	}
	if p := f.pushed(); len(p) != 1 || p[0] != [2]string{"W2", "n"} {
		t.Fatalf("pushes = %v", p)
	}
	if n := f.notes(t); n.Text != "n" || !baseIs(n, "n", "W2") {
		t.Fatalf("notes = %q base = %v/%q", n.Text, n.CmuxBase, n.CmuxBaseWorkspace)
	}
}

func TestSyncNotesMergeRetriedAfterFailedPushDoesNotNest(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("x cmux")})
	f.seed(t, "x notes", strp("x"), "W1")
	f.pushErr = errors.New("cmux said no")
	if got := f.sync(t, nil); got != cmuxSyncFailed {
		t.Fatalf("first outcome = %q", got)
	}
	merged := f.notes(t).Text
	if strings.Count(merged, "<<<<<<< notes") != 1 {
		t.Fatalf("first merge = %q, want one conflict block", merged)
	}

	f.mu.Lock()
	f.pushErr = nil
	f.mu.Unlock()
	if got := f.sync(t, nil); got != cmuxSyncOK {
		t.Fatalf("second outcome = %q", got)
	}
	p := f.pushed()
	last := p[len(p)-1]
	if last[1] != merged || strings.Count(last[1], "<<<<<<< notes") != 1 {
		t.Fatalf("pushed %q, want the first merge %q unchanged", last[1], merged)
	}
	if n := f.notes(t); n.Text != merged || !baseIs(n, merged, "W1") {
		t.Fatalf("notes = %q base = %v", n.Text, n.CmuxBase)
	}
}

func TestSyncNotesNoneRecordsMissingBase(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("same")})
	f.seed(t, "same", nil, "")
	if got := f.sync(t, nil); got != cmuxSyncOK {
		t.Fatalf("outcome = %q", got)
	}
	if n := f.notes(t); !baseIs(n, "same", "W1") || n.Version != 1 {
		t.Fatalf("base = %v/%q v%d", n.CmuxBase, n.CmuxBaseWorkspace, n.Version)
	}
	if p := f.pushed(); len(p) != 0 {
		t.Fatalf("pushes = %v", p)
	}
}

func TestSyncNotesOffAndSkipped(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("c")})
	if got := f.sync(t, nil); got != cmuxSyncOff {
		t.Fatalf("no row: outcome = %q", got)
	}
	f.seed(t, "n", nil, "")
	f.setListing(cmux.Workspace{ID: "W1"}, cmux.Workspace{ID: "W2"})
	if got := f.sync(t, nil); got != cmuxSyncSkipped {
		t.Fatalf("two workspaces: outcome = %q", got)
	}
	f.s.cmuxAvailable = func() bool { return false }
	if got := f.sync(t, nil); got != cmuxSyncSkipped {
		t.Fatalf("cmux unavailable: outcome = %q", got)
	}
	if p := f.pushed(); len(p) != 0 {
		t.Fatalf("pushes = %v", p)
	}
}

func TestSyncNotesWriteDuringPushIsPushedNotMerged(t *testing.T) {
	t.Parallel()
	// Another process (the CLI) writes the notes while the push is in flight,
	// so the base write misses. Both sides did agree on the pushed text, so
	// the retry pushes the new notes instead of merging against the old base.
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("a")})
	f.seed(t, "a\nn", strp("a"), "W1")
	push := f.s.cmuxSetDescription
	first := true
	f.s.cmuxSetDescription = func(id, desc string) error {
		if first {
			first = false
			if _, err := notes.Set(f.s.DB, f.path, "cli", true, true); err != nil {
				t.Error(err)
			}
		}
		return push(id, desc)
	}
	if got := f.sync(t, nil); got != cmuxSyncOK {
		t.Fatalf("outcome = %q", got)
	}
	if p := f.pushed(); len(p) != 2 || p[0][1] != "a\nn" || p[1][1] != "cli" {
		t.Fatalf("pushes = %v", p)
	}
	if n := f.notes(t); n.Text != "cli" || !baseIs(n, "cli", "W1") {
		t.Fatalf("notes = %q base = %v", n.Text, n.CmuxBase)
	}
}
