package db

import "testing"

func TestSubscriberRoundTrip(t *testing.T) {
	sub := Subscriber("/tmp/wt/foo")
	if sub != "worktree:/tmp/wt/foo" {
		t.Fatalf("got %q", sub)
	}
	path, ok := WorktreePathFromSubscriber(sub)
	if !ok || path != "/tmp/wt/foo" {
		t.Fatalf("round-trip failed: %q %v", path, ok)
	}
	if _, ok := WorktreePathFromSubscriber("handler:session:abc"); ok {
		t.Fatal("non-worktree subscriber must return ok=false")
	}
}

func TestSubscriberCleansPath(t *testing.T) {
	if got := Subscriber("/tmp/wt/../wt/foo/"); got != "worktree:/tmp/wt/foo" {
		t.Fatalf("expected cleaned path, got %q", got)
	}
}
