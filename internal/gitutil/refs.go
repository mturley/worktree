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
// when it does not resolve. One git process: --verify fails for a missing or
// unconfigured upstream just as a separate ^{commit} check would, and the
// refs passed here (upstreams, remote-tracking branches) always name commits.
func shortRef(dir, ref string) (string, bool) {
	out, err := git(dir, "rev-parse", "--verify", "--quiet", "--abbrev-ref", ref)
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
	// main@{upstream} fails when there is no local main, so no separate
	// existence check is needed.
	if ref, ok := shortRef(dir, "main@{upstream}"); ok {
		return ref, true
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

// CurrentBranch names the checked-out branch, including an unborn one in a
// repo with no commits. ok is false for a detached HEAD.
func CurrentBranch(dir string) (string, bool) {
	out, err := git(dir, "symbolic-ref", "--short", "-q", "HEAD")
	if err != nil || out == "" {
		return "", false
	}
	return out, true
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

// MergeBaseOf returns the best common ancestor of revs a and b. ok is false
// when either rev is unknown or they share no history.
func MergeBaseOf(dir, a, b string) (string, bool) {
	out, err := git(dir, "merge-base", a, b)
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

// TrackedPRNumber is the PR number the current branch tracks, when its
// configured merge ref is refs/pull/<N>/head (as a branch made from a PR's
// head is set up). ok is false for a detached HEAD, a branch with no
// upstream, and any other upstream.
func TrackedPRNumber(dir string) (int, bool) {
	branch, ok := CurrentBranch(dir)
	if !ok {
		return 0, false
	}
	merge, err := git(dir, "config", "--get", "branch."+branch+".merge")
	if err != nil {
		return 0, false
	}
	rest, found := strings.CutPrefix(merge, "refs/pull/")
	if !found {
		return 0, false
	}
	num, found := strings.CutSuffix(rest, "/head")
	if !found {
		return 0, false
	}
	n, err := strconv.Atoi(num)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

// IsAncestor reports whether commit a is an ancestor of commit b (a commit
// is its own ancestor). An unknown rev is never an ancestor.
func IsAncestor(dir, a, b string) bool {
	_, err := git(dir, "merge-base", "--is-ancestor", a, b)
	return err == nil
}
