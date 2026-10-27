package webui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	wgithub "github.com/mturley/watcher/github"
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
	return placeForPR(tg, c,
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
	tg, err := srv.loadPRTarget(wt, pc, false)
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

func TestPRTargetMissingCommit(t *testing.T) {
	wt, base, _ := hunkRepo(t)
	srv, calls := prTargetServer(t, wt, &wgithub.PRWriteContext{
		PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	}, nil)
	if _, err := srv.loadPRTarget(wt, testPC(), false); !errors.Is(err, errMissingCommit) {
		t.Fatalf("err = %v; want errMissingCommit", err)
	}
	if want := []string{"gh +refs/pull/1/head:refs/pr-review/1"}; !reflect.DeepEqual(*calls, want) {
		t.Fatalf("fetches = %q, want %q", *calls, want)
	}
}

// TestPlaceForPROldSideRenamed: the PR renames "long" to "renamed" and
// edits it; an old-side comment (stored under the old path) on a removed
// line posts LEFT on the new path, which is the PR's.
func TestPlaceForPROldSideRenamed(t *testing.T) {
	wt := forkRepo(t)
	commitFile(t, wt, "long", numbered(30, nil))
	base := headSHA(t, wt)
	gitIn(t, wt, "mv", "long", "renamed")
	commitFile(t, wt, "renamed", numbered(30, map[int]string{12: "twelve"}))
	head := headSHA(t, wt)
	tg := testTarget(t, wt, base, head, "")

	got := place(wt, tg, testComment(t, wt, base, "long", reviewcomments.SideOld, 12, 12))
	want := wgithub.NewReviewComment{Path: "renamed", Side: "LEFT", Line: 12, Body: "b"}
	if !got.ok || got.comment != want {
		t.Fatalf("placement = %+v", got)
	}
}

// prTargetServer serves wt with a PR o/r#1 whose write context is ctx, a
// "gh" remote matching o/r, and a stubbed targeted fetch that records its
// calls and runs fetch (when not nil) in their place.
func prTargetServer(t *testing.T, wt string, ctx *wgithub.PRWriteContext, fetch func() error) (*Server, *[]string) {
	t.Helper()
	gitIn(t, wt, "remote", "add", "gh", "https://github.com/o/r.git")
	srv, _ := gitTestServer(t, wt, nil)
	srv.FetchPRWriteContext = func(string, wgithub.PRRef) (*wgithub.PRWriteContext, error) { return ctx, nil }
	var calls []string
	srv.FetchRefs = func(_ context.Context, dir, remote string, refspecs ...string) error {
		calls = append(calls, remote+" "+strings.Join(refspecs, " "))
		if fetch != nil {
			return fetch()
		}
		return nil
	}
	return srv, &calls
}

func testPC() prComments {
	return prComments{pr: &prRefDTO{ID: "PR1", Number: 1}, token: "t", ref: wgithub.PRRef{Owner: "o", Repo: "r", Number: 1}}
}

// TestPRTargetFetchesMissingHead: a head only on the remote is fetched,
// synchronously, by its pull ref, and the target is then built.
func TestPRTargetFetchesMissingHead(t *testing.T) {
	wt, base, _ := hunkRepo(t)
	// A commit pushed to the PR from elsewhere, not yet fetched here.
	other := filepath.Join(filepath.Dir(wt), "other")
	gitIn(t, wt, "push", "origin", "HEAD:refs/heads/pr")
	gitIn(t, other, "fetch", "origin")
	gitIn(t, other, "checkout", "-b", "pr", "origin/pr")
	commitFile(t, other, "long", numbered(30, map[int]string{5: "five", 9: "nine", 25: "twenty-five"}))
	remoteHead := headSHA(t, other)
	gitIn(t, other, "push", "origin", "pr")

	srv, calls := prTargetServer(t, wt, &wgithub.PRWriteContext{PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: remoteHead},
		func() error { gitIn(t, wt, "fetch", "origin", "pr:refs/pr-review/1"); return nil })
	tg, err := srv.loadPRTarget(wt, testPC(), false)
	if err != nil {
		t.Fatal(err)
	}
	if tg.commit != remoteHead {
		t.Fatalf("commit = %s, want %s", tg.commit, remoteHead)
	}
	if want := []string{"gh +refs/pull/1/head:refs/pr-review/1"}; !reflect.DeepEqual(*calls, want) {
		t.Fatalf("fetches = %q, want %q", *calls, want)
	}
}

func TestPRTargetNoFetchWhenPresent(t *testing.T) {
	wt, base, head := hunkRepo(t)
	srv, calls := prTargetServer(t, wt, &wgithub.PRWriteContext{PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: head}, nil)
	if _, err := srv.loadPRTarget(wt, testPC(), false); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("fetches = %q, want none", *calls)
	}
}

// With a pending review, the PR head must be local too, or "newer than your
// pending review" would read as "not pushed".
func TestPRTargetMissingHeadWithPending(t *testing.T) {
	wt, base, _, pending, _ := pendingRepo(t)
	srv, calls := prTargetServer(t, wt, &wgithub.PRWriteContext{
		PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		Pending: &wgithub.PendingReview{ID: "R1", CommitOid: pending},
	}, nil)
	if _, err := srv.loadPRTarget(wt, testPC(), false); !errors.Is(err, errMissingCommit) {
		t.Fatalf("err = %v; want errMissingCommit", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("fetches = %q, want one", *calls)
	}
}

func TestPRTargetNoFetchWhenSettingOff(t *testing.T) {
	wt, base, _ := hunkRepo(t)
	srv, calls := prTargetServer(t, wt, &wgithub.PRWriteContext{
		PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	}, nil)
	if err := os.WriteFile(srv.ConfigPath, []byte("git:\n  background_fetch: false\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.loadPRTarget(wt, testPC(), false); !errors.Is(err, errMissingCommit) {
		t.Fatalf("err = %v; want errMissingCommit", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("fetches = %q, want none", *calls)
	}
}

// TestPRTargetMissCachedBriefly: a targeted fetch that leaves commits
// missing is not retried for prFetchMissTTL, so a failing remote does not
// cost every request a 30s fetch.
func TestPRTargetMissCachedBriefly(t *testing.T) {
	wt, base, _ := hunkRepo(t)
	srv, calls := prTargetServer(t, wt, &wgithub.PRWriteContext{
		PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	}, func() error { return errors.New("network down") })
	now := time.Now()
	srv.prThreadsCacheOrInit().now = func() time.Time { return now }
	for i := 0; i < 2; i++ {
		if _, err := srv.loadPRTarget(wt, testPC(), false); !errors.Is(err, errMissingCommit) {
			t.Fatalf("call %d: err = %v; want errMissingCommit", i, err)
		}
	}
	if len(*calls) != 1 {
		t.Fatalf("fetches = %q, want one", *calls)
	}
	now = now.Add(prFetchMissTTL + time.Second)
	srv.prThreadsCacheOrInit().del("prctx|PR1")
	if _, err := srv.loadPRTarget(wt, testPC(), false); !errors.Is(err, errMissingCommit) {
		t.Fatalf("err = %v; want errMissingCommit", err)
	}
	if len(*calls) != 2 {
		t.Fatalf("fetches = %q, want two after the TTL", *calls)
	}
}

// TestPRTargetMissRetriesMovedHead: the remembered miss is for the commits
// it was about; a new head is fetched at once.
func TestPRTargetMissRetriesMovedHead(t *testing.T) {
	wt, base, _ := hunkRepo(t)
	ctx := &wgithub.PRWriteContext{PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}
	srv, calls := prTargetServer(t, wt, ctx, func() error { return errors.New("network down") })
	if _, err := srv.loadPRTarget(wt, testPC(), false); !errors.Is(err, errMissingCommit) {
		t.Fatalf("err = %v; want errMissingCommit", err)
	}
	ctx.HeadRefOid = "feedfacefeedfacefeedfacefeedfacefeedface"
	srv.prThreadsCacheOrInit().del("prctx|PR1")
	if _, err := srv.loadPRTarget(wt, testPC(), false); !errors.Is(err, errMissingCommit) {
		t.Fatalf("err = %v; want errMissingCommit", err)
	}
	if len(*calls) != 2 {
		t.Fatalf("fetches = %q, want two", *calls)
	}
}

// TestPRTargetHeadOnly: the head-only target ignores a pending review, and
// fetches only what it needs (not the pending review's commit).
func TestPRTargetHeadOnly(t *testing.T) {
	wt, base, _, pending, head := pendingRepo(t)
	ctx := &wgithub.PRWriteContext{
		PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: head,
		Pending: &wgithub.PendingReview{ID: "R1", CommitOid: pending},
	}
	srv, calls := prTargetServer(t, wt, ctx, nil)
	tg, err := srv.loadPRTarget(wt, testPC(), true)
	if err != nil {
		t.Fatal(err)
	}
	if tg.commit != head || tg.stale || tg.pendingCommit != "" || tg.mergeBase != base {
		t.Fatalf("target = %+v", tg)
	}
	if tg, err = srv.loadPRTarget(wt, testPC(), false); err != nil || tg.commit != pending || !tg.stale {
		t.Fatalf("pending-aware target = %+v, %v", tg, err)
	}

	// A pending review on a commit not here does not matter to it.
	ctx.Pending.CommitOid = "cafebabecafebabecafebabecafebabecafebabe"
	srv.prThreadsCacheOrInit().del("prctx|PR1")
	if _, err := srv.loadPRTarget(wt, testPC(), true); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("fetches = %q, want none", *calls)
	}
}

// TestPRTargetMissDoesNotBlockPresent: once the commits arrive (say by the
// background fetch), the remembered miss does not block the target.
func TestPRTargetMissDoesNotBlockPresent(t *testing.T) {
	wt, base, head := hunkRepo(t)
	ctx := &wgithub.PRWriteContext{PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}
	srv, _ := prTargetServer(t, wt, ctx, func() error { return errors.New("network down") })
	if _, err := srv.loadPRTarget(wt, testPC(), false); !errors.Is(err, errMissingCommit) {
		t.Fatalf("err = %v; want errMissingCommit", err)
	}
	ctx.HeadRefOid = head
	srv.prThreadsCacheOrInit().del("prctx|PR1")
	if _, err := srv.loadPRTarget(wt, testPC(), false); err != nil {
		t.Fatal(err)
	}
}

// TestPRTargetFetchesMissingPending: a pending review on a commit no longer
// on the PR's head ref (after a force-push) is fetched by id.
func TestPRTargetFetchesMissingPending(t *testing.T) {
	wt, base, head := hunkRepo(t)
	gone := "cafebabecafebabecafebabecafebabecafebabe"
	srv, calls := prTargetServer(t, wt, &wgithub.PRWriteContext{
		PullRequestID: "PR1", BaseRefOid: base, HeadRefOid: head,
		Pending: &wgithub.PendingReview{ID: "R1", CommitOid: gone},
	}, nil)
	if _, err := srv.loadPRTarget(wt, testPC(), false); !errors.Is(err, errMissingCommit) {
		t.Fatalf("err = %v; want errMissingCommit", err)
	}
	want := []string{"gh +refs/pull/1/head:refs/pr-review/1 +" + gone + ":refs/pr-review/1-pending"}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("fetches = %q, want %q", *calls, want)
	}
}
