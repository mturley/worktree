package tasks

import (
	"database/sql"
	"errors"
	"reflect"
	"testing"
)

// masterOrder returns every row's id (deleted included) ordered by (rank, id).
func masterOrder(t *testing.T, conn *sql.DB) []int64 {
	t.Helper()
	rows, err := conn.Query(`SELECT id FROM tasks ORDER BY rank, id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids
}

func ranks(t *testing.T, conn *sql.DB) map[int64]string {
	t.Helper()
	rows, err := conn.Query(`SELECT id, rank FROM tasks`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	m := map[int64]string{}
	for rows.Next() {
		var id int64
		var r string
		if err := rows.Scan(&id, &r); err != nil {
			t.Fatal(err)
		}
		m[id] = r
	}
	return m
}

func four(t *testing.T, conn *sql.DB) (a, b, c, d Task) {
	return mustCreate(t, conn, "A"), mustCreate(t, conn, "B"), mustCreate(t, conn, "C"), mustCreate(t, conn, "D")
}

func TestMoveAfterSkipsOnlyTheGap(t *testing.T) {
	conn := newDB(t)
	a, b, c, d := four(t, conn)
	if err := MoveAfter(conn, d.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	want := []int64{a.ID, d.ID, b.ID, c.ID}
	if got := masterOrder(t, conn); !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func TestMoveBeforeAndEdges(t *testing.T) {
	conn := newDB(t)
	a, b, c := mustCreate(t, conn, "A"), mustCreate(t, conn, "B"), mustCreate(t, conn, "C")
	check := func(want ...int64) {
		t.Helper()
		if got := masterOrder(t, conn); !reflect.DeepEqual(got, want) {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
	if err := MoveBefore(conn, c.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	check(c.ID, a.ID, b.ID)
	if err := MoveToBottom(conn, c.ID); err != nil {
		t.Fatal(err)
	}
	check(a.ID, b.ID, c.ID)
	if err := MoveToTop(conn, b.ID); err != nil {
		t.Fatal(err)
	}
	check(b.ID, a.ID, c.ID)
}

func TestMoveRewritesOnlyMovedRow(t *testing.T) {
	conn := newDB(t)
	a, _, _, d := four(t, conn)
	before := ranks(t, conn)
	if err := MoveAfter(conn, d.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	after := ranks(t, conn)
	for id, r := range before {
		if id != d.ID && after[id] != r {
			t.Fatalf("task %d rank changed %q -> %q", id, r, after[id])
		}
	}
	if after[d.ID] == before[d.ID] {
		t.Fatal("moved row's rank did not change")
	}
}

func TestMoveAroundDeletedNeighbour(t *testing.T) {
	conn := newDB(t)
	a, b, c := mustCreate(t, conn, "A"), mustCreate(t, conn, "B"), mustCreate(t, conn, "C")
	if err := Delete(conn, user, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := MoveAfter(conn, c.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	r := ranks(t, conn)
	if !(r[a.ID] < r[c.ID] && r[c.ID] < r[b.ID]) {
		t.Fatalf("want A < C < B, got %v", r)
	}
	if r[b.ID] != b.Rank {
		t.Fatal("deleted B's rank changed")
	}
}

func TestMoveSelfNoOpAndNotFound(t *testing.T) {
	conn := newDB(t)
	a, b := mustCreate(t, conn, "A"), mustCreate(t, conn, "B")
	before := ranks(t, conn)
	if err := MoveAfter(conn, a.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	if err := MoveBefore(conn, a.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, ranks(t, conn)) {
		t.Fatal("self move changed ranks")
	}
	if err := MoveAfter(conn, a.ID, 999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing ref: %v", err)
	}
	if err := MoveBefore(conn, 999, a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing id: %v", err)
	}
	if err := MoveToTop(conn, 999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("top missing: %v", err)
	}
	if err := MoveToBottom(conn, 999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bottom missing: %v", err)
	}
	if err := Delete(conn, user, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := MoveAfter(conn, a.ID, b.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted ref: %v", err)
	}
	if err := MoveAfter(conn, b.ID, a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted moved: %v", err)
	}
}

func TestMoveWritesNoEvent(t *testing.T) {
	conn := newDB(t)
	a, _, _, d := four(t, conn)
	n := count(t, conn, "task_events")
	if err := MoveAfter(conn, d.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	if count(t, conn, "task_events") != n {
		t.Fatal("move wrote an event")
	}
}

func TestMoveRelativeToTiedRanks(t *testing.T) {
	for _, after := range []bool{true, false} {
		for _, refIsFirst := range []bool{true, false} {
			conn := newDB(t)
			a, b, c, _ := four(t, conn)
			// Tie A and B: same rank, ordered by id.
			if _, err := conn.Exec(`UPDATE tasks SET rank = ? WHERE id = ?`, a.Rank, b.ID); err != nil {
				t.Fatal(err)
			}
			ref := b.ID
			if refIsFirst {
				ref = a.ID
			}
			var err error
			if after {
				err = MoveAfter(conn, c.ID, ref)
			} else {
				err = MoveBefore(conn, c.ID, ref)
			}
			if err != nil {
				t.Fatalf("after=%v ref=%d: %v", after, ref, err)
			}
			pos := map[int64]int{}
			order := masterOrder(t, conn)
			for i, id := range order {
				pos[id] = i
			}
			if after && pos[c.ID] < pos[ref] || !after && pos[c.ID] > pos[ref] {
				t.Fatalf("after=%v ref=%d: wrong side, order %v", after, ref, order)
			}
			if after && pos[c.ID] != pos[b.ID]+1 || !after && pos[c.ID] != pos[a.ID]-1 {
				t.Fatalf("after=%v: not just outside the tied group, order %v", after, order)
			}
		}
	}
}
