package notes

import "strings"

// Normalize converts CRLF to LF, strips trailing whitespace from each line and
// trims whitespace from both ends of the whole text. cmux does the same to a
// description, so texts equal after Normalize are equal.
func Normalize(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t\r\f\v")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// Merge three-way merges two edits of the same text, line by line. ours is
// always labelled "notes" in a conflict block and theirs is labelled
// theirsLabel. Inputs are Normalized, so the result has no trailing newline.
// A nil base means no common ancestor is known: the longest common
// subsequence of the two sides stands in for it.
func Merge(base *string, ours, theirs, theirsLabel string) string {
	ours, theirs = Normalize(ours), Normalize(theirs)
	if ours == theirs {
		return ours
	}
	o, t := splitLines(ours), splitLines(theirs)
	var b []string
	if base == nil {
		b = lcs(o, t)
	} else {
		b = splitLines(Normalize(*base))
	}

	mo, mt := matchLines(b, o), matchLines(b, t)
	var out []string
	bi, oi, ti := 0, 0, 0
	// A base line matched in both sides is a sync point; what lies between two
	// sync points is one region to resolve.
	for i := 0; i <= len(b); i++ {
		bEnd, oEnd, tEnd := len(b), len(o), len(t)
		if i < len(b) {
			if mo[i] < 0 || mt[i] < 0 {
				continue
			}
			bEnd, oEnd, tEnd = i, mo[i], mt[i]
		}
		out = append(out, resolve(b[bi:bEnd], o[oi:oEnd], t[ti:tEnd], theirsLabel, base != nil)...)
		if i < len(b) {
			out = append(out, b[i])
			bi, oi, ti = i+1, oEnd+1, tEnd+1
		}
	}
	return strings.Join(out, "\n")
}

// resolve settles one region. With a real base (realBase), two pure
// insertions at the same spot are both kept, unioned line by line (see
// union): neither changed existing text, so nothing is lost, and a line both
// inserted appears once.
func resolve(base, ours, theirs []string, theirsLabel string, realBase bool) []string {
	switch {
	case equalLines(ours, base):
		return theirs
	case equalLines(theirs, base), equalLines(ours, theirs):
		return ours
	}
	if realBase && len(base) == 0 {
		return union(ours, theirs)
	}
	out := []string{"<<<<<<< notes"}
	out = append(out, ours...)
	out = append(out, "=======")
	out = append(out, theirs...)
	return append(out, ">>>>>>> "+theirsLabel)
}

// union merges two insertions at one spot: lines both hold (their longest
// common subsequence) appear once, and before each shared line, and at the
// end, the lines only ours holds come first, then those only theirs holds.
// So when one run extends the other the result is the longer run.
func union(ours, theirs []string) []string {
	var out []string
	oi, ti := 0, 0
	for _, p := range lcsPairs(ours, theirs) {
		out = append(out, ours[oi:p[0]]...)
		out = append(out, theirs[ti:p[1]]...)
		out = append(out, ours[p[0]])
		oi, ti = p[0]+1, p[1]+1
	}
	out = append(out, ours[oi:]...)
	return append(out, theirs[ti:]...)
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
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

// lcsTable returns the suffix table: t[i][j] is the LCS length of a[i:], b[j:].
func lcsTable(a, b []string) [][]int {
	t := make([][]int, len(a)+1)
	for i := range t {
		t[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				t[i][j] = t[i+1][j+1] + 1
			} else {
				t[i][j] = max(t[i+1][j], t[i][j+1])
			}
		}
	}
	return t
}

// lcsPairs returns the index pairs (i in a, j in b) of a longest common
// subsequence of a and b, in order.
func lcsPairs(a, b []string) [][2]int {
	t := lcsTable(a, b)
	var out [][2]int
	for i, j := 0, 0; i < len(a) && j < len(b); {
		switch {
		case a[i] == b[j]:
			out = append(out, [2]int{i, j})
			i++
			j++
		case t[i+1][j] >= t[i][j+1]:
			i++
		default:
			j++
		}
	}
	return out
}

func lcs(a, b []string) []string {
	var out []string
	for _, p := range lcsPairs(a, b) {
		out = append(out, a[p[0]])
	}
	return out
}

// matchLines maps each index of base to the index of its LCS partner in side,
// or -1 when the line was changed or removed.
func matchLines(base, side []string) []int {
	m := make([]int, len(base))
	for i := range m {
		m[i] = -1
	}
	for _, p := range lcsPairs(base, side) {
		m[p[0]] = p[1]
	}
	return m
}
