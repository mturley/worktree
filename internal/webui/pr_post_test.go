package webui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	wgithub "github.com/mturley/watcher/github"
	"github.com/mturley/worktree/internal/gitfetch"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/reviewcomments"
)

// numbered is n lines "line 1".."line n", with edits replacing lines by
// their 1-based number.
func numbered(n int, edits map[int]string) string {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		if e, ok := edits[i]; ok {
			b.WriteString(e + "\n")
			continue
		}
		fmt.Fprintf(&b, "line %d\n", i)
	}
	return b.String()
}

// testTarget builds the target for a PR with base base and head head, with a
// pending review on pending ("" for none).
func testTarget(t *testing.T, wt, base, head, pending string) *prTarget {
	t.Helper()
	ctx := &wgithub.PRWriteContext{PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: head}
	if pending != "" {
		ctx.Pending = &wgithub.PendingReview{ID: "R1", CommitOid: pending}
	}
	tg, err := newPRTarget(wt, wgithub.PRRef{Owner: "o", Repo: "r", Number: 1}, ctx)
	if err != nil {
		t.Fatal(err)
	}
	return tg
}

// testComment captures a comment on file's lines start..end at rev.
func testComment(t *testing.T, wt, rev, file string, side reviewcomments.Side, start, end int) reviewcomments.Comment {
	t.Helper()
	content, err := gitutil.ShowFile(wt, rev, file)
	if err != nil {
		t.Fatal(err)
	}
	a, err := reviewcomments.Capture(reviewcomments.SplitLines(content), start, end)
	if err != nil {
		t.Fatal(err)
	}
	return reviewcomments.Comment{ID: 1, File: file, Side: side, Rev: rev, Anchor: a, Body: "b"}
}

func place(wt string, tg *prTarget, c reviewcomments.Comment) prPlacement {
	r := newReviewResolver()
	return placeForPR(wt, tg, c,
		func(rev, file string) []string { return r.linesAt(wt, rev, file) },
		func(a, b string) bool { return gitutil.IsAncestor(wt, a, b) })
}

func wantReason(t *testing.T, got prPlacement, reason string) {
	t.Helper()
	if got.ok || got.reason != reason {
		t.Fatalf("placement = %+v; want reason %q", got, reason)
	}
}

// hunkRepo: base has a 30-line file "long"; head changes lines 5 and 25,
// two separate hunks (2-8 and 22-28).
func hunkRepo(t *testing.T) (wt, base, head string) {
	wt = forkRepo(t)
	commitFile(t, wt, "long", numbered(30, nil))
	base = headSHA(t, wt)
	commitFile(t, wt, "long", numbered(30, map[int]string{5: "five", 25: "twenty-five"}))
	return wt, base, headSHA(t, wt)
}

func TestPlaceForPRPostable(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "multi", rcMulti)
	c1 := headSHA(t, wt)
	base := strings.TrimSpace(gitIn(t, wt, "rev-parse", "origin/main"))
	tg := testTarget(t, wt, base, c1, "")
	if tg.commit != c1 || tg.stale || tg.pendingCommit != "" {
		t.Fatalf("target = %+v", tg)
	}

	got := place(wt, tg, testComment(t, wt, c1, "multi", reviewcomments.SideNew, 4, 4))
	want := wgithub.NewReviewComment{Path: "multi", Side: "RIGHT", Line: 4, Body: "b"}
	if !got.ok || got.reason != "" || got.comment != want {
		t.Fatalf("placement = %+v", got)
	}

	got = place(wt, tg, testComment(t, wt, c1, "multi", reviewcomments.SideNew, 3, 4))
	want = wgithub.NewReviewComment{Path: "multi", Side: "RIGHT", StartLine: 3, Line: 4, Body: "b"}
	if !got.ok || got.comment != want {
		t.Fatalf("range placement = %+v", got)
	}
}

func TestPlaceForPRUncommitted(t *testing.T) {
	wt, base, head := hunkRepo(t)
	tg := testTarget(t, wt, base, head, "")
	c := testComment(t, wt, head, "long", reviewcomments.SideNew, 5, 5)
	c.Rev = reviewcomments.RevUncommitted
	wantReason(t, place(wt, tg, c), "on uncommitted changes")
}

func TestPlaceForPRNotPushed(t *testing.T) {
	wt, base, head := hunkRepo(t)
	commitFile(t, wt, "long", numbered(30, map[int]string{5: "five", 6: "six", 25: "twenty-five"}))
	local := headSHA(t, wt)
	tg := testTarget(t, wt, base, head, "")
	wantReason(t, place(wt, tg, testComment(t, wt, local, "long", reviewcomments.SideNew, 6, 6)),
		"on a commit not pushed to the PR")
}

func TestPlaceForPROutOfDate(t *testing.T) {
	wt, base, c1 := hunkRepo(t)
	commitFile(t, wt, "long", numbered(30, map[int]string{5: "FIVE", 25: "twenty-five"}))
	head := headSHA(t, wt)
	tg := testTarget(t, wt, base, head, "")
	wantReason(t, place(wt, tg, testComment(t, wt, c1, "long", reviewcomments.SideNew, 5, 5)), "out of date")
}

func TestPlaceForPRContextOnly(t *testing.T) {
	wt, base, head := hunkRepo(t)
	tg := testTarget(t, wt, base, head, "")
	wantReason(t, place(wt, tg, testComment(t, wt, head, "long", reviewcomments.SideNew, 15, 15)),
		"not part of the PR's changes")
	// A file the PR does not touch at all.
	wantReason(t, place(wt, tg, testComment(t, wt, head, "base", reviewcomments.SideNew, 1, 1)),
		"not part of the PR's changes")
	// A context line inside a hunk is fine.
	if got := place(wt, tg, testComment(t, wt, head, "long", reviewcomments.SideNew, 3, 3)); !got.ok || got.comment.Line != 3 {
		t.Fatalf("context line in a hunk: %+v", got)
	}
}

func TestPlaceForPRCrossesHunks(t *testing.T) {
	wt, base, head := hunkRepo(t)
	tg := testTarget(t, wt, base, head, "")
	wantReason(t, place(wt, tg, testComment(t, wt, head, "long", reviewcomments.SideNew, 5, 25)),
		"not part of the PR's changes")
}

func TestPlaceForPROldSide(t *testing.T) {
	wt, base, head := hunkRepo(t)
	tg := testTarget(t, wt, base, head, "")
	if tg.mergeBase != base {
		t.Fatalf("mergeBase = %s, want %s", tg.mergeBase, base)
	}
	// Written on the old side of a view whose old rev is the base.
	got := place(wt, tg, testComment(t, wt, base, "long", reviewcomments.SideOld, 25, 25))
	want := wgithub.NewReviewComment{Path: "long", Side: "LEFT", Line: 25, Body: "b"}
	if !got.ok || got.comment != want {
		t.Fatalf("placement = %+v", got)
	}
	// The old side's lines outside the hunks are refused like the new side's.
	wantReason(t, place(wt, tg, testComment(t, wt, base, "long", reviewcomments.SideOld, 15, 15)),
		"not part of the PR's changes")
}

// pendingRepo: base has "long"; c0 changes line 5; pending (the pending
// review's commit) inserts two lines on top, moving line 5 to 7; head then
// changes line 25 (27 by then).
func pendingRepo(t *testing.T) (wt, base, c0, pending, head string) {
	wt = forkRepo(t)
	commitFile(t, wt, "long", numbered(30, nil))
	base = headSHA(t, wt)
	commitFile(t, wt, "long", numbered(30, map[int]string{5: "five"}))
	c0 = headSHA(t, wt)
	commitFile(t, wt, "long", "top1\ntop2\n"+numbered(30, map[int]string{5: "five"}))
	pending = headSHA(t, wt)
	commitFile(t, wt, "long", "top1\ntop2\n"+numbered(30, map[int]string{5: "five", 25: "twenty-five"}))
	return wt, base, c0, pending, headSHA(t, wt)
}

func TestPRTargetUsesPendingCommit(t *testing.T) {
	wt, base, c0, pending, head := pendingRepo(t)
	srv, _ := gitTestServer(t, wt, nil)
	srv.FetchPRWriteContext = func(string, wgithub.PRRef) (*wgithub.PRWriteContext, error) {
		return &wgithub.PRWriteContext{
			PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: head,
			Pending: &wgithub.PendingReview{ID: "R1", CommitOid: pending},
		}, nil
	}
	pc := prComments{pr: &prRefDTO{ID: "PR1", Number: 1}, token: "t", ref: wgithub.PRRef{Owner: "o", Repo: "r", Number: 1}}
	tg, err := srv.loadPRTarget(wt, pc)
	if err != nil {
		t.Fatal(err)
	}
	if tg.commit != pending || !tg.stale || tg.pendingCommit != pending || tg.mergeBase != base {
		t.Fatalf("target = %+v", tg)
	}

	got := place(wt, tg, testComment(t, wt, c0, "long", reviewcomments.SideNew, 5, 5))
	want := wgithub.NewReviewComment{Path: "long", Side: "RIGHT", Line: 7, Body: "b"}
	if !got.ok || got.comment != want {
		t.Fatalf("placement = %+v", got)
	}
}

func TestPRTargetNotStaleAtHead(t *testing.T) {
	wt, base, _, _, head := pendingRepo(t)
	tg := testTarget(t, wt, base, head, head)
	if tg.commit != head || tg.stale || tg.pendingCommit != head {
		t.Fatalf("target = %+v", tg)
	}
}

func TestPlaceForPRNewerThanPending(t *testing.T) {
	wt, base, _, pending, head := pendingRepo(t)
	tg := testTarget(t, wt, base, head, pending)
	wantReason(t, place(wt, tg, testComment(t, wt, head, "long", reviewcomments.SideNew, 27, 27)),
		"newer than your pending review")

	// A commit that never reached the PR is still not pushed.
	commitFile(t, wt, "long", "local\n")
	wantReason(t, place(wt, tg, testComment(t, wt, headSHA(t, wt), "long", reviewcomments.SideNew, 1, 1)),
		"on a commit not pushed to the PR")
}

func TestPRTargetMissingCommitNudgesFetch(t *testing.T) {
	wt, base, _ := hunkRepo(t)
	var fetches atomic.Int32
	sched := gitfetch.New(context.Background(), time.Hour)
	sched.Fetch = func(context.Context, string, string) error {
		fetches.Add(1)
		return nil
	}
	srv, _ := gitTestServer(t, wt, sched)
	srv.FetchPRWriteContext = func(string, wgithub.PRRef) (*wgithub.PRWriteContext, error) {
		return &wgithub.PRWriteContext{
			PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		}, nil
	}
	pc := prComments{pr: &prRefDTO{ID: "PR1", Number: 1}, token: "t", ref: wgithub.PRRef{Owner: "o", Repo: "r", Number: 1}}
	if _, err := srv.loadPRTarget(wt, pc); !errors.Is(err, errMissingCommit) {
		t.Fatalf("err = %v; want errMissingCommit", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for fetches.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if fetches.Load() == 0 {
		t.Fatal("no fetch was nudged")
	}
}
