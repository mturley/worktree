package webui

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/prcomments"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/selfid"
)

const prcID = "o/r#1"

// prcFixture is a linked worktree on branch "pr-branch" tracking PR o/r#1,
// with a GitHub token configured and both fetch seams stubbed and counted.
type prcFixture struct {
	srv          *Server
	ts           *httptest.Server
	wt           string
	head         string // the PR's head branch, as the summaries stub reports
	threads      *wgithub.PRReviewThreads
	threadsErr   error
	writeCtx     *wgithub.PRWriteContext
	writeCtxErr  error
	sumCalls     atomic.Int32
	threadsCalls atomic.Int32
	ctxCalls     atomic.Int32
}

func newPRCFixture(t *testing.T) *prcFixture {
	t.Helper()
	repo := forkRepo(t)
	wt := filepath.Join(t.TempDir(), "lw")
	gitIn(t, repo, "worktree", "add", "-b", "pr-branch", wt)
	srv, ts := gitTestServer(t, wt, nil)
	auth := filepath.Join(t.TempDir(), "auth.yaml")
	must(t, os.WriteFile(auth, []byte("services:\n  github:\n    token: tok\n"), 0o600))
	srv.WatcherAuthPath = auth
	must(t, resources.Add(srv.DB, wt, resources.Resource{Type: "pr", ID: prcID, URL: "https://github.com/o/r/pull/1"}))
	// Add seeded the cursor at now; wind it back so 2026-02 events are new.
	_, err := srv.DB.Exec(`UPDATE resource_read_cursor SET last_read_ts = ? WHERE resource_type = 'pr' AND resource_id = ?`,
		"2026-01-01T00:00:00Z", prcID)
	must(t, err)

	f := &prcFixture{srv: srv, ts: ts, wt: wt, head: "pr-branch", threads: &wgithub.PRReviewThreads{HeadRefName: "pr-branch"}}
	srv.FetchPRSummaries = func(token string, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
		f.sumCalls.Add(1)
		if token != "tok" {
			t.Errorf("token = %q", token)
		}
		out := map[wgithub.PRRef]wgithub.PRSummary{}
		for _, r := range refs {
			out[r] = wgithub.PRSummary{HeadRefName: f.head, URL: fmt.Sprintf("https://github.com/%s/%s/pull/%d", r.Owner, r.Repo, r.Number)}
		}
		return out, nil
	}
	srv.FetchReviewThreads = func(token string, ref wgithub.PRRef) (*wgithub.PRReviewThreads, error) {
		f.threadsCalls.Add(1)
		if f.threadsErr != nil {
			return nil, f.threadsErr
		}
		return f.threads, nil
	}
	f.writeCtx = &wgithub.PRWriteContext{PullRequestID: "PR_node"}
	srv.FetchPRWriteContext = func(token string, ref wgithub.PRRef) (*wgithub.PRWriteContext, error) {
		f.ctxCalls.Add(1)
		if f.writeCtxErr != nil {
			return nil, f.writeCtxErr
		}
		return f.writeCtx, nil
	}
	return f
}

func (f *prcFixture) get(t *testing.T, route, query string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(f.ts.URL + route + "?path=" + url.QueryEscape(f.wt) + query)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

type prcSummary struct {
	State   string `json:"state"`
	Branch  string `json:"branch"`
	Message string `json:"message"`
	PR      *struct {
		ID     string `json:"id"`
		Number int    `json:"number"`
		URL    string `json:"url"`
	} `json:"pr"`
	Fingerprint     string  `json:"fingerprint"`
	OpenThreads     int     `json:"open_threads"`
	UnreadComments  int     `json:"unread_comments"`
	UnreadIDs       []int64 `json:"unread_ids"`
	PendingComments int     `json:"pending_comments"`
	ViewerIsAuthor  bool    `json:"viewer_is_author"`
}

func (f *prcFixture) summary(t *testing.T) prcSummary {
	t.Helper()
	code, body := f.get(t, "/api/pr-comments", "")
	if code != 200 {
		t.Fatalf("status %d: %s", code, body)
	}
	var s prcSummary
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func sptr(s string) *string { return &s }

func TestPRCommentsOffMakesNoCall(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	f.srv.SetWatchersDisabled(map[string]bool{config.ServiceGitHub: true})
	if s := f.summary(t); s.State != "off" {
		t.Fatalf("state = %q", s.State)
	}
	code, body := f.get(t, "/api/pr-comments/threads", "")
	if code != 200 || !json.Valid(body) {
		t.Fatalf("threads: %d %s", code, body)
	}
	var th struct{ State string }
	_ = json.Unmarshal(body, &th)
	if th.State != "off" {
		t.Fatalf("threads state = %q", th.State)
	}
	if f.sumCalls.Load() != 0 || f.threadsCalls.Load() != 0 {
		t.Fatalf("fetched while off: %d summaries, %d threads", f.sumCalls.Load(), f.threadsCalls.Load())
	}
}

func TestPRCommentsNoToken(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	f.srv.WatcherAuthPath = filepath.Join(t.TempDir(), "missing.yaml")
	if s := f.summary(t); s.State != "no_token" {
		t.Fatalf("state = %q", s.State)
	}
	if f.sumCalls.Load() != 0 || f.threadsCalls.Load() != 0 {
		t.Fatal("fetched with no token")
	}
}

func TestPRCommentsNoPR(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	f.head = "someone-else"
	s := f.summary(t)
	if s.State != "no_pr" || s.Branch != "pr-branch" {
		t.Fatalf("got %+v", s)
	}
	if f.threadsCalls.Load() != 0 {
		t.Fatal("threads fetched with no PR")
	}
}

func summaryThreads() *wgithub.PRReviewThreads {
	return &wgithub.PRReviewThreads{HeadRefName: "pr-branch", Threads: []wgithub.ReviewThread{
		{ID: "T1", Path: "a.go", DiffSide: "RIGHT", OriginalLine: 3, Comments: []wgithub.ThreadComment{
			{DatabaseID: 11, Author: "bob", CreatedAt: "2026-01-05T00:00:00Z"}}},
		{ID: "T2", Path: "b.go", DiffSide: "RIGHT", OriginalLine: 4, Comments: []wgithub.ThreadComment{
			{DatabaseID: 12, Author: "me", AuthorID: "101", CreatedAt: "2026-01-06T00:00:00Z"}}},
		{ID: "T3", Path: "c.go", DiffSide: "RIGHT", OriginalLine: 5, IsResolved: true, Comments: []wgithub.ThreadComment{
			{DatabaseID: 13, Author: "bob", CreatedAt: "2026-01-07T00:00:00Z"}}},
	}}
}

func insertPRCEvent(t *testing.T, srv *Server, e watcher.Event) {
	t.Helper()
	if e.Source == "" {
		e.Source = "github"
	}
	if e.Type == "" {
		e.Type = watcher.EventTypePRReviewComment
	}
	must(t, watcherdb.InsertEvent(srv.DB, e, watcher.Resource{Type: "pr", ID: prcID}))
}

func TestPRCommentsSummary(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	f.threads = summaryThreads()
	must(t, selfid.Set(f.srv.DB, "github", "101"))
	insertPRCEvent(t, f.srv, watcher.Event{ID: "e11", TS: "2026-02-01T00:00:00Z", Title: "x", Tags: sptr("comment:11"), AuthorID: sptr("202")})
	insertPRCEvent(t, f.srv, watcher.Event{ID: "e12", TS: "2026-02-01T00:00:00Z", Title: "y", Tags: sptr("comment:12"), AuthorID: sptr("101")})
	insertPRCEvent(t, f.srv, watcher.Event{ID: "e13", TS: "2026-02-01T00:00:00Z", Title: "z", Tags: sptr("comment:13"), AuthorID: sptr("202")})

	s := f.summary(t)
	if s.State != "ok" || s.Branch != "pr-branch" {
		t.Fatalf("got %+v", s)
	}
	if s.PR == nil || s.PR.ID != prcID || s.PR.Number != 1 || s.PR.URL != "https://github.com/o/r/pull/1" {
		t.Fatalf("pr = %+v", s.PR)
	}
	if s.OpenThreads != 2 || s.UnreadComments != 1 || len(s.UnreadIDs) != 1 || s.UnreadIDs[0] != 11 {
		t.Fatalf("counts: %+v", s)
	}
	if s.Fingerprint != prcomments.Fingerprint(f.threads) {
		t.Fatalf("fingerprint %q", s.Fingerprint)
	}
}

func TestPRCommentsUnreadIDsNeverNull(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	_, body := f.get(t, "/api/pr-comments", "")
	var raw map[string]json.RawMessage
	must(t, json.Unmarshal(body, &raw))
	if string(raw["unread_ids"]) != "[]" {
		t.Fatalf("unread_ids = %s", raw["unread_ids"])
	}
}

func TestPRCommentsCachesFetch(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	f.threads = summaryThreads()
	f.summary(t)
	f.summary(t)
	f.get(t, "/api/pr-comments/threads", "")
	if n := f.threadsCalls.Load(); n != 1 {
		t.Fatalf("threads fetched %d times", n)
	}
	if n := f.sumCalls.Load(); n != 1 {
		t.Fatalf("summaries fetched %d times", n)
	}
}

func TestPRCommentsErrorCachedBriefly(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	now := time.Now()
	f.srv.prThreadsCacheOrInit().now = func() time.Time { return now }
	f.threadsErr = errors.New("boom")
	s := f.summary(t)
	if s.State != "error" || s.Message == "" {
		t.Fatalf("got %+v", s)
	}
	f.threadsErr = nil
	f.threads = summaryThreads()
	// Within the error TTL the error is served from the cache.
	now = now.Add(prErrorTTL - time.Second)
	if s := f.summary(t); s.State != "error" {
		t.Fatalf("within error TTL: %+v", s)
	}
	if n := f.threadsCalls.Load(); n != 1 {
		t.Fatalf("threads fetched %d times within the error TTL, want 1", n)
	}
	// After it, GitHub is asked again.
	now = now.Add(2 * time.Second)
	if s := f.summary(t); s.State != "ok" || s.OpenThreads != 2 {
		t.Fatalf("after error TTL: %+v", s)
	}
	if n := f.threadsCalls.Load(); n != 2 {
		t.Fatalf("threads fetched %d times, want 2", n)
	}
}

func TestPRCommentsSummaryErrorCachedBriefly(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	now := time.Now()
	f.srv.prThreadsCacheOrInit().now = func() time.Time { return now }
	fail := true
	inner := f.srv.FetchPRSummaries
	f.srv.FetchPRSummaries = func(token string, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
		if fail {
			f.sumCalls.Add(1)
			return nil, errors.New("boom")
		}
		return inner(token, refs)
	}
	f.threads = summaryThreads()
	if s := f.summary(t); s.State != "error" {
		t.Fatalf("got %+v", s)
	}
	fail = false
	if s := f.summary(t); s.State != "error" {
		t.Fatalf("within error TTL: %+v", s)
	}
	if n := f.sumCalls.Load(); n != 1 {
		t.Fatalf("summaries fetched %d times within the error TTL", n)
	}
	now = now.Add(prErrorTTL + time.Second)
	if s := f.summary(t); s.State != "ok" {
		t.Fatalf("after error TTL: %+v", s)
	}
}

func TestPRCommentsNoFingerprintUnlessOK(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	f.threadsErr = errors.New("boom")
	for _, route := range []string{"/api/pr-comments", "/api/pr-comments/threads"} {
		_, body := f.get(t, route, "")
		var raw map[string]json.RawMessage
		must(t, json.Unmarshal(body, &raw))
		if string(raw["state"]) != `"error"` {
			t.Fatalf("%s: state %s", route, raw["state"])
		}
		if fp, ok := raw["fingerprint"]; ok {
			t.Fatalf("%s: fingerprint %s in an error state", route, fp)
		}
	}
}

func TestPRCommentsUnreadableAuthLogged(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	var buf bytes.Buffer
	f.srv.Logger = log.New(&buf, "", 0)
	must(t, os.Chmod(f.srv.WatcherAuthPath, 0o644)) // wconfig refuses group/world-readable files
	for i := 0; i < 3; i++ {
		if s := f.summary(t); s.State != "no_token" {
			t.Fatalf("state = %q", s.State)
		}
	}
	if n := strings.Count(buf.String(), "PR comments: reading auth.yaml"); n != 1 {
		t.Fatalf("logged %d times: %q", n, buf.String())
	}
}

func TestPRCommentsMissingAuthNotLogged(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	var buf bytes.Buffer
	f.srv.Logger = log.New(&buf, "", 0)
	f.srv.WatcherAuthPath = filepath.Join(t.TempDir(), "missing.yaml")
	if s := f.summary(t); s.State != "no_token" {
		t.Fatalf("state = %q", s.State)
	}
	if buf.Len() != 0 {
		t.Fatalf("logged %q", buf.String())
	}
}

type prcThreadsResp struct {
	State       string `json:"state"`
	Fingerprint string `json:"fingerprint"`
	PR          *struct {
		ID string `json:"id"`
	} `json:"pr"`
	Threads []struct {
		ID        string `json:"id"`
		Resolved  bool   `json:"resolved"`
		Outdated  bool   `json:"outdated"`
		File      string `json:"file"`
		Side      string `json:"side"`
		StartLine int    `json:"start_line"`
		EndLine   int    `json:"end_line"`
		View      *struct {
			Status    string `json:"status"`
			StartLine int    `json:"start_line"`
			EndLine   int    `json:"end_line"`
			Moved     bool   `json:"moved"`
		} `json:"view"`
		Comments []struct {
			ID        int64  `json:"id"`
			Author    string `json:"author"`
			AvatarURL string `json:"avatar_url"`
			Body      string `json:"body"`
			CreatedAt string `json:"created_at"`
			URL       string `json:"url"`
			Pending   bool   `json:"pending"`
		} `json:"comments"`
	} `json:"threads"`
}

func TestPRCommentsThreadsView(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	commitFile(t, f.wt, "multi", rcMulti)
	head := headSHA(t, f.wt)
	f.threads = &wgithub.PRReviewThreads{HeadRefName: "pr-branch", Threads: []wgithub.ReviewThread{
		// Resolved, so it sorts last despite its file name.
		{ID: "T0", Path: "a-resolved", DiffSide: "RIGHT", IsResolved: true, OriginalLine: 2,
			Comments: []wgithub.ThreadComment{{DatabaseID: 20, Author: "bob", OriginalCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}}},
		{ID: "T1", Path: "multi", DiffSide: "RIGHT", OriginalStartLine: 3, OriginalLine: 4,
			Comments: []wgithub.ThreadComment{
				{DatabaseID: 11, Author: "bob", AvatarURL: "av", Body: "hi", CreatedAt: "c", URL: "u", OriginalCommit: head},
				{DatabaseID: 12, Author: "me", Pending: true, Body: "reply", OriginalCommit: head}}},
		// Its commit is not local: unavailable, lines from GitHub's originals.
		{ID: "T2", Path: "gone", DiffSide: "LEFT", OriginalStartLine: 7, OriginalLine: 9,
			Comments: []wgithub.ThreadComment{{DatabaseID: 13, Author: "bob", OriginalCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}}},
	}}
	p := getPatch(t, f.ts, f.wt, "")

	code, body := f.get(t, "/api/pr-comments/threads", "&old_rev="+p.OldRev+"&new_rev="+p.NewRev)
	if code != 200 {
		t.Fatalf("status %d: %s", code, body)
	}
	var got prcThreadsResp
	must(t, json.Unmarshal(body, &got))
	if got.State != "ok" || got.PR == nil || got.PR.ID != prcID || got.Fingerprint != prcomments.Fingerprint(f.threads) {
		t.Fatalf("header: %+v", got)
	}
	if len(got.Threads) != 3 || got.Threads[0].ID != "T2" || got.Threads[1].ID != "T1" || got.Threads[2].ID != "T0" {
		t.Fatalf("order: %s", body)
	}
	t1 := got.Threads[1]
	if t1.View == nil || t1.View.Status != "shown" || t1.View.StartLine != 3 || t1.View.EndLine != 4 {
		t.Fatalf("T1 view: %s", body)
	}
	if t1.File != "multi" || t1.Side != "new" || t1.StartLine != 3 || t1.EndLine != 4 || len(t1.Comments) != 2 {
		t.Fatalf("T1: %+v", t1)
	}
	c := t1.Comments[0]
	if c.ID != 11 || c.Author != "bob" || c.AvatarURL != "av" || c.Body != "hi" || c.CreatedAt != "c" || c.URL != "u" || c.Pending {
		t.Fatalf("comment: %+v", c)
	}
	if !t1.Comments[1].Pending {
		t.Fatal("pending reply not marked")
	}
	t2 := got.Threads[0]
	if t2.View == nil || t2.View.Status != "unavailable" || t2.Side != "old" || t2.StartLine != 7 || t2.EndLine != 9 {
		t.Fatalf("T2: %+v", t2)
	}
	if !got.Threads[2].Resolved {
		t.Fatal("T0 should be resolved")
	}

	// Without revs placeable threads carry no view.
	code, body = f.get(t, "/api/pr-comments/threads", "")
	var noView prcThreadsResp
	must(t, json.Unmarshal(body, &noView))
	if code != 200 || noView.Threads[1].View != nil || noView.Threads[1].StartLine != 3 {
		t.Fatalf("no-view: %d %s", code, body)
	}

	if code, _ := f.get(t, "/api/pr-comments/threads", "&old_rev=abc&new_rev="+p.NewRev); code != 404 {
		t.Fatalf("unknown rev: %d", code)
	}
	if code, _ := f.get(t, "/api/pr-comments/threads", "&old_rev="+p.OldRev); code != 400 {
		t.Fatalf("one rev: %d", code)
	}
}

func TestPRCommentsUnregisteredPath(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	resp, err := http.Get(f.ts.URL + "/api/pr-comments?path=/nope")
	must(t, err)
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestPRCommentsLocate(t *testing.T) {
	t.Parallel()
	f := newPRCFixture(t)
	f.threads = summaryThreads()
	// Polled before the comment tag existed: matches on title + created time.
	insertPRCEvent(t, f.srv, watcher.Event{ID: "e1", TS: "2026-02-01T00:00:00Z",
		Title: "Review comment by bob on a.go", ExternalTS: sptr("2026-01-05T00:00:00Z")})
	insertPRCEvent(t, f.srv, watcher.Event{ID: "e2", TS: "2026-02-01T00:00:00Z", Type: watcher.EventTypePRComment,
		Title: "Review comment by bob on a.go", ExternalTS: sptr("2026-01-05T00:00:00Z")})
	insertPRCEvent(t, f.srv, watcher.Event{ID: "e3", TS: "2026-02-01T00:00:00Z", Tags: sptr("comment:999"), Title: "t"})

	locate := func(q string) (int, map[string]any) {
		resp, err := http.Get(f.ts.URL + "/api/pr-comments/locate?" + q)
		must(t, err)
		defer resp.Body.Close()
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return resp.StatusCode, m
	}
	code, m := locate("event_id=e1&prefer_path=" + url.QueryEscape("/elsewhere"))
	if code != 200 || m["path"] != f.wt || m["comment_id"] != float64(11) {
		t.Fatalf("locate: %d %+v", code, m)
	}
	if code, _ := locate("event_id=e2"); code != 404 {
		t.Fatalf("other type: %d", code)
	}
	if code, _ := locate("event_id=e3"); code != 404 {
		t.Fatalf("unmatched comment: %d", code)
	}
	if code, _ := locate("event_id=nope"); code != 404 {
		t.Fatalf("missing event: %d", code)
	}
	f.threads = &wgithub.PRReviewThreads{HeadRefName: "elsewhere", Threads: summaryThreads().Threads}
	f.srv.prThreadsCacheOrInit().entries = map[string]ttlEntry{}
	if code, _ := locate("event_id=e1"); code != 404 {
		t.Fatalf("no worktree on the PR's branch: %d", code)
	}
	f.srv.SetWatchersDisabled(map[string]bool{config.ServiceGitHub: true})
	before := f.threadsCalls.Load()
	if code, _ := locate("event_id=e1"); code != 404 || f.threadsCalls.Load() != before {
		t.Fatalf("off: %d, calls %d→%d", code, before, f.threadsCalls.Load())
	}
}

const reviewPRID = "o/r#7"

// asReviewWorktree turns the fixture's worktree into one made from PR o/r#7:
// on branch review/pr-7-x tracking refs/pull/7/head, with a remote whose URL
// ends o/r, and tracking that PR. The PR's head branch (the author's) is
// "author-branch", which matches no local branch.
func (f *prcFixture) asReviewWorktree(t *testing.T) {
	t.Helper()
	gitIn(t, f.wt, "checkout", "-q", "-b", "review/pr-7-x")
	gitIn(t, f.wt, "remote", "add", "gh", "https://github.com/o/r.git")
	gitIn(t, f.wt, "config", "branch.review/pr-7-x.remote", "gh")
	gitIn(t, f.wt, "config", "branch.review/pr-7-x.merge", "refs/pull/7/head")
	must(t, resources.Add(f.srv.DB, f.wt, resources.Resource{Type: "pr", ID: reviewPRID, URL: "https://github.com/o/r/pull/7"}))
	f.head = "author-branch"
}

func TestPRCommentsReviewWorktree(t *testing.T) {
	f := newPRCFixture(t)
	f.asReviewWorktree(t)
	th := summaryThreads()
	th.HeadRefName = "author-branch"
	th.Threads[0].Comments = append(th.Threads[0].Comments, wgithub.ThreadComment{DatabaseID: 21, Author: "me", Pending: true})
	th.Threads = append(th.Threads, wgithub.ReviewThread{ID: "T4", Path: "d.go", Comments: []wgithub.ThreadComment{
		{DatabaseID: 22, Author: "me", Pending: true}}})
	f.threads = th

	s := f.summary(t)
	if s.State != "ok" || s.PR == nil || s.PR.Number != 7 || s.PR.ID != reviewPRID {
		t.Fatalf("got %+v pr=%+v", s, s.PR)
	}
	if s.PendingComments != 2 {
		t.Fatalf("pending_comments = %d, want 2", s.PendingComments)
	}
}

func TestPRCommentsPendingZeroAndViewerIsAuthor(t *testing.T) {
	f := newPRCFixture(t)
	f.threads = summaryThreads()
	_, body := f.get(t, "/api/pr-comments", "")
	var raw map[string]json.RawMessage
	must(t, json.Unmarshal(body, &raw))
	if string(raw["pending_comments"]) != "0" || string(raw["viewer_is_author"]) != "false" {
		t.Fatalf("pending_comments=%s viewer_is_author=%s", raw["pending_comments"], raw["viewer_is_author"])
	}

	f.writeCtx = &wgithub.PRWriteContext{ViewerDidAuthor: true}
	f.srv.prThreadsCacheOrInit().entries = map[string]ttlEntry{}
	if s := f.summary(t); !s.ViewerIsAuthor {
		t.Fatalf("viewer_is_author false: %+v", s)
	}
	code, body := f.get(t, "/api/pr-comments/threads", "")
	var tr struct {
		State          string `json:"state"`
		ViewerIsAuthor bool   `json:"viewer_is_author"`
	}
	must(t, json.Unmarshal(body, &tr))
	if code != 200 || tr.State != "ok" || !tr.ViewerIsAuthor {
		t.Fatalf("threads: %d %s", code, body)
	}
	// Cached: the summary and threads calls above cost one fetch.
	if n := f.ctxCalls.Load(); n != 2 {
		t.Fatalf("write context fetched %d times, want 2 (one per cache clear)", n)
	}
}

func TestPRCommentsWriteContextErrorIsNotAuthor(t *testing.T) {
	f := newPRCFixture(t)
	f.threads = summaryThreads()
	f.writeCtx = &wgithub.PRWriteContext{ViewerDidAuthor: true}
	f.writeCtxErr = errors.New("boom")
	s := f.summary(t)
	if s.State != "ok" || s.ViewerIsAuthor {
		t.Fatalf("got %+v", s)
	}
	f.summary(t)
	if n := f.ctxCalls.Load(); n != 1 {
		t.Fatalf("failed write context fetched %d times, want 1 (error cached)", n)
	}
}

func TestPRCommentsLocateReviewWorktree(t *testing.T) {
	f := newPRCFixture(t)
	f.asReviewWorktree(t)
	th := summaryThreads()
	th.HeadRefName = "author-branch"
	f.threads = th
	must(t, watcherdb.InsertEvent(f.srv.DB, watcher.Event{ID: "e7", Source: "github", Type: watcher.EventTypePRReviewComment,
		TS: "2026-02-01T00:00:00Z", Title: "t", Tags: sptr("comment:11")}, watcher.Resource{Type: "pr", ID: reviewPRID}))

	locate := func() (int, map[string]any) {
		resp, err := http.Get(f.ts.URL + "/api/pr-comments/locate?event_id=e7")
		must(t, err)
		defer resp.Body.Close()
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return resp.StatusCode, m
	}
	if code, m := locate(); code != 200 || m["path"] != f.wt || m["comment_id"] != float64(11) {
		t.Fatalf("locate by tracked PR number: %d %+v", code, m)
	}
	// The same number on another repo's PR is not this worktree's.
	gitIn(t, f.wt, "remote", "set-url", "gh", "https://github.com/x/y.git")
	if code, _ := locate(); code != 404 {
		t.Fatalf("number match on a repo that is not a remote: %d", code)
	}
}
