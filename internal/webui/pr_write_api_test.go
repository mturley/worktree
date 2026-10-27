package webui

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/config"
)

// prwFixture is a prcFixture whose worktree has a PR: base adds a 30-line
// file "long"; head changes its lines 5 and 25 (hunks 2-8 and 22-28). Both
// revs are handed out, and every write seam is stubbed and recorded.
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

type prwCheck struct {
	Postable bool   `json:"postable"`
	Reason   string `json:"reason"`
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

func wantCheck(t *testing.T, got prwCheck, postable bool, reason string) {
	t.Helper()
	if got.Postable != postable || got.Reason != reason {
		t.Fatalf("check = %+v; want postable=%v reason=%q", got, postable, reason)
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
	wantCheck(t, f.check(t, "new", 5, 5, f.base, f.head), true, "")
	wantCheck(t, f.check(t, "old", 25, 25, f.base, f.head), true, "")
	wantCheck(t, f.check(t, "new", 15, 15, f.base, f.head), false, "not part of the PR's changes")

	// The PR moved on and changed line 5 again.
	commitFile(t, f.wt, "long", numbered(30, map[int]string{5: "FIVE", 25: "twenty-five"}))
	c2 := headSHA(t, f.wt)
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: c2})
	wantCheck(t, f.check(t, "new", 5, 5, f.base, f.head), false, "out of date")

	// A local commit the PR does not have.
	commitFile(t, f.wt, "long", numbered(30, map[int]string{5: "FIVE", 10: "ten", 25: "twenty-five"}))
	c3 := headSHA(t, f.wt)
	f.srv.revSet().add(f.wt, c3)
	wantCheck(t, f.check(t, "new", 10, 10, f.base, c3), false, "on a commit not pushed to the PR")

	// c3 pushed, but a pending review sits on c2.
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: c3,
		Pending: &wgithub.PendingReview{ID: "R1", CommitOid: c2}})
	wantCheck(t, f.check(t, "new", 10, 10, f.base, c3), false, "newer than your pending review")

	// Uncommitted lines, from a working-tree view.
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: c3})
	must(t, os.WriteFile(filepath.Join(f.wt, "long"), []byte(numbered(30, map[int]string{5: "FIVE", 10: "ten", 12: "dirty", 25: "twenty-five"})), 0o644))
	p := getPatch(t, f.ts, f.wt, "")
	wantCheck(t, f.check(t, "new", 12, 12, p.OldRev, p.NewRev), false, "on uncommitted changes")

	// The PR head is not in the local repo.
	f.setCtx(&wgithub.PRWriteContext{PullRequestID: "PR_node", BaseRefOid: f.base, HeadRefOid: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"})
	wantCheck(t, f.check(t, "new", 5, 5, f.base, f.head), false, "Fetch the PR's latest commits first")

	f.wantCalls(t)

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
	f.wantCalls(t)
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
