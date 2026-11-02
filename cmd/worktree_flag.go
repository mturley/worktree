package cmd

import (
	"database/sql"
	"errors"
)

// perWorktreePath resolves the --worktree flag of a per-worktree command.
// An explicit value must be a registered worktree ("." means the current
// one). Omitted, it defaults to the current worktree, which must be
// registered.
func perWorktreePath(conn *sql.DB, flag string) (string, error) {
	if flag != "" {
		return resolveWorktreeFlag(conn, flag)
	}
	path, err := resolveWorktreeFlag(conn, ".")
	if err != nil {
		return "", errors.New("not inside a registered worktree; pass --worktree")
	}
	return path, nil
}
