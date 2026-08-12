package cmd

import "testing"

func TestConsumerName(t *testing.T) {
	if consumerName != "worktree" {
		t.Fatalf("consumer name must be stable %q, got %q", "worktree", consumerName)
	}
}
