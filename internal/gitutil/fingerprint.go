package gitutil

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Fingerprint is a cheap digest of "what a diff view would show", polled by
// the web UI to notice changes. Working covers only the working tree (status
// output plus each listed file's size and mtime); Full also folds in HEAD and
// the given refs, so it moves on commits, fetches and branch switches too.
type Fingerprint struct {
	Full    string
	Working string
}

// ComputeFingerprint costs one `git status` plus one Lstat per changed file —
// no per-file git calls — because it runs every few seconds on large repos.
//
// Status alone is not enough: re-editing an already-modified file leaves its
// status line unchanged, so each listed file's size and mtime are hashed too.
// Unresolvable refs (and HEAD in a repo with no commits) contribute an empty
// SHA rather than failing.
func ComputeFingerprint(dir string, refs ...string) (Fingerprint, error) {
	// -uall lists every file in untracked dirs (the default collapses them to
	// "dir/", which would hide new files added inside). -z keeps paths with
	// spaces or newlines unambiguous and must not be trimmed: the first entry
	// can start with a significant space (" M path").
	out, err := gitRaw(dir, nil, "status", "--porcelain=v1", "-uall", "-z")
	if err != nil {
		return Fingerprint{}, err
	}

	h := sha256.New()
	fields := strings.Split(out, "\x00")
	for i := 0; i < len(fields); i++ {
		entry := fields[i]
		if len(entry) < 4 {
			continue // trailing empty field
		}
		xy, path := entry[:2], entry[3:]
		if xy[0] == 'R' || xy[0] == 'C' || xy[1] == 'R' || xy[1] == 'C' {
			i++ // -z puts the original path in its own field; the new path is what's on disk
		}
		fmt.Fprintf(h, "%s %s\x00", xy, path)
		info, err := os.Lstat(filepath.Join(dir, path))
		if err != nil {
			io.WriteString(h, "missing\x00") // deleted: still a stable, distinct state
			continue
		}
		fmt.Fprintf(h, "%d %d\x00", info.Size(), info.ModTime().UnixNano())
	}
	working := hex.EncodeToString(h.Sum(nil))

	full := sha256.New()
	head, _ := RevSHA(dir, "HEAD")
	fmt.Fprintf(full, "HEAD %s\x00", head)
	for _, ref := range refs {
		sha, _ := RevSHA(dir, ref)
		fmt.Fprintf(full, "%s %s\x00", ref, sha)
	}
	io.WriteString(full, working)
	return Fingerprint{Full: hex.EncodeToString(full.Sum(nil)), Working: working}, nil
}
