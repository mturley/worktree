// Package addcheck holds input-rejection checks shared between `worktree add`
// (cmd/add.go) and the web UI's worktree-create handler
// (internal/webui/worktree_create_api.go), so both surfaces reject the same
// inputs the same way.
package addcheck

import (
	"os"
	"path/filepath"
)

// ExistingWorktreeDir reports whether arg is a directory holding a .git entry
// — the case where a path pointing at an existing worktree was pasted where a
// new branch/PR/issue input was expected. os.Stat succeeds for a .git entry
// whether it's a plain repo's .git directory or a linked worktree's .git
// file, so a single Stat is enough.
func ExistingWorktreeDir(arg string) bool {
	info, err := os.Stat(arg)
	if err != nil || !info.IsDir() {
		return false
	}
	_, err = os.Stat(filepath.Join(arg, ".git"))
	return err == nil
}
