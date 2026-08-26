package gitutil

import (
	"os/exec"
	"strconv"
	"strings"
)

// Status is a summary of a worktree's working-tree state, enough for the web
// UI's "short git status" line.
type Status struct {
	Branch    string `json:"branch"`
	Upstream  string `json:"upstream,omitempty"`
	Ahead     int    `json:"ahead"`
	Behind    int    `json:"behind"`
	Staged    int    `json:"staged"`
	Modified  int    `json:"modified"`
	Untracked int    `json:"untracked"`
}

// Clean reports whether the working tree has no staged, modified or untracked
// files. Ahead/behind are deliberately excluded: a tree can be clean while the
// branch is ahead of its upstream.
func (s Status) Clean() bool {
	return s.Staged == 0 && s.Modified == 0 && s.Untracked == 0
}

// ShortStatus runs `git status` in dir and summarises it.
//
// Returns ok=false rather than an error when dir is not a git worktree or git
// is unavailable: the web UI treats "no status" as a normal state to omit, not
// a page-level failure.
func ShortStatus(dir string) (Status, bool) {
	// --porcelain=v1 is a stable, documented format; -b adds the branch header;
	// -unormal counts untracked files without descending into every file of an
	// untracked directory.
	out, err := exec.Command("git", "-C", dir, "status", "--porcelain=v1", "-b", "-unormal").Output()
	if err != nil {
		return Status{}, false
	}
	var st Status
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "## ") {
			parseBranchHeader(strings.TrimPrefix(line, "## "), &st)
			continue
		}
		if strings.HasPrefix(line, "?? ") {
			st.Untracked++
			continue
		}
		if len(line) < 2 {
			continue
		}
		// XY: X is the index (staged) state, Y the working-tree state. A file
		// can be both, so these are counted independently rather than as a
		// single "changed" total.
		if x := line[0]; x != ' ' && x != '?' {
			st.Staged++
		}
		if y := line[1]; y != ' ' && y != '?' {
			st.Modified++
		}
	}
	return st, true
}

// parseBranchHeader reads git's "## branch...upstream [ahead N, behind M]"
// line. Shapes seen: "main", "main...origin/main",
// "main...origin/main [ahead 1]", "HEAD (no branch)", and — on a repo with no
// commits yet — "No commits yet on main".
func parseBranchHeader(h string, st *Status) {
	// Strip the pre-first-commit prefix before anything else, or the branch
	// name comes back as the whole sentence.
	h = strings.TrimPrefix(h, "No commits yet on ")

	if i := strings.Index(h, " ["); i >= 0 {
		for _, part := range strings.Split(strings.Trim(h[i+2:], "[]"), ", ") {
			fields := strings.Fields(part)
			if len(fields) != 2 {
				continue
			}
			n, err := strconv.Atoi(fields[1])
			if err != nil {
				continue
			}
			switch fields[0] {
			case "ahead":
				st.Ahead = n
			case "behind":
				st.Behind = n
			}
		}
		h = h[:i]
	}
	if i := strings.Index(h, "..."); i >= 0 {
		st.Branch, st.Upstream = h[:i], h[i+3:]
		return
	}
	st.Branch = h
}
