package gitutil

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// GitDirs reads <worktree>/.git (never spawning a process) and returns the
// repository's gitDir and commonDir.
//
// For a plain repository, .git is a directory and gitDir == commonDir == it.
// For a linked worktree, .git is a file containing "gitdir: <path>" (relative
// paths resolve against worktree); that gitDir has a "commondir" file naming
// the shared repo's .git directory (relative paths resolve against gitDir),
// or, if absent, commonDir == gitDir.
func GitDirs(worktree string) (gitDir, commonDir string, err error) {
	dotGit := filepath.Join(worktree, ".git")
	info, err := os.Stat(dotGit)
	if err != nil {
		return "", "", err
	}
	if info.IsDir() {
		return dotGit, dotGit, nil
	}

	b, err := os.ReadFile(dotGit)
	if err != nil {
		return "", "", err
	}
	line := strings.TrimSpace(string(b))
	const prefix = "gitdir:"
	if !strings.HasPrefix(line, prefix) {
		return "", "", fmt.Errorf("gitutil: unrecognized .git file contents in %s", dotGit)
	}
	gitDir = strings.TrimSpace(strings.TrimPrefix(line, prefix))
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(worktree, gitDir)
	}
	gitDir = filepath.Clean(gitDir)

	commonDirBytes, err := os.ReadFile(filepath.Join(gitDir, "commondir"))
	if err != nil {
		// No commondir file: this gitDir is its own common dir.
		return gitDir, gitDir, nil
	}
	commonDir = strings.TrimSpace(string(commonDirBytes))
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(gitDir, commonDir)
	}
	commonDir = filepath.Clean(commonDir)
	return gitDir, commonDir, nil
}

// Stamp is a spawn-free, opaque digest of on-disk state that changes
// whenever the data it covers changes. Equal stamps mean "nothing in that
// category moved since last observed"; the opaque strings carry no other
// meaning and must not be parsed.
type Stamp struct {
	Refs  string
	Index string
}

// StateStamp computes a Stamp for worktree by hashing the size and mtime of
// the files (and ref directories) that determine HEAD, branches, remotes,
// and the index. It spawns no git process.
func StateStamp(worktree string) (Stamp, error) {
	gitDir, commonDir, err := GitDirs(worktree)
	if err != nil {
		return Stamp{}, err
	}

	h := sha256.New()
	addEntry(h, filepath.Join(gitDir, "HEAD"))
	addEntry(h, filepath.Join(gitDir, "ORIG_HEAD"))
	addEntry(h, filepath.Join(commonDir, "packed-refs"))
	addEntry(h, filepath.Join(commonDir, "FETCH_HEAD"))
	addEntry(h, filepath.Join(commonDir, "config"))

	refsDir := filepath.Join(commonDir, "refs")
	_ = filepath.WalkDir(refsDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Missing refs dir or an unreadable entry: stop walking but
			// don't fail the whole stamp.
			return nil
		}
		addEntry(h, path)
		return nil
	})
	// The reftable backend keeps all refs under reftable/ instead.
	_ = filepath.WalkDir(filepath.Join(commonDir, "reftable"), func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		addEntry(h, path)
		return nil
	})
	refs := hex.EncodeToString(h.Sum(nil))

	hi := sha256.New()
	addEntry(hi, filepath.Join(gitDir, "index"))
	index := hex.EncodeToString(hi.Sum(nil))

	return Stamp{Refs: refs, Index: index}, nil
}

// addEntry writes path's size and mtime (or "missing") into h.
func addEntry(h interface{ Write([]byte) (int, error) }, path string) {
	info, err := os.Lstat(path)
	if err != nil {
		fmt.Fprintf(h, "%s|missing\n", path)
		return
	}
	fmt.Fprintf(h, "%s|%d|%d\n", path, info.Size(), info.ModTime().UnixNano())
}
