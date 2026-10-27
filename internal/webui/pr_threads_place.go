package webui

import (
	"regexp"

	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/reviewcomments"
)

// prThreadView is one PR review thread placed in a view. anchor is the
// synthetic comment built from the thread's first comment, nil when the
// thread cannot be placed. view is where it sits in the shown view; it is
// nil only for a placeable thread when placeThreads had no view to place in
// (an unplaceable thread always gets {Status: "unavailable"}).
type prThreadView struct {
	anchor *reviewcomments.Comment
	view   *reviewViewDTO
}

// prGitMemo memoizes the git lookups thread anchoring makes, so threads
// sharing a commit ask git once per placeThreads call.
type prGitMemo struct {
	dir       string
	isCommit  map[string]bool
	mergeBase map[string]string // commit\0base → merge-base, "" on failure
}

// prOidRE is a full object id, as GitHub reports one. GitHub-supplied revs
// are checked against it before reaching git, so a symbolic ref or an
// option-shaped string is never interpreted; anything else is "not local".
var prOidRE = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

func newPRGitMemo(dir string) *prGitMemo {
	return &prGitMemo{dir: dir, isCommit: map[string]bool{}, mergeBase: map[string]string{}}
}

func (m *prGitMemo) commitOK(rev string) bool {
	if !prOidRE.MatchString(rev) {
		return false
	}
	ok, seen := m.isCommit[rev]
	if !seen {
		ok = gitutil.IsCommit(m.dir, rev)
		m.isCommit[rev] = ok
	}
	return ok
}

func (m *prGitMemo) mergeBaseOf(commit, base string) (string, bool) {
	key := commit + "\x00" + base
	mb, seen := m.mergeBase[key]
	if !seen {
		mb, _ = gitutil.MergeBaseOf(m.dir, commit, base)
		m.mergeBase[key] = mb
	}
	return mb, mb != ""
}

// prThreadAnchor builds a synthetic comment for t from its first comment,
// capturing the anchor from the file as that comment saw it: at its original
// commit, lines OriginalStartLine (or OriginalLine) through OriginalLine.
// When the original commit is not in the local repo (a force-push), it falls
// back to the comment's current commit with StartLine (or Line) through Line,
// provided that commit is local and Line is set. RIGHT is the new side at
// that commit; LEFT is the old side at merge-base(commit, baseOid), the PR's
// base as it was. lines reads a file at a rev (nil when unreadable). ok is
// false when neither commit is usable, the merge-base cannot be computed, or
// GitHub's lines are not in the file.
func prThreadAnchor(dir string, t wgithub.ReviewThread, baseOid string, lines func(rev, file string) []string) (reviewcomments.Comment, bool) {
	return anchorPRThread(newPRGitMemo(dir), t, baseOid, lines)
}

func anchorPRThread(m *prGitMemo, t wgithub.ReviewThread, baseOid string, lines func(rev, file string) []string) (reviewcomments.Comment, bool) {
	if len(t.Comments) == 0 || t.Path == "" {
		return reviewcomments.Comment{}, false
	}
	first := t.Comments[0]
	var commit string
	var start, end int
	switch {
	case m.commitOK(first.OriginalCommit):
		commit, start, end = first.OriginalCommit, t.OriginalStartLine, t.OriginalLine
	case t.Line != 0 && m.commitOK(first.Commit):
		commit, start, end = first.Commit, t.StartLine, t.Line
	default:
		return reviewcomments.Comment{}, false
	}
	if start == 0 {
		start = end
	}
	side, rev := reviewcomments.SideNew, commit
	switch t.DiffSide {
	case "RIGHT":
	case "LEFT":
		if !prOidRE.MatchString(baseOid) {
			return reviewcomments.Comment{}, false
		}
		mb, ok := m.mergeBaseOf(commit, baseOid)
		if !ok {
			return reviewcomments.Comment{}, false
		}
		side, rev = reviewcomments.SideOld, mb
	default:
		return reviewcomments.Comment{}, false
	}
	anchor, err := reviewcomments.Capture(lines(rev, t.Path), start, end)
	if err != nil {
		return reviewcomments.Comment{}, false
	}
	return reviewcomments.Comment{File: t.Path, Side: side, Rev: rev, Base: "merge-base", Anchor: anchor}, true
}

// placeThreads places each of t's threads in view, in thread order. A thread
// that cannot be anchored is "unavailable". GitHub's own outdated flag doesn't
// change placement: a thread is shown wherever its lines still match.
//
// With a nil view (no revs) nothing is placed: each placeable thread gets its
// anchor and a nil view, and only unplaceable threads get a view, "unavailable".
func (r *reviewResolver) placeThreads(dir string, t *wgithub.PRReviewThreads, view *reviewView) ([]prThreadView, error) {
	unlock := r.lockDir(dir)
	defer unlock()

	var viewFiles []gitutil.FileChange
	if view != nil {
		var err error
		if viewFiles, err = r.changedFiles(dir, view.oldRev, view.newRev); err != nil {
			return nil, err
		}
	}
	lines := func(rev, file string) []string { return r.linesAt(dir, rev, file) }
	memo := newPRGitMemo(dir)
	allByBase := map[string]allResult{}

	out := make([]prThreadView, 0, len(t.Threads))
	for _, th := range t.Threads {
		c, ok := anchorPRThread(memo, th, t.BaseRefOid, lines)
		if !ok {
			out = append(out, prThreadView{view: &reviewViewDTO{Status: "unavailable"}})
			continue
		}
		if view == nil {
			out = append(out, prThreadView{anchor: &c})
			continue
		}
		// A thread GitHub calls outdated is still placed where its lines
		// match; the card shows its Outdated badge from the thread itself.
		out = append(out, prThreadView{anchor: &c, view: r.placeInView(dir, c, view, viewFiles, allByBase)})
	}
	return out, nil
}
