// Package reviewcomments stores review comments on a worktree's diff and
// works out where each one belongs in the current file contents.
//
// A comment's anchor is captured once, from the file as the reviewer saw it,
// and is immutable. Positions are never stored: they are derived by Resolve
// against whatever the file looks like now.
package reviewcomments

import (
	"errors"
	"strings"
	"unicode"
)

// ContextLines is how many lines of context are kept on each side of a
// snippet and compared when re-anchoring.
const ContextLines = 3

// ErrOutOfRange is returned by Capture when the requested lines are not a
// valid 1-based inclusive range within the file.
var ErrOutOfRange = errors.New("lines out of range")

// Anchor is what a comment remembers about the lines it was written on.
// Start and End are 1-based and inclusive.
type Anchor struct {
	Start, End int
	Snippet    []string
	Before     []string
	After      []string
}

// Match says how an anchor relates to the current file contents.
type Match string

const (
	MatchCurrent  Match = "current"
	MatchMoved    Match = "moved"
	MatchOutdated Match = "outdated"
)

// Position is where an anchor sits now. Start and End are 0 when outdated.
type Position struct {
	Match      Match
	Start, End int
}

// SplitLines splits file content into lines. A trailing newline does not
// produce an empty final line, and a "\r" stays part of its line.
func SplitLines(content []byte) []string {
	if len(content) == 0 {
		return []string{}
	}
	s := string(content)
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}

// Capture builds an anchor for lines start..end (1-based, inclusive).
func Capture(lines []string, start, end int) (Anchor, error) {
	if start < 1 || start > end || end > len(lines) {
		return Anchor{}, ErrOutOfRange
	}
	beforeFrom := start - 1 - ContextLines
	if beforeFrom < 0 {
		beforeFrom = 0
	}
	afterTo := end + ContextLines
	if afterTo > len(lines) {
		afterTo = len(lines)
	}
	return Anchor{
		Start:   start,
		End:     end,
		Snippet: copyLines(lines[start-1 : end]),
		Before:  copyLines(lines[beforeFrom : start-1]),
		After:   copyLines(lines[end:afterTo]),
	}, nil
}

func copyLines(in []string) []string {
	out := make([]string, len(in))
	copy(out, in)
	return out
}

func equalLines(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// fullyMatches reports whether the anchor's snippet and both sides of
// context are found with the snippet starting at line p.
func fullyMatches(a Anchor, lines []string, p int) bool {
	got, err := Capture(lines, p, p+len(a.Snippet)-1)
	if err != nil {
		return false
	}
	return equalLines(got.Snippet, a.Snippet) &&
		equalLines(got.Before, a.Before) &&
		equalLines(got.After, a.After)
}

// lowInformation reports whether no line of the snippet contains a letter
// or digit, e.g. a lone "}". Such a snippet is too common to locate alone.
func lowInformation(snippet []string) bool {
	for _, line := range snippet {
		for _, r := range line {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				return false
			}
		}
	}
	return true
}

// Resolve finds where an anchor sits in lines now.
func Resolve(a Anchor, lines []string) Position {
	n := len(a.Snippet)
	if n == 0 {
		return Position{Match: MatchOutdated}
	}
	if fullyMatches(a, lines, a.Start) {
		return Position{Match: MatchCurrent, Start: a.Start, End: a.End}
	}

	full, fullCount := 0, 0
	snip, snipCount := 0, 0
	for p := 1; p+n-1 <= len(lines); p++ {
		if equalLines(lines[p-1:p-1+n], a.Snippet) {
			snip, snipCount = p, snipCount+1
			if fullyMatches(a, lines, p) {
				full, fullCount = p, fullCount+1
			}
		}
	}
	if fullCount == 1 {
		return Position{Match: MatchMoved, Start: full, End: full + n - 1}
	}
	if !lowInformation(a.Snippet) && snipCount == 1 {
		return Position{Match: MatchMoved, Start: snip, End: snip + n - 1}
	}
	return Position{Match: MatchOutdated}
}
