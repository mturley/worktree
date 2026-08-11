package shellenv

import (
	"database/sql"
	"fmt"
	"path/filepath"

	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
)

// Lines returns the `export KEY=VALUE` shell lines for the worktree at
// worktreePath, computed live from the DB. It returns an empty slice (no error)
// when the path is not a registered worktree, so the caller can safely eval the
// output from any directory.
func Lines(conn *sql.DB, worktreePath string) ([]string, error) {
	wt, err := registry.Get(conn, worktreePath)
	if err != nil {
		return nil, err
	}
	if wt == nil {
		return nil, nil
	}

	name := filepath.Base(wt.Path)
	alloc, ok, err := ports.Lookup(conn, name) // read-only; never allocates
	if err != nil {
		return nil, err
	}
	kube := env.KubeconfigPath(wt.Repo, name)

	lines := []string{}
	if ok {
		lines = append(lines, fmt.Sprintf("export WORKTREE_PORTS=%s", alloc.Range()))
	}
	lines = append(lines,
		fmt.Sprintf("export WORKTREE_TITLE=%q", "wt "+wt.Branch),
		fmt.Sprintf("export WORKTREE_PATH=%q", wt.Path),
		fmt.Sprintf("export KUBECONFIG=%q", kube),
	)
	return lines, nil
}
