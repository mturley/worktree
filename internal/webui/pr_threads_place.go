package webui

import (
	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/reviewcomments"
)

// prThreadView is one PR review thread placed in a view. anchor is the
// synthetic comment built from the thread's first comment, nil when the
// thread cannot be placed; view is never nil.
type prThreadView struct {
	anchor *reviewcomments.Comment
	view   *reviewViewDTO
}

// prThreadAnchor builds a synthetic comment for t from its first comment,
// capturing the anchor from the file as that comment saw it: at its original
// commit for the RIGHT side, and for LEFT at merge-base(original commit,
// baseOid), the PR's base as it was. lines reads a file at a rev (nil when
// unreadable). ok is false when the commit is not in the local repo, the
// merge-base cannot be computed, or GitHub's lines are not in the file.
func prThreadAnchor(dir string, t wgithub.ReviewThread, baseOid string, lines func(rev, file string) []string) (reviewcomments.Comment, bool) {
	if len(t.Comments) == 0 || t.Path == "" {
		return reviewcomments.Comment{}, false
	}
	commit := t.Comments[0].OriginalCommit
	if commit == "" || !gitutil.IsCommit(dir, commit) {
		return reviewcomments.Comment{}, false
	}
	side, rev := reviewcomments.SideNew, commit
	switch t.DiffSide {
	case "RIGHT":
	case "LEFT":
		if baseOid == "" {
			return reviewcomments.Comment{}, false
		}
		mb, ok := gitutil.MergeBaseOf(dir, commit, baseOid)
		if !ok {
			return reviewcomments.Comment{}, false
		}
		side, rev = reviewcomments.SideOld, mb
	default:
		return reviewcomments.Comment{}, false
	}
	start := t.OriginalStartLine
	if start == 0 {
		start = t.OriginalLine
	}
	anchor, err := reviewcomments.Capture(lines(rev, t.Path), start, t.OriginalLine)
	if err != nil {
		return reviewcomments.Comment{}, false
	}
	return reviewcomments.Comment{File: t.Path, Side: side, Rev: rev, Base: "merge-base", Anchor: anchor}, true
}

// placeThreads places each of t's threads in view, in thread order. A thread
// that cannot be anchored is "unavailable". GitHub's own outdated flag wins
// over a local match, except where the thread is not in this view at all.
func (r *reviewResolver) placeThreads(dir string, t *wgithub.PRReviewThreads, view *reviewView) ([]prThreadView, error) {
	unlock := r.lockDir(dir)
	defer unlock()

	viewFiles, err := r.changedFiles(dir, view.oldRev, view.newRev)
	if err != nil {
		return nil, err
	}
	lines := func(rev, file string) []string { return r.linesAt(dir, rev, file) }
	allByBase := map[string]allResult{}

	out := make([]prThreadView, 0, len(t.Threads))
	for _, th := range t.Threads {
		c, ok := prThreadAnchor(dir, th, t.BaseRefOid, lines)
		if !ok {
			out = append(out, prThreadView{view: &reviewViewDTO{Status: "unavailable"}})
			continue
		}
		v := r.placeInView(dir, c, view, viewFiles, allByBase)
		if th.IsOutdated && v.Status != "not_in_view" && v.Status != "outside_changes" {
			v = &reviewViewDTO{Status: "outdated"}
		}
		out = append(out, prThreadView{anchor: &c, view: v})
	}
	return out, nil
}
