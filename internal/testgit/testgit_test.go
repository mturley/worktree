package testgit

import (
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
