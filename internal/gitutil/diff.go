package gitutil

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// FileChange is one row of the "Files changed" list.
type FileChange struct {
	Path      string `json:"path"`
	OldPath   string `json:"old_path,omitempty"`
	Status    string `json:"status"` // A, M, D or R
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary"`
}

// MaxPatchBytes bounds the patch DiffPatch will return. It is a var so tests
// can lower it.
var MaxPatchBytes = 20 << 20

// ErrPatchTooLarge means the patch exceeded MaxPatchBytes.
var ErrPatchTooLarge = errors.New("patch too large")

// DiffFiles lists the files that differ between oldRev and newRev, sorted by
// path. Either rev may be a commit or a tree (a working-tree snapshot).
// Counts come from --numstat and statuses from --name-status; both are -z so
// odd paths round-trip, and are merged by (new) path.
func DiffFiles(dir, oldRev, newRev string) ([]FileChange, error) {
	// --no-ext-diff/--no-color: see DiffPatch.
	stat, err := gitRaw(dir, nil, "diff", "--no-ext-diff", "--no-color", "-z", "-M", "--numstat", oldRev, newRev)
	if err != nil {
		return nil, err
	}
	names, err := gitRaw(dir, nil, "diff", "--no-ext-diff", "--no-color", "-z", "-M", "--name-status", oldRev, newRev)
	if err != nil {
		return nil, err
	}

	byPath := map[string]*FileChange{}
	// name-status: STATUS\0path\0, or R<score>\0old\0new\0 for renames.
	toks := splitNUL(names)
	for i := 0; i < len(toks); {
		code := toks[i]
		if code == "" {
			return nil, fmt.Errorf("unexpected name-status output")
		}
		fc := &FileChange{Status: code[:1]}
		if fc.Status == "R" {
			if i+2 >= len(toks) {
				return nil, fmt.Errorf("truncated name-status output")
			}
			fc.OldPath, fc.Path = toks[i+1], toks[i+2]
			i += 3
		} else {
			if i+1 >= len(toks) {
				return nil, fmt.Errorf("truncated name-status output")
			}
			fc.Path = toks[i+1]
			i += 2
		}
		byPath[fc.Path] = fc
	}

	// numstat: adds\tdels\tpath\0, or adds\tdels\t\0old\0new\0 for renames.
	toks = splitNUL(stat)
	for i := 0; i < len(toks); {
		parts := strings.SplitN(toks[i], "\t", 3)
		if len(parts) != 3 {
			return nil, fmt.Errorf("unexpected numstat record %q", toks[i])
		}
		path := parts[2]
		i++
		if path == "" { // rename: the next two tokens are old and new
			if i+1 >= len(toks) {
				return nil, fmt.Errorf("truncated numstat output")
			}
			path = toks[i+1]
			i += 2
		}
		fc, ok := byPath[path]
		if !ok {
			return nil, fmt.Errorf("numstat path %q missing from name-status", path)
		}
		if parts[0] == "-" && parts[1] == "-" {
			fc.Binary = true
			continue
		}
		if fc.Additions, err = strconv.Atoi(parts[0]); err != nil {
			return nil, fmt.Errorf("numstat additions %q: %w", parts[0], err)
		}
		if fc.Deletions, err = strconv.Atoi(parts[1]); err != nil {
			return nil, fmt.Errorf("numstat deletions %q: %w", parts[1], err)
		}
	}

	out := make([]FileChange, 0, len(byPath))
	for _, fc := range byPath {
		out = append(out, *fc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// splitNUL splits NUL-terminated output into tokens, dropping the empty
// token after the final terminator.
func splitNUL(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(s, "\x00"), "\x00")
}

// DiffPatch returns the unified patch between oldRev and newRev, untrimmed.
// Binary files appear as git's "Binary files differ" line; the UI renders a
// placeholder for them.
//
// The flags pin the output format against the user's git config, which `git
// diff` (a porcelain command) otherwise honours: an external diff driver or
// textconv would replace the patch, color.diff=always would embed escape
// codes, and diff.noprefix / diff.mnemonicPrefix would change the a/ b/ path
// prefixes the UI's patch parser relies on.
func DiffPatch(dir, oldRev, newRev string, ignoreWhitespace bool) (string, error) {
	args := []string{"diff", "--no-ext-diff", "--no-color", "--no-textconv",
		"--src-prefix=a/", "--dst-prefix=b/", "-M"}
	if ignoreWhitespace {
		args = append(args, "-w")
	}
	out, err := gitRaw(dir, nil, append(args, oldRev, newRev)...)
	if err != nil {
		return "", err
	}
	if len(out) > MaxPatchBytes {
		return "", ErrPatchTooLarge
	}
	return out, nil
}

// IsCommit reports whether rev names a commit (as opposed to a tree, such as
// a working-tree snapshot, or nothing at all).
func IsCommit(dir, rev string) bool {
	out, err := git(dir, "cat-file", "-t", rev)
	return err == nil && out == "commit"
}

// BlobSHA returns the object id of file at rev (a commit or a tree), and
// whether the file exists there.
func BlobSHA(dir, rev, file string) (string, bool) {
	out, err := git(dir, "rev-parse", "--verify", "--quiet", rev+":"+file)
	return out, err == nil && out != ""
}

// ShowFile returns file's contents at rev (a commit or a tree), byte for byte.
func ShowFile(dir, rev, file string) ([]byte, error) {
	out, err := gitRaw(dir, nil, "show", rev+":"+file)
	if err != nil {
		return nil, err
	}
	return []byte(out), nil
}

// Hunk is one hunk header's line ranges. A count of 0 means the side is
// empty (an added or deleted file), and its start is then the line before.
type Hunk struct{ OldStart, OldLines, NewStart, NewLines int }

// DiffHunks lists each file's hunks between oldRev and newRev, with git's
// default 3 lines of context, keyed by the file's new path (a deleted file
// by its old path). Files with no textual hunks (binary, pure renames) are
// absent. Flags pin the output against the user's config, as in DiffPatch.
func DiffHunks(dir, oldRev, newRev string) (map[string][]Hunk, error) {
	out, err := gitRaw(dir, nil, "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--no-textconv",
		"--src-prefix=a/", "--dst-prefix=b/", "-M", "-U3", oldRev, newRev)
	if err != nil {
		return nil, err
	}
	hunks := map[string][]Hunk{}
	var oldPath, file string
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			oldPath, file = "", ""
		case file == "" && strings.HasPrefix(line, "--- "):
			oldPath = patchPath(line[4:], "a/")
		case file == "" && strings.HasPrefix(line, "+++ "):
			file = patchPath(line[4:], "b/")
			if file == "" {
				file = oldPath // deleted
			}
		case file != "" && strings.HasPrefix(line, "@@ "):
			h, err := parseHunkHeader(line)
			if err != nil {
				return nil, err
			}
			hunks[file] = append(hunks[file], h)
		}
	}
	return hunks, nil
}

// patchPath is the path on a ---/+++ line without its prefix, "" for
// /dev/null. Git quotes a path with unusual bytes C-style, and ends one
// containing a space with a tab.
func patchPath(s, prefix string) string {
	s = strings.TrimSuffix(s, "\t")
	if s == "/dev/null" {
		return ""
	}
	if strings.HasPrefix(s, `"`) {
		if u, err := strconv.Unquote(s); err == nil {
			s = u
		}
	}
	return strings.TrimPrefix(s, prefix)
}

// parseHunkHeader reads "@@ -a[,b] +c[,d] @@"; an omitted count is 1.
func parseHunkHeader(line string) (Hunk, error) {
	fields := strings.Fields(line)
	if len(fields) < 4 || fields[3] != "@@" {
		return Hunk{}, fmt.Errorf("bad hunk header %q", line)
	}
	rng := func(s, sign string) (int, int, error) {
		s, ok := strings.CutPrefix(s, sign)
		if !ok {
			return 0, 0, fmt.Errorf("bad hunk range %q", s)
		}
		start, count, hasCount := strings.Cut(s, ",")
		a, err := strconv.Atoi(start)
		if err != nil {
			return 0, 0, fmt.Errorf("bad hunk range %q: %w", s, err)
		}
		if !hasCount {
			return a, 1, nil
		}
		b, err := strconv.Atoi(count)
		if err != nil {
			return 0, 0, fmt.Errorf("bad hunk range %q: %w", s, err)
		}
		return a, b, nil
	}
	var h Hunk
	var err error
	if h.OldStart, h.OldLines, err = rng(fields[1], "-"); err != nil {
		return Hunk{}, err
	}
	if h.NewStart, h.NewLines, err = rng(fields[2], "+"); err != nil {
		return Hunk{}, err
	}
	return h, nil
}
