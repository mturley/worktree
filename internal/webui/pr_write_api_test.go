package webui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/reviewcomments"
)

// prwFixture is a prcFixture whose worktree has a PR: base adds a 30-line
// file "long"; head changes its lines 5 and 25 (hunks 2-8 and 22-28). Both
// revs are handed out, and every write seam and the targeted fetch (via a
// "gh" remote for o/r) are stubbed and recorded, so nothing reaches GitHub
// or a real remote.
type prwFixture struct {
	*prcFixture
	base, head string
	calls      []string
}

func newPRWFixture(t *testing.T) *prwFixture {
	t.Helper()
	f := &prwFixture{prcFixture: newPRCFixture(t)}
	commitFile(t, f.wt, "long", numbered(30, nil))
	f.base = headSHA(t, f.wt)
	commitFile(t, f.wt, "long", numbered(30, map[int]string{5: "five", 25: "twenty-five"}))
	f.head = headSHA(t, f.wt)
	f.writeCtx = &wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: f.head}
	f.srv.revSet().add(f.wt, f.base, f.head)

	rec := func(format string, a ...any) { f.calls = append(f.calls, fmt.Sprintf(format, a...)) }
	gitIn(t, f.wt, "remote", "add", "gh", "https://github.com/o/r.git")
	f.srv.FetchRefs = func(_ context.Context, dir, remote string, refspecs ...string) error {
		rec("fetch %s %s", remote, strings.Join(refspecs, " "))
		return nil
	}
	f.srv.StartReview = func(token, prID, commit string) (string, error) {
		rec("start %s %s %s", token, prID, commit)
		return "R_new", nil
	}
	f.srv.AddReviewThread = func(token, reviewID string, c wgithub.NewReviewComment) (int64, error) {
		rec("thread %s %s %+v", token, reviewID, c)
		return 101, nil
	}
	f.srv.AddReviewReply = func(token, reviewID, threadID, body string) (int64, error) {
		rec("reply %s %s %s %s", token, reviewID, threadID, body)
		return 102, nil
	}
	f.srv.PostComment = func(token string, ref wgithub.PRRef, commit string, c wgithub.NewReviewComment) (int64, error) {
		rec("comment %s %s/%s#%d %s %+v", token, ref.Owner, ref.Repo, ref.Number, commit, c)
		return 103, nil
	}
	f.srv.PostReply = func(token string, ref wgithub.PRRef, inReplyTo int64, body string) (int64, error) {
		rec("single-reply %s %s/%s#%d %d %s", token, ref.Owner, ref.Repo, ref.Number, inReplyTo, body)
		return 104, nil
	}
	return f
}

// setCtx replaces the PR's write context and drops the cached one.
func (f *prwFixture) setCtx(ctx *wgithub.PRWriteContext) {
	f.writeCtx = ctx
	f.srv.prThreadsCacheOrInit().del("prctx|" + prcID)
}

func (f *prwFixture) post(t *testing.T, route string, body map[string]any) (int, map[string]any) {
	t.Helper()
	if _, ok := body["path"]; !ok {
		body["path"] = f.wt
	}
	b, err := json.Marshal(body)
	must(t, err)
	resp, err := http.Post(f.ts.URL+route, "application/json", bytes.NewReader(b))
	must(t, err)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

type prwVerdict struct {
	Postable bool   `json:"postable"`
	Reason   string `json:"reason"`
}

type prwCheck struct {
	Review prwVerdict `json:"review"`
	Single prwVerdict `json:"single"`
}

func (f *prwFixture) check(t *testing.T, side string, start, end int, oldRev, newRev string) prwCheck {
	t.Helper()
	code, body := f.get(t, "/api/pr-write/check", fmt.Sprintf("&file=long&side=%s&start_line=%d&end_line=%d&old_rev=%s&new_rev=%s",
		side, start, end, url.QueryEscape(oldRev), url.QueryEscape(newRev)))
	if code != 200 {
		t.Fatalf("check status %d: %s", code, body)
	}
	var c prwCheck
	must(t, json.Unmarshal(body, &c))
	return c
}

// wantCheck wants both modes' verdict to be reason ("" for postable).
func wantCheck(t *testing.T, got prwCheck, reason string) {
	t.Helper()
	wantModes(t, got, reason, reason)
}

// wantModes wants review's and single's verdicts ("" for postable).
func wantModes(t *testing.T, got prwCheck, review, single string) {
	t.Helper()
	want := prwCheck{Review: prwVerdict{review == "", review}, Single: prwVerdict{single == "", single}}
	if got != want {
		t.Fatalf("check = %+v; want %+v", got, want)
	}
}

func (f *prwFixture) wantCalls(t *testing.T, want ...string) {
	t.Helper()
	if len(want) == 0 && len(f.calls) == 0 {
		return
	}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls = %q\nwant    %q", f.calls, want)
	}
}

func TestPRWriteCheck(t *testing.T) {
	f := newPRWFixture(t)
	wantCheck(t, f.check(t, "new", 5, 5, f.base, f.head), "")
	wantCheck(t, f.check(t, "old", 25, 25, f.base, f.head), "")
	wantCheck(t, f.check(t, "new", 15, 15, f.base, f.head), "not part of the PR's changes")

	// The PR moved on and changed line 5 again.
	commitFile(t, f.wt, "long", numbered(30, map[int]string{5: "FIVE", 25: "twenty-five"}))
	c2 := headSHA(t, f.wt)
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: c2})
	wantCheck(t, f.check(t, "new", 5, 5, f.base, f.head), "out of date")

	// A local commit the PR does not have.
	commitFile(t, f.wt, "long", numbered(30, map[int]string{5: "FIVE", 10: "ten", 25: "twenty-five"}))
	c3 := headSHA(t, f.wt)
	f.srv.revSet().add(f.wt, c3)
	wantCheck(t, f.check(t, "new", 10, 10, f.base, c3), "on a commit not pushed to the PR")

	// c3 pushed, but a pending review sits on c2.
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: c3,
		Pending: &wgithub.PendingReview{ID: "R1", CommitOid: c2}})
	// A single comment goes on the head, so it is unaffected.
	wantModes(t, f.check(t, "new", 10, 10, f.base, c3), "newer than your pending review", "")

	// Uncommitted lines, from a working-tree view.
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: c3})
	must(t, os.WriteFile(filepath.Join(f.wt, "long"), []byte(numbered(30, map[int]string{5: "FIVE", 10: "ten", 12: "dirty", 25: "twenty-five"})), 0o644))
	p := getPatch(t, f.ts, f.wt, "")
	wantCheck(t, f.check(t, "new", 12, 12, p.OldRev, p.NewRev), "on uncommitted changes")

	// The PR head is not in the local repo.
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"})
	wantCheck(t, f.check(t, "new", 5, 5, f.base, f.head), "Fetch the PR's latest commits first")
	// Both modes' targets are the same with no pending review: one fetch,
	// whose miss the second reuses.
	f.wantCalls(t, "fetch gh +refs/pull/1/head:refs/pr-review/1")
	f.calls = nil

	// Bad requests.
	if code, _ := f.get(t, "/api/pr-write/check", "&file=long&side=new&start_line=5&end_line=5&old_rev="+f.base+"&new_rev=abc"); code != 404 {
		t.Fatalf("unknown rev: %d", code)
	}
	if code, _ := f.get(t, "/api/pr-write/check", "&file=long&side=up&start_line=5&end_line=5&old_rev="+f.base+"&new_rev="+f.head); code != 400 {
		t.Fatalf("bad side: %d", code)
	}
	if code, _ := f.get(t, "/api/pr-write/check", "&file=long&side=new&start_line=x&end_line=5&old_rev="+f.base+"&new_rev="+f.head); code != 400 {
		t.Fatalf("bad line: %d", code)
	}
}

func (f *prwFixture) comment(t *testing.T, mode string, start, end int, body string) (int, map[string]any) {
	t.Helper()
	return f.post(t, "/api/pr-write/comment", map[string]any{
		"mode": mode, "file": "long", "side": "new", "start_line": start, "end_line": end,
		"body": body, "old_rev": f.base, "new_rev": f.head,
	})
}

func TestPRWriteCommentReviewStartsReview(t *testing.T) {
	f := newPRWFixture(t)
	code, out := f.comment(t, "review", 4, 5, "looks off")
	if code != 200 || out["comment_id"] != float64(101) {
		t.Fatalf("status %d: %v", code, out)
	}
	f.wantCalls(t,
		"start tok PR_node "+f.head,
		"thread tok R_new {Path:long Side:RIGHT Line:5 StartLine:4 Body:looks off}")

	// Unpostable lines are refused with the reason, and nothing is written.
	f.calls = nil
	code, out = f.comment(t, "review", 15, 15, "x")
	if code != 409 || out["reason"] != "not part of the PR's changes" {
		t.Fatalf("unpostable: %d %v", code, out)
	}
	f.wantCalls(t)
}

func TestPRWriteCommentReviewAddsToExisting(t *testing.T) {
	f := newPRWFixture(t)
	f.writeCtx.Pending = &wgithub.PendingReview{ID: "R1", CommitOid: f.head}
	code, out := f.comment(t, "review", 5, 5, "hm")
	if code != 200 || out["comment_id"] != float64(101) {
		t.Fatalf("status %d: %v", code, out)
	}
	f.wantCalls(t, "thread tok R1 {Path:long Side:RIGHT Line:5 StartLine:0 Body:hm}")
}

func TestPRWriteCommentSingle(t *testing.T) {
	f := newPRWFixture(t)
	code, out := f.comment(t, "single", 5, 5, "now")
	if code != 200 || out["comment_id"] != float64(103) {
		t.Fatalf("status %d: %v", code, out)
	}
	f.wantCalls(t, "comment tok o/r#1 "+f.head+" {Path:long Side:RIGHT Line:5 StartLine:0 Body:now}")

	// Missing commits block the write with the fetch reason.
	f.calls = nil
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"})
	code, out = f.comment(t, "single", 5, 5, "now")
	if code != 409 || out["reason"] != "Fetch the PR's latest commits first" {
		t.Fatalf("missing commit: %d %v", code, out)
	}
	f.wantCalls(t, "fetch gh +refs/pull/1/head:refs/pr-review/1")
}

// TestPRWriteCommentSingleStalePending: with a pending review on an older
// commit, a single comment is still placed on and posted at the PR head,
// while the same lines in review mode go on the pending review's commit.
func TestPRWriteCommentSingleStalePending(t *testing.T) {
	f := newPRWFixture(t)
	// c2 inserts two lines on top (line 5 moves to 7) and changes line 10.
	commitFile(t, f.wt, "long", "top1\ntop2\n"+numbered(30, map[int]string{5: "five", 10: "ten", 25: "twenty-five"}))
	c2 := headSHA(t, f.wt)
	f.srv.revSet().add(f.wt, c2)
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: c2,
		Pending: &wgithub.PendingReview{ID: "R1", CommitOid: f.head}})

	// Line 12 ("ten") is newer than the pending review, but fine on the head.
	wantModes(t, f.check(t, "new", 12, 12, f.base, c2), "newer than your pending review", "")
	wantCheck(t, f.check(t, "new", 5, 5, f.base, f.head), "")

	// Written on line 5 of the pending review's commit: single posts at the
	// head, where it is line 7.
	code, out := f.comment(t, "single", 5, 5, "now")
	if code != 200 || out["comment_id"] != float64(103) {
		t.Fatalf("single: %d %v", code, out)
	}
	f.wantCalls(t, "comment tok o/r#1 "+c2+" {Path:long Side:RIGHT Line:7 StartLine:0 Body:now}")

	// Review mode adds it to the pending review, on its commit's line 5.
	f.calls = nil
	if code, _ := f.comment(t, "review", 5, 5, "later"); code != 200 {
		t.Fatalf("review: %d", code)
	}
	f.wantCalls(t, "thread tok R1 {Path:long Side:RIGHT Line:5 StartLine:0 Body:later}")

	// Lines newer than the pending review: single posts, review refuses.
	f.calls = nil
	code, out = f.post(t, "/api/pr-write/comment", map[string]any{
		"mode": "review", "file": "long", "side": "new", "start_line": 12, "end_line": 12,
		"body": "x", "old_rev": f.base, "new_rev": c2,
	})
	if code != 409 || out["reason"] != "newer than your pending review" {
		t.Fatalf("review newer: %d %v", code, out)
	}
	code, _ = f.post(t, "/api/pr-write/comment", map[string]any{
		"mode": "single", "file": "long", "side": "new", "start_line": 12, "end_line": 12,
		"body": "x", "old_rev": f.base, "new_rev": c2,
	})
	if code != 200 {
		t.Fatalf("single newer: %d", code)
	}
	f.wantCalls(t, "comment tok o/r#1 "+c2+" {Path:long Side:RIGHT Line:12 StartLine:0 Body:x}")
}

func TestPRWriteCommentValidation(t *testing.T) {
	f := newPRWFixture(t)
	if code, _ := f.comment(t, "review", 5, 5, strings.Repeat("x", maxReviewCommentBody+1)); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("too long: %d", code)
	}
	if code, _ := f.comment(t, "review", 5, 5, "  "); code != 400 {
		t.Fatalf("empty: %d", code)
	}
	if code, _ := f.comment(t, "later", 5, 5, "x"); code != 400 {
		t.Fatalf("bad mode: %d", code)
	}
	if code, _ := f.post(t, "/api/pr-write/reply", map[string]any{"mode": "single", "in_reply_to": 11, "body": strings.Repeat("x", maxReviewCommentBody+1)}); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("reply too long: %d", code)
	}
	if code, _ := f.post(t, "/api/pr-write/reply", map[string]any{"mode": "review", "body": "x"}); code != 400 {
		t.Fatalf("reply without thread: %d", code)
	}
	if code, _ := f.post(t, "/api/pr-write/reply", map[string]any{"mode": "single", "body": "x"}); code != 400 {
		t.Fatalf("reply without in_reply_to: %d", code)
	}
	f.wantCalls(t)
}

func TestPRWriteReplyModes(t *testing.T) {
	f := newPRWFixture(t)
	code, out := f.post(t, "/api/pr-write/reply", map[string]any{"thread_id": "T1", "in_reply_to": 11, "mode": "review", "body": "agreed"})
	if code != 200 || out["comment_id"] != float64(102) {
		t.Fatalf("review: %d %v", code, out)
	}
	f.wantCalls(t, "start tok PR_node "+f.head, "reply tok R_new T1 agreed")

	f.calls = nil
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: f.head,
		Pending: &wgithub.PendingReview{ID: "R1", CommitOid: f.head}})
	code, _ = f.post(t, "/api/pr-write/reply", map[string]any{"thread_id": "T1", "in_reply_to": 11, "mode": "review", "body": "again"})
	if code != 200 {
		t.Fatalf("review on pending: %d", code)
	}
	f.wantCalls(t, "reply tok R1 T1 again")

	f.calls = nil
	code, out = f.post(t, "/api/pr-write/reply", map[string]any{"thread_id": "T1", "in_reply_to": 11, "mode": "single", "body": "now"})
	if code != 200 || out["comment_id"] != float64(104) {
		t.Fatalf("single: %d %v", code, out)
	}
	f.wantCalls(t, "single-reply tok o/r#1 11 now")
}

func TestPRWriteOffMakesNoCall(t *testing.T) {
	f := newPRWFixture(t)
	f.srv.SetWatchersDisabled(map[string]bool{config.ServiceGitHub: true})
	code, body := f.get(t, "/api/pr-write/check", "&file=long&side=new&start_line=5&end_line=5&old_rev="+f.base+"&new_rev="+f.head)
	if code != 409 || !strings.Contains(string(body), `"state":"off"`) {
		t.Fatalf("check: %d %s", code, body)
	}
	for _, mode := range []string{"review", "single"} {
		if code, out := f.comment(t, mode, 5, 5, "x"); code != 409 || out["state"] != "off" {
			t.Fatalf("comment %s: %d %v", mode, code, out)
		}
		if code, out := f.post(t, "/api/pr-write/reply", map[string]any{"thread_id": "T1", "in_reply_to": 11, "mode": mode, "body": "x"}); code != 409 || out["state"] != "off" {
			t.Fatalf("reply %s: %d %v", mode, code, out)
		}
	}
	f.wantCalls(t)
	if f.sumCalls.Load()+f.threadsCalls.Load()+f.ctxCalls.Load() != 0 {
		t.Fatalf("GitHub called: sum=%d threads=%d ctx=%d", f.sumCalls.Load(), f.threadsCalls.Load(), f.ctxCalls.Load())
	}
}

func TestPRWriteNoPR404(t *testing.T) {
	f := newPRWFixture(t)
	f.prcFixture.head = "someone-elses-branch"
	if code, _ := f.get(t, "/api/pr-write/check", "&file=long&side=new&start_line=5&end_line=5&old_rev="+f.base+"&new_rev="+f.head); code != 404 {
		t.Fatalf("check: %d", code)
	}
	if code, _ := f.comment(t, "single", 5, 5, "x"); code != 404 {
		t.Fatalf("comment: %d", code)
	}
	if code, _ := f.post(t, "/api/pr-write/reply", map[string]any{"thread_id": "T1", "in_reply_to": 11, "mode": "single", "body": "x"}); code != 404 {
		t.Fatalf("reply: %d", code)
	}
	f.wantCalls(t)
}

func TestPRWriteInvalidatesCache(t *testing.T) {
	f := newPRWFixture(t)
	f.summary(t) // caches the threads and the write context
	threads, ctxs := f.threadsCalls.Load(), f.ctxCalls.Load()
	f.summary(t)
	if f.threadsCalls.Load() != threads || f.ctxCalls.Load() != ctxs {
		t.Fatal("summary not cached")
	}

	if code, _ := f.comment(t, "single", 5, 5, "x"); code != 200 {
		t.Fatalf("comment: %d", code)
	}
	threads, ctxs = f.threadsCalls.Load(), f.ctxCalls.Load()
	f.summary(t)
	if f.threadsCalls.Load() != threads+1 || f.ctxCalls.Load() != ctxs+1 {
		t.Fatalf("after comment: threads %d→%d ctx %d→%d", threads, f.threadsCalls.Load(), ctxs, f.ctxCalls.Load())
	}

	if code, _ := f.post(t, "/api/pr-write/reply", map[string]any{"thread_id": "T1", "in_reply_to": 11, "mode": "single", "body": "x"}); code != 200 {
		t.Fatalf("reply: %d", code)
	}
	threads, ctxs = f.threadsCalls.Load(), f.ctxCalls.Load()
	f.summary(t)
	if f.threadsCalls.Load() != threads+1 || f.ctxCalls.Load() != ctxs+1 {
		t.Fatal("reply did not drop the caches")
	}

	// Review mode: starting the review and adding to it drops them.
	if code, _ := f.comment(t, "review", 5, 5, "x"); code != 200 {
		t.Fatalf("review comment: %d", code)
	}
	threads, ctxs = f.threadsCalls.Load(), f.ctxCalls.Load()
	f.summary(t)
	if f.threadsCalls.Load() != threads+1 || f.ctxCalls.Load() != ctxs+1 {
		t.Fatal("review comment did not drop the caches")
	}

	// A review started whose add then fails is still a write: dropped.
	f.srv.AddReviewThread = func(string, string, wgithub.NewReviewComment) (int64, error) { return 0, fmt.Errorf("boom") }
	if code, _ := f.comment(t, "review", 5, 5, "x"); code != http.StatusBadGateway {
		t.Fatalf("failed add: %d", code)
	}
	threads, ctxs = f.threadsCalls.Load(), f.ctxCalls.Load()
	f.summary(t)
	if f.threadsCalls.Load() != threads+1 || f.ctxCalls.Load() != ctxs+1 {
		t.Fatal("started review did not drop the caches")
	}

	// A failed write keeps them.
	f.srv.PostReply = func(string, wgithub.PRRef, int64, string) (int64, error) { return 0, fmt.Errorf("boom") }
	if code, _ := f.post(t, "/api/pr-write/reply", map[string]any{"thread_id": "T1", "in_reply_to": 11, "mode": "single", "body": "x"}); code != http.StatusBadGateway {
		t.Fatalf("failed reply: %d", code)
	}
	threads, ctxs = f.threadsCalls.Load(), f.ctxCalls.Load()
	f.summary(t)
	if f.threadsCalls.Load() != threads || f.ctxCalls.Load() != ctxs {
		t.Fatal("failed write dropped the caches")
	}
}

// simulateReviews makes the write seams behave like GitHub's pending
// review: starting one sets the write context's Pending, adding a thread
// appends a comment with a fresh id (unless failAdd says to fail it, by
// call number from 1), and submitting clears it.
func (f *prwFixture) simulateReviews(t *testing.T, failAdd func(n int) bool) {
	t.Helper()
	next, adds := int64(500), 0
	f.srv.StartReview = func(token, prID, commit string) (string, error) {
		f.calls = append(f.calls, fmt.Sprintf("start %s %s", prID, commit))
		f.writeCtx.Pending = &wgithub.PendingReview{ID: "R_new", CommitOid: commit}
		return "R_new", nil
	}
	f.srv.AddReviewThread = func(token, reviewID string, c wgithub.NewReviewComment) (int64, error) {
		adds++
		f.calls = append(f.calls, fmt.Sprintf("thread %s %s:%d %s", reviewID, c.Path, c.Line, c.Body))
		if failAdd != nil && failAdd(adds) {
			return 0, fmt.Errorf("add %d refused", adds)
		}
		next++
		f.writeCtx.Pending.Comments = append(f.writeCtx.Pending.Comments, wgithub.PendingComment{DatabaseID: next, Path: c.Path, Body: c.Body})
		return next, nil
	}
	f.srv.SubmitReview = func(token, reviewID, event, body string) error {
		f.calls = append(f.calls, fmt.Sprintf("submit %s %s %s", reviewID, event, body))
		f.writeCtx.Pending = nil
		return nil
	}
}

// local stores a local comment on lines start..end of "long" at the PR head.
func (f *prwFixture) local(t *testing.T, start, end int, body string) reviewcomments.Comment {
	t.Helper()
	content, err := gitutil.ShowFile(f.wt, f.head, "long")
	must(t, err)
	a, err := reviewcomments.Capture(reviewcomments.SplitLines(content), start, end)
	must(t, err)
	c, err := reviewcomments.Create(f.srv.DB, f.wt, reviewcomments.NewComment{
		File: "long", Side: reviewcomments.SideNew, Rev: f.head, Anchor: a, Body: body})
	must(t, err)
	return c
}

func (f *prwFixture) localIDs(t *testing.T) []int64 {
	t.Helper()
	cs, err := reviewcomments.List(f.srv.DB, f.wt)
	must(t, err)
	ids := []int64{}
	for _, c := range cs {
		ids = append(ids, c.ID)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

type submitResult struct {
	Error             string  `json:"error"`
	Reason            string  `json:"reason"`
	SubmittedReviewID string  `json:"submitted_review_id"`
	PostedLocalIDs    []int64 `json:"posted_local_ids"`
	KeptLocalIDs      []int64 `json:"kept_local_ids"`
}

func (f *prwFixture) submit(t *testing.T, req map[string]any) (int, submitResult) {
	t.Helper()
	if _, ok := req["head"]; !ok {
		req["head"] = f.head
	}
	if _, ok := req["event"]; !ok {
		req["event"] = "COMMENT"
	}
	code, out := f.post(t, "/api/pr-write/submit", req)
	b, _ := json.Marshal(out)
	var r submitResult
	must(t, json.Unmarshal(b, &r))
	return code, r
}

func wantIDs(t *testing.T, what string, got []int64, want ...int64) {
	t.Helper()
	if got == nil {
		got = []int64{}
	}
	if want == nil {
		want = []int64{}
	}
	sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s = %v; want %v", what, got, want)
	}
}

func TestSubmitHappyPath(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, nil)
	a := f.local(t, 5, 5, "a")
	b := f.local(t, 24, 25, "b")
	c := f.local(t, 15, 15, "unpostable")

	code, r := f.submit(t, map[string]any{"body": "lgtm", "include_local": true})
	if code != 200 || r.SubmittedReviewID != "R_new" {
		t.Fatalf("status %d: %+v", code, r)
	}
	wantIDs(t, "posted", r.PostedLocalIDs, a.ID, b.ID)
	wantIDs(t, "kept", r.KeptLocalIDs, c.ID)
	wantIDs(t, "local", f.localIDs(t), c.ID)
	f.wantCalls(t,
		"start PR_node "+f.head,
		"thread R_new long:5 a",
		"thread R_new long:25 b",
		"submit R_new COMMENT lgtm")
}

func TestSubmitExcludeLocal(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, nil)
	a := f.local(t, 5, 5, "a")
	code, r := f.submit(t, map[string]any{"body": "just a message", "include_local": false})
	if code != 200 {
		t.Fatalf("status %d: %+v", code, r)
	}
	wantIDs(t, "posted", r.PostedLocalIDs)
	wantIDs(t, "kept", r.KeptLocalIDs, a.ID)
	wantIDs(t, "local", f.localIDs(t), a.ID)
	f.wantCalls(t, "start PR_node "+f.head, "submit R_new COMMENT just a message")
}

func TestSubmitPartialAddFailure(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, func(n int) bool { return n == 2 })
	a := f.local(t, 5, 5, "a")
	b := f.local(t, 6, 6, "b")
	c := f.local(t, 25, 25, "c")

	code, r := f.submit(t, map[string]any{"body": "x", "include_local": true})
	if code != http.StatusBadGateway || r.Error != "add 2 refused" {
		t.Fatalf("status %d: %+v", code, r)
	}
	wantIDs(t, "posted", r.PostedLocalIDs, a.ID, c.ID)
	wantIDs(t, "kept", r.KeptLocalIDs, b.ID)
	wantIDs(t, "local", f.localIDs(t), b.ID)
	f.wantCalls(t,
		"start PR_node "+f.head,
		"thread R_new long:5 a",
		"thread R_new long:6 b",
		"thread R_new long:25 c")
}

func TestSubmitRetryNoDuplicate(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, func(n int) bool { return n == 1 })
	a := f.local(t, 5, 5, "a")
	b := f.local(t, 25, 25, "b")
	if code, _ := f.submit(t, map[string]any{"body": "x", "include_local": true}); code != http.StatusBadGateway {
		t.Fatalf("first: %d", code)
	}
	wantIDs(t, "local", f.localIDs(t), a.ID)

	// The retry adds only what is still local, to the review started above.
	f.calls = nil
	code, r := f.submit(t, map[string]any{"body": "x", "include_local": true})
	if code != 200 || r.SubmittedReviewID != "R_new" {
		t.Fatalf("retry: %d %+v", code, r)
	}
	wantIDs(t, "posted", r.PostedLocalIDs, a.ID)
	wantIDs(t, "local", f.localIDs(t))
	f.wantCalls(t, "thread R_new long:5 a", "submit R_new COMMENT x")
	_ = b
}

func TestSubmitEditedMidFlight(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, nil)
	a := f.local(t, 5, 5, "a")
	b := f.local(t, 25, 25, "b")
	add := f.srv.AddReviewThread
	f.srv.AddReviewThread = func(token, reviewID string, c wgithub.NewReviewComment) (int64, error) {
		id, err := add(token, reviewID, c)
		if c.Body == "a" { // edited in another tab after it was sent
			_, uerr := reviewcomments.Update(f.srv.DB, f.wt, a.ID, a.Version, "a, edited")
			must(t, uerr)
		}
		return id, err
	}
	code, r := f.submit(t, map[string]any{"body": "x", "include_local": true})
	if code != 200 {
		t.Fatalf("status %d: %+v", code, r)
	}
	wantIDs(t, "posted", r.PostedLocalIDs, b.ID)
	wantIDs(t, "kept", r.KeptLocalIDs, a.ID)
	wantIDs(t, "local", f.localIDs(t), a.ID)
}

func TestSubmitHeadMoved(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, nil)
	a := f.local(t, 5, 5, "a")
	code, r := f.submit(t, map[string]any{"head": f.base, "body": "x", "include_local": true})
	if code != http.StatusConflict || r.Reason != "PR #1 has new commits — review the list again" {
		t.Fatalf("status %d: %+v", code, r)
	}
	f.wantCalls(t)
	wantIDs(t, "local", f.localIDs(t), a.ID)
}

func TestSubmitSubmitFails(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, nil)
	a := f.local(t, 5, 5, "a")
	f.srv.SubmitReview = func(string, string, string, string) error { return fmt.Errorf("submit refused") }
	code, r := f.submit(t, map[string]any{"body": "x", "include_local": true})
	if code != http.StatusBadGateway || r.Error != "submit refused" {
		t.Fatalf("status %d: %+v", code, r)
	}
	// Pending on GitHub, so no longer local.
	wantIDs(t, "posted", r.PostedLocalIDs, a.ID)
	wantIDs(t, "local", f.localIDs(t))
}

func TestSubmitOwnPRApproveRefused(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, nil)
	f.writeCtx.ViewerDidAuthor = true
	for _, ev := range []string{"APPROVE", "REQUEST_CHANGES"} {
		if code, r := f.submit(t, map[string]any{"event": ev, "body": "x"}); code != 400 {
			t.Fatalf("%s: %d %+v", ev, code, r)
		}
	}
	f.wantCalls(t)
	// A comment is fine.
	if code, r := f.submit(t, map[string]any{"body": "x"}); code != 200 {
		t.Fatalf("comment: %d %+v", code, r)
	}
}

func TestSubmitValidation(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, nil)
	if code, _ := f.submit(t, map[string]any{"event": "MERGE", "body": "x"}); code != 400 {
		t.Fatalf("bad event: %d", code)
	}
	// An empty Comment: no body, nothing pending, nothing to add.
	f.local(t, 15, 15, "unpostable")
	if code, _ := f.submit(t, map[string]any{"body": "  ", "include_local": true}); code != 400 {
		t.Fatalf("empty comment: %d", code)
	}
	f.wantCalls(t)
	// An approval needs no body.
	if code, r := f.submit(t, map[string]any{"event": "APPROVE"}); code != 200 {
		t.Fatalf("approve: %d %+v", code, r)
	}
	// With a pending review that has comments, an empty Comment submits it.
	f.calls = nil
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: f.head,
		Pending: &wgithub.PendingReview{ID: "R1", CommitOid: f.head, Comments: []wgithub.PendingComment{{DatabaseID: 9, Path: "long"}}}})
	if code, r := f.submit(t, map[string]any{}); code != 200 {
		t.Fatalf("pending: %d %+v", code, r)
	}
	f.wantCalls(t, "submit R1 COMMENT ")
}

type reviewDialog struct {
	PR                 *prRefDTO `json:"pr"`
	ViewerIsAuthor     bool      `json:"viewer_is_author"`
	Head               string    `json:"head"`
	StalePendingCommit *string   `json:"stale_pending_commit"`
	Pending            *struct {
		Comments []struct {
			ID   int64  `json:"id"`
			File string `json:"file"`
			Line int    `json:"line"`
			Body string `json:"body"`
		} `json:"comments"`
	} `json:"pending"`
	Local []struct {
		ID        int64  `json:"id"`
		Version   int    `json:"version"`
		File      string `json:"file"`
		Side      string `json:"side"`
		StartLine int    `json:"start_line"`
		EndLine   int    `json:"end_line"`
		Body      string `json:"body"`
		Postable  bool   `json:"postable"`
		Reason    string `json:"reason"`
	} `json:"local"`
}

func (f *prwFixture) dialog(t *testing.T) reviewDialog {
	t.Helper()
	code, body := f.get(t, "/api/pr-write/review", "")
	if code != 200 {
		t.Fatalf("review status %d: %s", code, body)
	}
	var d reviewDialog
	must(t, json.Unmarshal(body, &d))
	return d
}

func TestPRWriteReviewDialog(t *testing.T) {
	f := newPRWFixture(t)
	a := f.local(t, 4, 5, "a")
	b := f.local(t, 15, 15, "b")
	f.threads = &wgithub.PRReviewThreads{HeadRefName: "pr-branch", Threads: []wgithub.ReviewThread{
		{ID: "T1", Path: "long", Line: 25, Comments: []wgithub.ThreadComment{{DatabaseID: 9, Body: "p", Pending: true}}},
	}}
	f.writeCtx.ViewerDidAuthor = true
	f.writeCtx.Pending = &wgithub.PendingReview{ID: "R1", CommitOid: f.head, Comments: []wgithub.PendingComment{{DatabaseID: 9, Path: "long", Body: "p"}}}

	d := f.dialog(t)
	if d.PR == nil || d.PR.Number != 1 || !d.ViewerIsAuthor || d.Head != f.head || d.StalePendingCommit != nil {
		t.Fatalf("dialog: %+v", d)
	}
	if d.Pending == nil || len(d.Pending.Comments) != 1 || d.Pending.Comments[0].ID != 9 ||
		d.Pending.Comments[0].File != "long" || d.Pending.Comments[0].Line != 25 || d.Pending.Comments[0].Body != "p" {
		t.Fatalf("pending: %+v", d.Pending)
	}
	if len(d.Local) != 2 {
		t.Fatalf("local: %+v", d.Local)
	}
	l0, l1 := d.Local[0], d.Local[1]
	if l0.ID != a.ID || l0.Version != 1 || l0.File != "long" || l0.Side != "new" || l0.StartLine != 4 || l0.EndLine != 5 ||
		l0.Body != "a" || !l0.Postable || l0.Reason != "" {
		t.Fatalf("local a: %+v", l0)
	}
	if l1.ID != b.ID || l1.Postable || l1.Reason != "not part of the PR's changes" {
		t.Fatalf("local b: %+v", l1)
	}

	// A pending review on an older commit: the review's head is its commit.
	commitFile(t, f.wt, "long", numbered(30, map[int]string{5: "five", 10: "ten", 25: "twenty-five"}))
	c2 := headSHA(t, f.wt)
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: c2,
		Pending: &wgithub.PendingReview{ID: "R1", CommitOid: f.head}})
	d = f.dialog(t)
	if d.Head != f.head || d.StalePendingCommit == nil || *d.StalePendingCommit != f.head[:7] {
		t.Fatalf("stale: head %s stale %v", d.Head, d.StalePendingCommit)
	}
	if d.Pending == nil || len(d.Pending.Comments) != 0 {
		t.Fatalf("stale pending: %+v", d.Pending)
	}

	// No pending review.
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: f.head})
	if d = f.dialog(t); d.Pending != nil || d.StalePendingCommit != nil {
		t.Fatalf("no pending: %+v", d)
	}
}

func TestPRWriteSubmitOffAndNoPR(t *testing.T) {
	f := newPRWFixture(t)
	f.simulateReviews(t, nil)
	f.prcFixture.head = "someone-elses-branch"
	if code, _ := f.get(t, "/api/pr-write/review", ""); code != 404 {
		t.Fatalf("review no PR: %d", code)
	}
	if code, _ := f.submit(t, map[string]any{"body": "x"}); code != 404 {
		t.Fatalf("submit no PR: %d", code)
	}
	f.wantCalls(t)
}
