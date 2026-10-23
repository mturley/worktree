package reviewcomments

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	wdb "github.com/mturley/worktree/internal/db"
)

func testConn(t *testing.T) *sql.DB {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func newComment(file, body string) NewComment {
	return NewComment{
		File: file, Side: SideNew, Rev: RevUncommitted, Base: "main", BaseRef: "abc123",
		Anchor: Anchor{Start: 5, End: 6, Snippet: []string{"a", ""},
			Before: []string{"x", "", "y\r"}, After: []string{"z"}},
		Body: body,
	}
}

func TestCreateListRoundTrip(t *testing.T) {
	conn := testConn(t)
	wt := t.TempDir()
	if _, err := Create(conn, wt, newComment("b.go", "second")); err != nil {
		t.Fatal(err)
	}
	n := newComment("a.go", "first")
	n.Anchor = Anchor{Start: 2, End: 3, Snippet: []string{"", "\r"}, Before: []string{}, After: []string{"q"}}
	n.RangeFrom, n.RangeTo = "r1", "r2"
	if _, err := Create(conn, wt, n); err != nil {
		t.Fatal(err)
	}
	got, err := List(conn, wt)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].File != "a.go" || got[1].File != "b.go" {
		t.Fatalf("order: %+v", got)
	}
	if !reflect.DeepEqual(got[0].Anchor, n.Anchor) {
		t.Fatalf("anchor round trip: %+v vs %+v", got[0].Anchor, n.Anchor)
	}
	if !reflect.DeepEqual(got[1].Anchor, newComment("b.go", "").Anchor) {
		t.Fatalf("anchor round trip: %+v", got[1].Anchor)
	}
	c := got[0]
	if c.Version != 1 || c.Source != SourceDraft || c.Body != "first" || c.RangeFrom != "r1" ||
		c.RangeTo != "r2" || c.Side != SideNew || c.Rev != RevUncommitted || c.Base != "main" ||
		c.BaseRef != "abc123" || c.CreatedAt == "" || c.UpdatedAt == "" || c.ID == 0 {
		t.Fatalf("fields: %+v", c)
	}
}

func TestCreateRejectsInconsistentAnchor(t *testing.T) {
	conn := testConn(t)
	wt := t.TempDir()
	for name, a := range map[string]Anchor{
		"start zero":   {Start: 0, End: 0, Snippet: []string{"a"}},
		"end<start":    {Start: 3, End: 2, Snippet: []string{"a"}},
		"len mismatch": {Start: 3, End: 5, Snippet: []string{"a"}},
		"no snippet":   {Start: 3, End: 3},
	} {
		n := newComment("a.go", "x")
		n.Anchor = a
		if _, err := Create(conn, wt, n); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	if cs, _ := List(conn, wt); len(cs) != 0 {
		t.Fatalf("nothing should be stored: %+v", cs)
	}
}

func TestListScopedToWorktree(t *testing.T) {
	conn := testConn(t)
	a, b := t.TempDir(), t.TempDir()
	if _, err := Create(conn, a, newComment("a.go", "x")); err != nil {
		t.Fatal(err)
	}
	got, err := List(conn, b)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("leaked: %+v", got)
	}
}

func TestListCanonicalizesPath(t *testing.T) {
	conn := testConn(t)
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Create(conn, link, newComment("a.go", "x")); err != nil {
		t.Fatal(err)
	}
	got, err := List(conn, real)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestUpdateVersioning(t *testing.T) {
	conn := testConn(t)
	wt := t.TempDir()
	c, err := Create(conn, wt, newComment("a.go", "one"))
	if err != nil {
		t.Fatal(err)
	}
	u, err := Update(conn, wt, c.ID, 1, "two")
	if err != nil {
		t.Fatal(err)
	}
	if u.Version != 2 || u.Body != "two" {
		t.Fatalf("got %+v", u)
	}
	cur, err := Update(conn, wt, c.ID, 1, "three")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v", err)
	}
	if cur.Body != "two" || cur.Version != 2 {
		t.Fatalf("current = %+v", cur)
	}
}

func TestUpdateDeleted(t *testing.T) {
	conn := testConn(t)
	wt := t.TempDir()
	c, err := Create(conn, wt, newComment("a.go", "one"))
	if err != nil {
		t.Fatal(err)
	}
	if err := Delete(conn, wt, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := Update(conn, wt, c.ID, 1, "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestDeleteMissingIsNoop(t *testing.T) {
	conn := testConn(t)
	if err := Delete(conn, t.TempDir(), 999); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteAll(t *testing.T) {
	conn := testConn(t)
	a, b := t.TempDir(), t.TempDir()
	if _, err := Create(conn, a, newComment("a.go", "x")); err != nil {
		t.Fatal(err)
	}
	if _, err := Create(conn, b, newComment("a.go", "y")); err != nil {
		t.Fatal(err)
	}
	if err := DeleteAll(conn, a); err != nil {
		t.Fatal(err)
	}
	if got, _ := List(conn, a); len(got) != 0 {
		t.Fatalf("a: %+v", got)
	}
	if got, _ := List(conn, b); len(got) != 1 {
		t.Fatalf("b: %+v", got)
	}
}
