package webui

import (
	"errors"

	wgithub "github.com/mturley/watcher/github"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/gitfetch"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/reviewcomments"
)

// Why a comment cannot be posted to the PR, in the order they are checked.
const (
	reasonUncommitted   = "on uncommitted changes"
	reasonNotPushed     = "on a commit not pushed to the PR"
	reasonNewerThanPend = "newer than your pending review"
	reasonOutOfDate     = "out of date"
	reasonNotInDiff     = "not part of the PR's changes"
)

// errMissingCommit: the target commit or its merge-base with the PR's base
// is not in the local repo, even after nudging a fetch.
var errMissingCommit = errors.New("the PR's commits are not in the local repo")

// prTarget is what comments are posted against: the PR head, or the pending
// review's commit when there is one (comments added to a pending review all
// sit on its commit), with the PR's diff hunks at that commit.
type prTarget struct {
	ref       wgithub.PRRef
	ctx       *wgithub.PRWriteContext
	commit    string                    // ctx.Pending.CommitOid when a pending review exists, else ctx.HeadRefOid
	mergeBase string                    // merge-base(ctx.BaseRefOid, commit): GitHub's LEFT side
	hunks     map[string][]gitutil.Hunk // DiffHunks(mergeBase, commit)
	// stale: the pending review is on an older commit than the PR head.
	stale bool
	// pendingCommit is the pending review's commit, "" with none.
	pendingCommit string
}

// prPlacement says whether a comment can be posted, and where.
type prPlacement struct {
	ok      bool
	reason  string                   // "" when ok
	comment wgithub.NewReviewComment // Path, Side, Line, StartLine and Body when ok
}

// loadPRTarget fetches pc's PR write context and builds its target. When
// the target commit or merge-base is missing locally it nudges the
// background fetch once, without waiting for it, and returns
// errMissingCommit if they are still missing.
func (s *Server) loadPRTarget(dir string, pc prComments) (*prTarget, error) {
	if !s.WatcherEnabled(config.ServiceGitHub) {
		return nil, errors.New("the GitHub watcher is off")
	}
	if pc.pr == nil {
		return nil, errors.New("the worktree has no PR")
	}
	ctx, err := s.cachedPRWriteContext(pc.token, pc.pr.ID, pc.ref)
	if err != nil {
		return nil, err
	}
	t, err := newPRTarget(dir, pc.ref, ctx)
	if errors.Is(err, errMissingCommit) {
		s.nudgeFetch(dir)
		t, err = newPRTarget(dir, pc.ref, ctx)
	}
	return t, err
}

// nudgeFetch asks the background fetch scheduler, when the setting is on,
// to fetch the worktree's remotes. It never waits for the fetch.
func (s *Server) nudgeFetch(dir string) {
	e, _, err := config.ReadEditable(s.configPath())
	if err != nil || !e.BackgroundFetch {
		return
	}
	var refs []string
	if up, ok := gitutil.MainUpstream(dir); ok {
		refs = append(refs, up)
	}
	if tr, ok := gitutil.TrackingBranch(dir); ok {
		refs = append(refs, tr)
	}
	if remotes := gitfetch.RemotesFor(dir, refs...); len(remotes) > 0 {
		s.fetchScheduler(config.GitConfig{FetchInterval: e.FetchInterval}.Interval()).Maybe(dir, remotes)
	}
}

// newPRTarget builds the target from ctx against the local repo, or
// errMissingCommit when a commit it needs is not there.
func newPRTarget(dir string, ref wgithub.PRRef, ctx *wgithub.PRWriteContext) (*prTarget, error) {
	t := &prTarget{ref: ref, ctx: ctx, commit: ctx.HeadRefOid}
	if ctx.Pending != nil && ctx.Pending.CommitOid != "" {
		t.commit = ctx.Pending.CommitOid
		t.pendingCommit = ctx.Pending.CommitOid
		t.stale = ctx.Pending.CommitOid != ctx.HeadRefOid
	}
	if t.commit == "" || !gitutil.IsCommit(dir, t.commit) || !gitutil.IsCommit(dir, ctx.BaseRefOid) {
		return nil, errMissingCommit
	}
	mb, ok := gitutil.MergeBaseOf(dir, ctx.BaseRefOid, t.commit)
	if !ok {
		return nil, errMissingCommit
	}
	t.mergeBase = mb
	hunks, err := gitutil.DiffHunks(dir, mb, t.commit)
	if err != nil {
		return nil, err
	}
	t.hunks = hunks
	return t, nil
}

// placeForPR decides whether GitHub would accept c on t, and where. lines
// reads a file at a rev; isAncestor(a, b) says whether commit a is an
// ancestor of commit b. See the spec's "Which comments can be posted".
func placeForPR(dir string, t *prTarget, c reviewcomments.Comment, lines func(rev, file string) []string, isAncestor func(a, b string) bool) prPlacement {
	if c.Rev == reviewcomments.RevUncommitted {
		return prPlacement{reason: reasonUncommitted}
	}
	old := c.Side == reviewcomments.SideOld
	rev, side := t.commit, "RIGHT"
	if old {
		rev, side = t.mergeBase, "LEFT"
	} else if !isAncestor(c.Rev, t.commit) {
		if t.stale && isAncestor(c.Rev, t.ctx.HeadRefOid) {
			return prPlacement{reason: reasonNewerThanPend}
		}
		return prPlacement{reason: reasonNotPushed}
	}

	pos := reviewcomments.Resolve(c.Anchor, lines(rev, c.File))
	if pos.Match == reviewcomments.MatchOutdated {
		return prPlacement{reason: reasonOutOfDate}
	}
	if !inOneHunk(t.hunks[c.File], old, pos.Start, pos.End) {
		return prPlacement{reason: reasonNotInDiff}
	}
	nc := wgithub.NewReviewComment{Path: c.File, Side: side, Line: pos.End, Body: c.Body}
	if pos.Start < pos.End {
		nc.StartLine = pos.Start
	}
	return prPlacement{ok: true, comment: nc}
}

// inOneHunk reports whether lines start..end of one side all fall in a
// single hunk.
func inOneHunk(hunks []gitutil.Hunk, old bool, start, end int) bool {
	for _, h := range hunks {
		from, n := h.NewStart, h.NewLines
		if old {
			from, n = h.OldStart, h.OldLines
		}
		if n > 0 && start >= from && end <= from+n-1 {
			return true
		}
	}
	return false
}
