package testgit

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/discovery"
)

func TestWorktreeIsALinkedWorktree(t *testing.T) {
	path := Worktree(t)
	if _, ok := discovery.IsInsideWorktree(path); !ok {
		t.Fatalf("%s must be a linked git worktree", path)
	}
}

func TestWorktreeReturnsDistinctPaths(t *testing.T) {
	if a, b := Worktree(t), Worktree(t); a == b {
		t.Fatalf("two calls returned the same path: %s", a)
	}
}

func TestWorktreeCopiesAreIndependent(t *testing.T) {
	a, b := Worktree(t), Worktree(t)
	top := func(dir string) string {
		out, err := exec.Command("git", "-C", dir, "rev-parse", "--show-toplevel", "--git-common-dir").Output()
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	ta, tb := top(a), top(b)
	if ta == tb {
		t.Fatalf("copies share git metadata:\n%s", ta)
	}
	for _, s := range []string{ta, tb} {
		if strings.Contains(s, "tmpl-") {
			t.Fatalf("copy still points into the template:\n%s", s)
		}
	}
}

func TestMain(m *testing.M) {
	defer RemoveTemplates()
	m.Run()
}
