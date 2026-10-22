package gitutil

import (
	"strconv"
	"strings"
)

// RevSHA resolves ref to a full commit SHA. ok is false when ref does not
// name a commit (including a repo with no commits yet).
func RevSHA(dir, ref string) (string, bool) {
	out, err := git(dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil || out == "" {
		return "", false
	}
	return out, true
}

// shortRef returns the abbreviated name of ref (e.g. "origin/main"), or false
// when it does not resolve to a commit.
func shortRef(dir, ref string) (string, bool) {
	if _, ok := RevSHA(dir, ref); !ok {
		return "", false
	}
	out, err := git(dir, "rev-parse", "--abbrev-ref", ref)
	if err != nil || out == "" {
		return "", false
	}
	return out, true
}

// MainUpstream names the remote-tracking ref the repo's main line is compared
// against, e.g. "upstream/main". It prefers what `main` is configured to
// track; when there is no local `main` (or it tracks nothing) it follows
// origin/HEAD, and finally falls back to origin/HEAD itself.
func MainUpstream(dir string) (string, bool) {
	if _, err := git(dir, "show-ref", "--verify", "--quiet", "refs/heads/main"); err == nil {
		if ref, ok := shortRef(dir, "main@{upstream}"); ok {
			return ref, true
		}
	}

	head, err := git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
	if err != nil || head == "" {
		return "", false
	}
	if branch, found := strings.CutPrefix(head, "origin/"); found {
		if ref, ok := shortRef(dir, branch+"@{upstream}"); ok {
			return ref, true
		}
	}
	if _, ok := RevSHA(dir, head); ok {
		return head, true
	}
	return "", false
}

// TrackingBranch names the current branch's upstream (HEAD@{upstream}). It is
// absent for an unpushed branch and for a detached HEAD.
func TrackingBranch(dir string) (string, bool) {
	return shortRef(dir, "HEAD@{upstream}")
}

// MergeBase returns the full SHA of the merge base of HEAD and ref.
func MergeBase(dir, ref string) (string, bool) {
	out, err := git(dir, "merge-base", ref, "HEAD")
	if err != nil || out == "" {
		return "", false
	}
	return out, true
}

// AheadBehind counts the commits HEAD has that ref lacks (ahead) and the
// commits ref has that HEAD lacks (behind).
func AheadBehind(dir, ref string) (ahead, behind int, ok bool) {
	out, err := git(dir, "rev-list", "--left-right", "--count", ref+"...HEAD")
	if err != nil {
		return 0, 0, false
	}
	fields := strings.Fields(out)
	if len(fields) != 2 {
		return 0, 0, false
	}
	// --left-right with ref on the left: the first count is ref-only commits.
	behind, err1 := strconv.Atoi(fields[0])
	ahead, err2 := strconv.Atoi(fields[1])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return ahead, behind, true
}
