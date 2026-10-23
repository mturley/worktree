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

// ComputeFingerprint is WorkingState for callers that need only the
// fingerprint.
func ComputeFingerprint(dir string, refs ...string) (Fingerprint, error) {
	_, fp, err := WorkingState(dir, refs...)
	return fp, err
}

// WorkingState derives both the Code tab's working-tree counts and the
// fingerprint from ONE `git status` plus one Lstat per changed file — no
// per-file git calls — because it runs every few seconds on large repos.
//
// Status alone is not enough for the fingerprint: re-editing an
// already-modified file leaves its status line unchanged, so each listed
// file's size and mtime are hashed too. Unresolvable refs (and HEAD in a repo
// with no commits) contribute an empty SHA rather than failing.
//
// Unlike ShortStatus it lists every file of an untracked directory, so
// Untracked counts files and Files is the number of distinct changed paths —
// what the Code tab's "N files changed" needs.
func WorkingState(dir string, refs ...string) (WorkingSummary, Fingerprint, error) {
	// -uall lists every file in untracked dirs (the default collapses them to
	// "dir/", which would hide new files added inside). -z keeps paths with
	// spaces or newlines unambiguous and must not be trimmed: the first entry
	// can start with a significant space (" M path").
	out, err := gitRaw(dir, nil, "status", "--porcelain=v1", "-uall", "-z")
	if err != nil {
		return WorkingSummary{}, Fingerprint{}, err
	}

	var ws WorkingSummary
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

		// One entry per path, so entries are distinct paths. X is the index
		// (staged) state, Y the working-tree state; a file can be both, so
		// they are counted independently.
		ws.Files++
		if xy == "??" {
			ws.Untracked++
		} else {
			if xy[0] != ' ' {
				ws.Staged++
			}
			if xy[1] != ' ' {
				ws.Modified++
			}
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
	return ws, Fingerprint{Full: hex.EncodeToString(full.Sum(nil)), Working: working}, nil
}
