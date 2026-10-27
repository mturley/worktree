package webui

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	wgithub "github.com/mturley/watcher/github"
	"github.com/mturley/worktree/internal/config"
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
	renames   map[string]string         // old path → new path, from the same diff
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

// prFetchTimeout bounds loadPRTarget's targeted fetch, which a request waits on.
const prFetchTimeout = 30 * time.Second

// prFetchMissTTL is how long a targeted fetch that left commits missing is
// remembered, per PR and worktree, so a failing remote does not make every
// request wait on another fetch.
const prFetchMissTTL = 60 * time.Second

// loadPRTarget fetches pc's PR write context and builds its target. When a
// commit it needs is missing locally (the target, the base, or, with a
// pending review, the PR head), it fetches the PR's head ref once,
// synchronously, and checks again; errMissingCommit if still missing. The
// fetch is skipped when the Background fetch setting is off. A fetch that
// leaves commits missing is remembered for prFetchMissTTL, per PR and
// worktree and commits: until then the same miss is errMissingCommit
// without fetching again, while a moved head or pending review retries.
//
// headOnly ignores the viewer's pending review: the target is the PR head,
// which a single comment is posted against. Otherwise a pending review's
// commit is the target, which comments added to it must sit on.
func (s *Server) loadPRTarget(dir string, pc prComments, headOnly bool) (*prTarget, error) {
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
	if headOnly && ctx.Pending != nil {
		c := *ctx
		c.Pending = nil
		ctx = &c
	}
	t, err := newPRTarget(dir, pc.ref, ctx)
	if !errors.Is(err, errMissingCommit) {
		return t, err
	}
	pending := ""
	if ctx.Pending != nil {
		pending = ctx.Pending.CommitOid
	}
	key := "prfetch|" + pc.pr.ID + "|" + dir + "|" + ctx.HeadRefOid + "|" + pending
	// Only errMissingCommit is returned as an error, so only a miss is
	// remembered; a success is stored with no lifetime, so never reused.
	// The cache also makes concurrent misses share one fetch.
	v, err := s.prThreadsCacheOrInit().getErrTTL(key, 0, prFetchMissTTL, false, func() (interface{}, error) {
		if !s.fetchPRCommits(dir, pc.ref, ctx) {
			return nil, errMissingCommit
		}
		t, err := newPRTarget(dir, pc.ref, ctx)
		if errors.Is(err, errMissingCommit) {
			return nil, err
		}
		return prTargetResult{t, err}, nil
	})
	if err != nil {
		return nil, err
	}
	r := v.(prTargetResult)
	return r.t, r.err
}

// prTargetResult carries newPRTarget's result through the fetch cache
// without caching an error other than errMissingCommit.
type prTargetResult struct {
	t   *prTarget
	err error
}

// fetchPRCommits fetches ref's head into refs/pr-review/<N> from the remote
// for the PR's repository, plus by id the base commit and the pending
// review's commit when they are missing (a pending review on a commit
// force-pushed away is no longer reachable from the head ref).
// It reports whether a fetch ran without error.
func (s *Server) fetchPRCommits(dir string, ref wgithub.PRRef, ctx *wgithub.PRWriteContext) bool {
	e, _, err := config.ReadEditable(s.configPath())
	if err != nil || !e.BackgroundFetch {
		return false
	}
	remote, err := gitutil.FindRemoteForRepo(dir, ref.Owner, ref.Repo)
	if err != nil {
		return false
	}
	refspecs := []string{fmt.Sprintf("+refs/pull/%d/head:refs/pr-review/%d", ref.Number, ref.Number)}
	if ctx.BaseRefOid != "" && !gitutil.IsCommit(dir, ctx.BaseRefOid) {
		refspecs = append(refspecs, fmt.Sprintf("+%s:refs/pr-review/%d-base", ctx.BaseRefOid, ref.Number))
	}
	if p := ctx.Pending; p != nil && p.CommitOid != "" && p.CommitOid != ctx.HeadRefOid && !gitutil.IsCommit(dir, p.CommitOid) {
		refspecs = append(refspecs, fmt.Sprintf("+%s:refs/pr-review/%d-pending", p.CommitOid, ref.Number))
	}
	fetch := s.FetchRefs
	if fetch == nil {
		fetch = ghLib.FetchRefs
	}
	c, cancel := context.WithTimeout(context.Background(), prFetchTimeout)
	defer cancel()
	if err := fetch(c, dir, remote, refspecs...); err != nil {
		log.Printf("fetching PR #%d commits: %v", ref.Number, err)
		return false
	}
	return true
}

// newPRTarget builds the target from ctx against the local repo, or
// errMissingCommit when a commit it needs is not there.
func newPRTarget(dir string, ref wgithub.PRRef, ctx *wgithub.PRWriteContext) (*prTarget, error) {
	t := &prTarget{ref: ref, ctx: ctx, commit: ctx.HeadRefOid}
	if ctx.Pending != nil && ctx.Pending.CommitOid != "" {
		t.commit = ctx.Pending.CommitOid
		t.pendingCommit = ctx.Pending.CommitOid
		t.stale = ctx.Pending.CommitOid != ctx.HeadRefOid
		// The head is needed too, to tell "newer than your pending review"
		// from "not pushed".
		if !gitutil.IsCommit(dir, ctx.HeadRefOid) {
			return nil, errMissingCommit
		}
	}
	if t.commit == "" || !gitutil.IsCommit(dir, t.commit) || !gitutil.IsCommit(dir, ctx.BaseRefOid) {
		return nil, errMissingCommit
	}
	mb, ok := gitutil.MergeBaseOf(dir, ctx.BaseRefOid, t.commit)
	if !ok {
		return nil, errMissingCommit
	}
	t.mergeBase = mb
	hunks, renames, err := gitutil.DiffHunks(dir, mb, t.commit)
	if err != nil {
		return nil, err
	}
	t.hunks, t.renames = hunks, renames
	return t, nil
}

// placeForPR decides whether GitHub would accept c on t, and where. lines
// reads a file at a rev; isAncestor(a, b) says whether commit a is an
// ancestor of commit b. See the spec's "Which comments can be posted".
func placeForPR(t *prTarget, c reviewcomments.Comment, lines func(rev, file string) []string, isAncestor func(a, b string) bool) prPlacement {
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
	// An old-side comment is stored under the old path; GitHub keys a
	// comment, LEFT side included, by the PR's (new) path.
	path := c.File
	if n, ok := t.renames[c.File]; ok && old {
		path = n
	}
	if !inOneHunk(t.hunks[path], old, pos.Start, pos.End) {
		return prPlacement{reason: reasonNotInDiff}
	}
	nc := wgithub.NewReviewComment{Path: path, Side: side, Line: pos.End, Body: c.Body}
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
