package webui

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
)

func TestCmuxPassPullsDescription(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("a\nb")})
	f.seed(t, "a", strp("a"), "W1")
	f.s.cmuxUnreadPass()
	if n := f.notes(t); n.Text != "a\nb" || !baseIs(n, "a\nb", "W1") {
		t.Fatalf("notes = %q base = %v", n.Text, n.CmuxBase)
	}
}

func TestCmuxPassSettledAfterMerge(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("a\nc")})
	f.seed(t, "a\nn", strp("a"), "W1")
	f.s.cmuxUnreadPass() // merges and pushes; the stub listing now holds the pushed text
	merged := f.notes(t)
	pushes := len(f.pushed())
	if pushes != 1 {
		t.Fatalf("first pass pushes = %d, want 1", pushes)
	}
	f.s.cmuxUnreadPass()
	after := f.notes(t)
	if after.Version != merged.Version || len(f.pushed()) != pushes {
		t.Fatalf("settled pass wrote: version %d -> %d, pushes %d -> %d",
			merged.Version, after.Version, pushes, len(f.pushed()))
	}
}

func TestCmuxPassRetriesFailedPush(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("a\nc")})
	f.seed(t, "x\na", strp("a"), "W1")
	f.mu.Lock()
	f.pushErr = errors.New("boom")
	f.mu.Unlock()
	f.s.cmuxUnreadPass()
	merged := f.notes(t).Text
	f.mu.Lock()
	f.pushErr = nil
	f.mu.Unlock()
	f.s.cmuxUnreadPass()
	n := f.notes(t)
	if n.Text != merged || strings.Contains(n.Text, "<<<<<<<") {
		t.Fatalf("notes = %q, want the first merge unchanged and unmarked", n.Text)
	}
	p := f.pushed()
	if len(p) != 2 || p[1][1] != merged {
		t.Fatalf("pushes = %v, want the merge pushed on the retry", p)
	}
}

func TestCmuxPassSaveBetweenListAndLock(t *testing.T) {
	t.Parallel()
	f := newSyncFixture(t, cmux.Workspace{ID: "W1", Description: strp("a\nn")})
	f.seed(t, "a\nn", strp("a\nn"), "W1")
	var mu sync.Mutex
	calls := 0
	fresh := f.s.cmuxList
	f.s.cmuxList = func() ([]cmux.Workspace, error) {
		mu.Lock()
		calls++
		first := calls == 1
		mu.Unlock()
		if first {
			// Stale: taken before the save pushed "a\nn".
			return []cmux.Workspace{{ID: "W1", CurrentDirectory: f.path, Description: strp("a")}}, nil
		}
		return fresh()
	}
	f.s.cmuxUnreadPass()
	if n := f.notes(t); n.Text != "a\nn" {
		t.Fatalf("notes = %q, want the saved text kept", n.Text)
	}
}
