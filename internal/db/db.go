package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	watcherdb "github.com/mturley/watcher/db"
	_ "modernc.org/sqlite"
)

// Path returns the resolved worktree DB path:
// ${XDG_DATA_HOME:-~/.local/share}/worktree/worktree.db, overridable via WORKTREE_DB.
func Path() string {
	if p := os.Getenv("WORKTREE_DB"); p != "" {
		return p
	}
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "worktree", "worktree.db")
}

// Open opens (creating as needed) the worktree DB at the standard path.
func Open() (*sql.DB, error) {
	return OpenAt(Path())
}

// OpenAt opens (creating as needed) the worktree DB at path, running the
// watcher library migration then worktree's own migration.
func OpenAt(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("creating db dir: %w", err)
	}
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)", path)
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening db: %w", err)
	}
	if err := watcherdb.Migrate(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("watcher migrate: %w", err)
	}
	if err := migrate(conn); err != nil {
		conn.Close()
		return nil, fmt.Errorf("worktree migrate: %w", err)
	}
	return conn, nil
}
