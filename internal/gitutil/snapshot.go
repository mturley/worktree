package gitutil

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// SnapshotWorkingTree returns the SHA of a tree object holding the working
// tree exactly as it is on disk: tracked files as modified, untracked files
// included, ignored files excluded. Diff endpoints compare against it whenever
// a comparison includes uncommitted changes.
//
// It is built in a scratch copy of the index (GIT_INDEX_FILE), so the real
// index, and therefore `git status` and anything the user has staged, is
// never touched. The scratch index is always removed. The tree object itself
// is written to the object database, where git gc will eventually reap it.
func SnapshotWorkingTree(dir string) (string, error) {
	tmp, err := os.CreateTemp("", "worktree-snapshot-index-*")
	if err != nil {
		return "", err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	// Seeding from the real index keeps `git add -A` cheap (stat data is
	// reused). `--git-path` rather than `.git/index`: in a linked worktree
	// `.git` is a file and the index lives under the per-worktree git dir.
	indexPath, err := git(dir, "rev-parse", "--git-path", "index")
	if err != nil {
		tmp.Close()
		return "", err
	}
	if !filepath.IsAbs(indexPath) {
		indexPath = filepath.Join(dir, indexPath)
	}
	src, err := os.Open(indexPath)
	switch {
	case err == nil:
		_, copyErr := io.Copy(tmp, src)
		src.Close()
		if copyErr != nil {
			tmp.Close()
			return "", copyErr
		}
	case !errors.Is(err, fs.ErrNotExist):
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if errors.Is(err, fs.ErrNotExist) {
		// No real index (fresh repo, nothing ever staged). git rejects a
		// zero-length index file as corrupt but treats a missing one as
		// empty, so drop the placeholder; git add recreates it at tmpPath.
		if err := os.Remove(tmpPath); err != nil {
			return "", err
		}
	}

	env := []string{"GIT_INDEX_FILE=" + tmpPath}
	if _, err := gitEnv(dir, env, "add", "-A"); err != nil {
		return "", err
	}
	return gitEnv(dir, env, "write-tree")
}
