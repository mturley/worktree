package gitutil

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Commit is one entry in the "Changes from:" picker.
type Commit struct {
	SHA     string    `json:"sha"`
	Short   string    `json:"short"`
	Subject string    `json:"subject"`
	Author  string    `json:"author"`
	Date    time.Time `json:"date"`
}

// Uncommitted names the working-tree entry of the picker. It counts as newer
// than every commit.
const Uncommitted = "uncommitted"

// ErrInvalidRange means a Range names something not in the commit list, or
// runs backwards.
var ErrInvalidRange = errors.New("invalid commit range")

// Range is one contiguous run of picker entries: From is the oldest selected,
// To the newest. Each is a commit SHA or Uncommitted. The zero value means
// "All changes" (merge base through the working tree).
type Range struct {
	From, To string
}

// FirstParentCommits lists baseRef..HEAD along first parents, newest first.
// Following first parents keeps commits that arrived by merging main into the
// branch out of the list: they are not the branch's own work. A repo with no
// commits yet has an empty list.
func FirstParentCommits(dir, baseRef string) ([]Commit, error) {
	if _, ok := RevSHA(dir, "HEAD"); !ok {
		return []Commit{}, nil
	}
	out, err := gitRaw(dir, nil, "log", "--first-parent", "-z",
		"--format=%H%x00%h%x00%an%x00%aI%x00%s", baseRef+"..HEAD")
	if err != nil {
		return nil, err
	}
	// -z terminates each record with NUL and the format separates fields
	// with NUL too, so the stream is a flat run of 5-field records.
	commits := []Commit{}
	if out == "" {
		return commits, nil
	}
	fields := strings.Split(strings.TrimSuffix(out, "\x00"), "\x00")
	if len(fields)%5 != 0 {
		return nil, fmt.Errorf("unexpected git log output: %d fields", len(fields))
	}
	for i := 0; i < len(fields); i += 5 {
		date, err := time.Parse(time.RFC3339, fields[i+3])
		if err != nil {
			return nil, fmt.Errorf("parse commit date %q: %w", fields[i+3], err)
		}
		commits = append(commits, Commit{
			SHA:     fields[i],
			Short:   fields[i+1],
			Author:  fields[i+2],
			Date:    date,
			Subject: fields[i+4],
		})
	}
	return commits, nil
}

// ListID identifies a commit list: it changes when the branch gains or loses
// commits or the merge base moves, and the UI resets its selection when it
// does. Main advancing without changing the merge base leaves it unchanged.
func ListID(commits []Commit, mergeBase string) string {
	h := sha256.New()
	for _, c := range commits {
		h.Write([]byte(c.SHA))
		h.Write([]byte{0})
	}
	h.Write([]byte(mergeBase))
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// ResolveRange turns a picker selection into the revs to diff. newRev is a
// commit SHA, or a snapshot tree SHA when the range includes Uncommitted.
//
// When the run reaches the list's oldest commit, the old side is the merge
// base rather than that commit's parent: if the branch merged main in, the
// parent may sit on main's side and would show main's changes as the
// branch's own.
func ResolveRange(dir, baseRef string, commits []Commit, r Range) (oldRev, newRev string, err error) {
	if r == (Range{}) {
		mb, ok := MergeBase(dir, baseRef)
		if !ok {
			return "", "", fmt.Errorf("no merge base with %s", baseRef)
		}
		tree, err := SnapshotWorkingTree(dir)
		return mb, tree, err
	}

	// Position in the newest-first list; Uncommitted is newer than all.
	pos := func(id string) (int, bool) {
		if id == Uncommitted {
			return -1, true
		}
		for i, c := range commits {
			if c.SHA == id {
				return i, true
			}
		}
		return 0, false
	}
	fromIdx, okFrom := pos(r.From)
	toIdx, okTo := pos(r.To)
	if !okFrom || !okTo {
		return "", "", fmt.Errorf("%w: %q..%q not in the commit list", ErrInvalidRange, r.From, r.To)
	}
	if fromIdx < toIdx {
		return "", "", fmt.Errorf("%w: %q is newer than %q", ErrInvalidRange, r.From, r.To)
	}

	switch {
	case r.From == Uncommitted:
		head, ok := RevSHA(dir, "HEAD")
		if !ok {
			return "", "", errors.New("HEAD does not resolve")
		}
		oldRev = head
	case fromIdx == len(commits)-1:
		mb, ok := MergeBase(dir, baseRef)
		if !ok {
			return "", "", fmt.Errorf("no merge base with %s", baseRef)
		}
		oldRev = mb
	default:
		parent, ok := RevSHA(dir, r.From+"^1")
		if !ok {
			return "", "", fmt.Errorf("commit %s has no parent", r.From)
		}
		oldRev = parent
	}

	if r.To == Uncommitted {
		newRev, err = SnapshotWorkingTree(dir)
		return oldRev, newRev, err
	}
	return oldRev, r.To, nil
}
