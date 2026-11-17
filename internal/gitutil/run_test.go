package gitutil

import (
	"testing"
)

// TestSpawnCountIncrements asserts SpawnCount reflects exactly the number of
// git processes started by gitRaw. It must NOT call t.Parallel(): the counter
// is process-wide, and Go only runs parallel tests after serial ones finish.
func TestSpawnCountIncrements(t *testing.T) {
	dir := t.TempDir()
	runIn(t, dir, "init", "-b", "main")

	before := SpawnCount()
	if _, ok := CurrentBranch(dir); !ok {
		t.Fatalf("CurrentBranch failed")
	}
	if _, ok := RevSHA(dir, "HEAD"); ok {
		t.Fatalf("RevSHA should be false on an empty repo, got ok")
	}

	if got := SpawnCount() - before; got != 2 {
		t.Fatalf("SpawnCount() delta = %d, want 2", got)
	}
}
