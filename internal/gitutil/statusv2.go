package gitutil

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// BranchStatus is the branch/upstream/ahead-behind facts carried by porcelain
// v2's "# branch.*" header lines, parsed by parseStatusV2.
type BranchStatus struct {
	HeadSHA  string // "" for an unborn branch ("(initial)")
	Branch   string // "" when detached
	Upstream string // short name, e.g. "origin/feat"; "" when none
	Ahead    int
	Behind   int
	HasAB    bool // false when there is no upstream, or the upstream is gone
}

// statusEntry is one changed or untracked path from porcelain v2 output,
// normalised to the same shape `WorkingState` has always hashed: XY with '.'
// mapped to ' ', and "??" for untracked paths.
type statusEntry struct {
	XY   string
	Path string
}

// parseStatusV2 parses the NUL-delimited output of
// `git status --porcelain=v2 --branch -uall -z`. It is pure: no I/O, so it is
// covered by table tests without starting git.
func parseStatusV2(out string) (BranchStatus, WorkingSummary, []statusEntry) {
	var bs BranchStatus
	var ws WorkingSummary
	var entries []statusEntry

	fields := strings.Split(out, "\x00")
	for i := 0; i < len(fields); i++ {
		line := fields[i]
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "# branch.oid "):
			oid := strings.TrimPrefix(line, "# branch.oid ")
			if oid != "(initial)" {
				bs.HeadSHA = oid
			}
		case strings.HasPrefix(line, "# branch.head "):
			head := strings.TrimPrefix(line, "# branch.head ")
			if head != "(detached)" {
				bs.Branch = head
			}
		case strings.HasPrefix(line, "# branch.upstream "):
			bs.Upstream = strings.TrimPrefix(line, "# branch.upstream ")
		case strings.HasPrefix(line, "# branch.ab "):
			bs.HasAB = true
			for _, part := range strings.Fields(strings.TrimPrefix(line, "# branch.ab ")) {
				n, err := strconv.Atoi(strings.TrimLeft(part, "+-"))
				if err != nil {
					continue
				}
				if strings.HasPrefix(part, "+") {
					bs.Ahead = n
				} else if strings.HasPrefix(part, "-") {
					bs.Behind = n
				}
			}
		case strings.HasPrefix(line, "#"):
			// Unrecognised header line; ignore.
		case strings.HasPrefix(line, "1 "):
			// 1 XY sub mH mI mW hH hI path
			parts := strings.SplitN(line, " ", 9)
			if len(parts) < 9 {
				continue
			}
			entries = append(entries, statusEntry{XY: normalizeXY(parts[1]), Path: parts[8]})
		case strings.HasPrefix(line, "2 "):
			// 2 XY sub mH mI mW hH hI X score path\0origPath
			parts := strings.SplitN(line, " ", 10)
			if len(parts) < 10 {
				continue
			}
			entries = append(entries, statusEntry{XY: normalizeXY(parts[1]), Path: parts[9]})
			i++ // skip the NUL-separated original path field
		case strings.HasPrefix(line, "u "):
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			parts := strings.SplitN(line, " ", 11)
			if len(parts) < 11 {
				continue
			}
			entries = append(entries, statusEntry{XY: normalizeXY(parts[1]), Path: parts[10]})
		case strings.HasPrefix(line, "? "):
			entries = append(entries, statusEntry{XY: "??", Path: strings.TrimPrefix(line, "? ")})
		case strings.HasPrefix(line, "!"):
			// Ignored; never requested without -uall semantics changing, but
			// skip defensively.
		}
	}

	for _, e := range entries {
		ws.Files++
		if e.XY == "??" {
			ws.Untracked++
			continue
		}
		if e.XY[0] != ' ' {
			ws.Staged++
		}
		if e.XY[1] != ' ' {
			ws.Modified++
		}
	}

	return bs, ws, entries
}

// normalizeXY maps porcelain v2's '.' (no change in that position) to the
// space v1 used, so hashing and counting stay identical to the old format.
func normalizeXY(xy string) string {
	return strings.ReplaceAll(xy, ".", " ")
}

// StatusV2 runs ONE `git status --porcelain=v2 --branch -uall -z` and derives
// the branch/upstream/ahead-behind facts, the working-tree counts, and the
// working fingerprint (Full is left empty; callers that need it add HEAD and
// ref SHAs themselves, as WorkingState does).
func StatusV2(dir string) (BranchStatus, WorkingSummary, Fingerprint, error) {
	// -uall lists every file in untracked dirs; -z keeps paths with spaces or
	// newlines unambiguous. gitRaw adds --no-optional-locks: this is polled.
	out, err := gitRaw(dir, nil, "status", "--porcelain=v2", "--branch", "-uall", "-z")
	if err != nil {
		return BranchStatus{}, WorkingSummary{}, Fingerprint{}, err
	}
	bs, ws, entries := parseStatusV2(out)
	return bs, ws, workingFingerprint(dir, entries), nil
}

// workingFingerprint hashes status entries exactly as WorkingState always
// has: "%s %s\x00" (XY, path) plus each path's Lstat size and mtime, so a
// re-edit of an already-modified file (same status line, new mtime) still
// changes the digest.
func workingFingerprint(dir string, entries []statusEntry) Fingerprint {
	h := sha256.New()
	for _, e := range entries {
		fmt.Fprintf(h, "%s %s\x00", e.XY, e.Path)
		info, err := os.Lstat(filepath.Join(dir, e.Path))
		if err != nil {
			io.WriteString(h, "missing\x00") // deleted: still a stable, distinct state
			continue
		}
		fmt.Fprintf(h, "%d %d\x00", info.Size(), info.ModTime().UnixNano())
	}
	return Fingerprint{Working: hex.EncodeToString(h.Sum(nil))}
}
