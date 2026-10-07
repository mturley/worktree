package selfid

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

func TestSetAndLoad(t *testing.T) {
	conn := testDB(t)
	if err := Set(conn, "github", "101"); err != nil {
		t.Fatal(err)
	}
	if err := Set(conn, "github", "102"); err != nil { // upsert
		t.Fatal(err)
	}
	Set(conn, "slack", "U1")
	got, err := Load(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got["github"] != "102" || got["slack"] != "U1" || len(got) != 2 {
		t.Fatalf("Load = %v", got)
	}
}

func TestNotMineSQLMatchesSourceAndID(t *testing.T) {
	conn := testDB(t)
	Set(conn, "github", "101")
	ins := func(id, source, authorID string) {
		var a any
		if authorID != "" {
			a = authorID
		}
		if _, err := conn.Exec(`INSERT INTO watcher_events (id, ts, source, type, title, author_id)
			VALUES (?, '2026-01-01T00:00:00Z', ?, 'pr_comment', 't', ?)`, id, source, a); err != nil {
			t.Fatal(err)
		}
	}
	ins("mine", "github", "101")
	ins("other", "github", "202")
	ins("same-id-other-source", "jira", "101")
	ins("authorless", "github", "")
	rows, err := conn.Query(`SELECT e.id FROM watcher_events e WHERE ` + NotMineSQL + ` ORDER BY e.id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		got = append(got, id)
	}
	want := "authorless,other,same-id-other-source"
	if j := join(got); j != want {
		t.Fatalf("not-mine rows = %s, want %s", j, want)
	}
}

func TestIsMine(t *testing.T) {
	ids := map[string]string{"github": "101"}
	if !IsMine(ids, "github", "101") || IsMine(ids, "jira", "101") || IsMine(ids, "github", "") || IsMine(nil, "github", "101") {
		t.Fatal("IsMine wrong")
	}
}

func join(s []string) string {
	out := ""
	for i, v := range s {
		if i > 0 {
			out += ","
		}
		out += v
	}
	return out
}
