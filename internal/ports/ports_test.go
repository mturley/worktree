package ports

import (
	"database/sql"
	"path/filepath"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestAllocateAssignsLowestFreeSlot(t *testing.T) {
	conn := testDB(t)
	a, _ := Allocate(conn, "alpha")
	b, _ := Allocate(conn, "beta")
	if a.Slot != 0 || b.Slot != 1 {
		t.Fatalf("slots: alpha=%d beta=%d", a.Slot, b.Slot)
	}
}

func TestAllocateIsIdempotentPerName(t *testing.T) {
	conn := testDB(t)
	a1, _ := Allocate(conn, "alpha")
	a2, _ := Allocate(conn, "alpha")
	if a1.Slot != a2.Slot {
		t.Fatalf("same name got different slots: %d %d", a1.Slot, a2.Slot)
	}
}

func TestReleaseFreesSlotForReuse(t *testing.T) {
	conn := testDB(t)
	Allocate(conn, "alpha") // slot 0
	Allocate(conn, "beta")  // slot 1
	if err := Release(conn, "alpha"); err != nil {
		t.Fatal(err)
	}
	c, _ := Allocate(conn, "gamma") // should reuse slot 0
	if c.Slot != 0 {
		t.Fatalf("expected freed slot 0 reused, got %d", c.Slot)
	}
}

func TestAllocationRange(t *testing.T) {
	a := Allocation{Slot: 0}
	if a.Range() != "4020-4029" {
		t.Fatalf("range: %s", a.Range())
	}
}
