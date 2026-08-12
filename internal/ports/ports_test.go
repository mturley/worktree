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

func TestLookupExistingAndMissing(t *testing.T) {
	conn := testDB(t)
	a, _ := Allocate(conn, "alpha")

	got, ok, err := Lookup(conn, "alpha")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || got.Slot != a.Slot {
		t.Fatalf("expected ok=true slot=%d, got ok=%v slot=%d", a.Slot, ok, got.Slot)
	}

	_, ok, err = Lookup(conn, "missing")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("expected ok=false for missing name")
	}
}

func TestAllocationRange(t *testing.T) {
	a := Allocation{Slot: 0}
	if a.Range() != "4020-4029" {
		t.Fatalf("range: %s", a.Range())
	}
}
