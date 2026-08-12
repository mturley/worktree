package registry

import (
	"database/sql"
	"os"
	"path/filepath"
)

type Entry struct {
	Path      string
	Repo      string
	RepoRoot  string
	Branch    string
	CreatedAt string
}

func Register(conn *sql.DB, e Entry) error {
	_, err := conn.Exec(
		`INSERT INTO worktrees (path, repo, repo_root, branch, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (path) DO UPDATE SET
		   repo = excluded.repo, repo_root = excluded.repo_root,
		   branch = excluded.branch, created_at = excluded.created_at`,
		e.Path, e.Repo, e.RepoRoot, e.Branch, e.CreatedAt)
	return err
}

func Unregister(conn *sql.DB, path string) error {
	_, err := conn.Exec(`DELETE FROM worktrees WHERE path = ?`, path)
	return err
}

func List(conn *sql.DB) ([]Entry, error) {
	rows, err := conn.Query(
		`SELECT path, repo, repo_root, branch, created_at FROM worktrees ORDER BY repo, path`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.Path, &e.Repo, &e.RepoRoot, &e.Branch, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func Get(conn *sql.DB, path string) (*Entry, error) {
	var e Entry
	err := conn.QueryRow(
		`SELECT path, repo, repo_root, branch, created_at FROM worktrees WHERE path = ?`, path).
		Scan(&e.Path, &e.Repo, &e.RepoRoot, &e.Branch, &e.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &e, nil
}

type ReconcileResult struct {
	Orphans []string // dirs under worktreesBase not registered in the DB
	Stale   []string // registered paths that no longer exist on disk
}

func Reconcile(conn *sql.DB, worktreesBase string) (ReconcileResult, error) {
	var res ReconcileResult
	entries, err := List(conn)
	if err != nil {
		return res, err
	}
	registered := make(map[string]bool)
	for _, e := range entries {
		registered[e.Path] = true
		if _, err := os.Stat(e.Path); os.IsNotExist(err) {
			res.Stale = append(res.Stale, e.Path)
		}
	}

	// Worktrees live at <worktreesBase>/<repo>/<branch> (three levels total).
	// Walk two levels under worktreesBase to find on-disk worktree candidates.
	repoDirs, err := os.ReadDir(worktreesBase)
	if err != nil {
		if os.IsNotExist(err) {
			return res, nil
		}
		return res, err
	}
	for _, repo := range repoDirs {
		if !repo.IsDir() {
			continue
		}
		repoPath := filepath.Join(worktreesBase, repo.Name())
		branchDirs, err := os.ReadDir(repoPath)
		if err != nil {
			continue
		}
		for _, branch := range branchDirs {
			if !branch.IsDir() {
				continue
			}
			p := filepath.Join(repoPath, branch.Name())
			if !registered[p] {
				res.Orphans = append(res.Orphans, p)
			}
		}
	}
	return res, nil
}
