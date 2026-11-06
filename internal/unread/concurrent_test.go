package unread_test

import (
	"fmt"
	"sync"
	"testing"

	"github.com/mturley/worktree/internal/unread"
)

// Mark all read fires one mark per resource at once. Each Mark is a
// read-then-write transaction; begun DEFERRED, two of them deadlock on the
// lock upgrade and SQLite answers one with SQLITE_BUSY without waiting.
func TestConcurrentMarksDoNotFailBusy(t *testing.T) {
	conn := openDB(t)
	const n = 8
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("o/r#%d", i)
		addEvent(t, conn, fmt.Sprintf("e%d", i), "2026-01-01T00:00:01Z", "pr", id)
		if err := unread.EnsureCursor(conn, "pr", id); err != nil {
			t.Fatal(err)
		}
	}
	for round := 0; round < 20; round++ {
		var wg sync.WaitGroup
		errs := make(chan error, n)
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				ts := fmt.Sprintf("2026-01-01T00:%02d:%02dZ", round, i+2)
				if _, err := unread.Mark(conn, "pr", fmt.Sprintf("o/r#%d", i), ts); err != nil {
					errs <- err
				}
			}(i)
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatalf("round %d: %v", round, err)
		}
	}
}
