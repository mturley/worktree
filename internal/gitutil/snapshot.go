package gitutil

import (
	"io"
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
	if src, err := os.Open(indexPath); err == nil {
		_, copyErr := io.Copy(tmp, src)
		src.Close()
		if copyErr != nil {
			tmp.Close()
			return "", copyErr
		}
	}
	// A missing index (fresh repo) leaves an empty file, which git treats as
	// an empty index.
	if err := tmp.Close(); err != nil {
		return "", err
	}

	env := []string{"GIT_INDEX_FILE=" + tmpPath}
	if _, err := gitEnv(dir, env, "add", "-A"); err != nil {
		return "", err
	}
	return gitEnv(dir, env, "write-tree")
}
