package webui

import (
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/reviewcomments"
)

// Writing to a worktree's PR from the diff view: checking whether lines can
// be commented on, commenting, and replying. Every GitHub call goes through
// the watcher library, gated on the GitHub watcher. See the spec
// docs/superpowers/specs/2026-10-27-submit-review-design.md.

// reasonMissingCommit: the PR's commits are not local even after a fetch.
const reasonMissingCommit = "Fetch the PR's latest commits first"

// The write modes: add to the viewer's pending review (starting one when
// there is none), or post now.
const (
	prModeReview = "review"
	prModeSingle = "single"
)

func (s *Server) startReview(token, pullRequestID, commitOid string) (string, error) {
	if s.StartReview != nil {
		return s.StartReview(token, pullRequestID, commitOid)
	}
	return wgithub.StartReview(token, pullRequestID, commitOid)
}

func (s *Server) addReviewThread(token, reviewID string, c wgithub.NewReviewComment) (int64, error) {
	if s.AddReviewThread != nil {
		return s.AddReviewThread(token, reviewID, c)
	}
	return wgithub.AddReviewThread(token, reviewID, c)
}

func (s *Server) addReviewReply(token, reviewID, threadID, body string) (int64, error) {
	if s.AddReviewReply != nil {
		return s.AddReviewReply(token, reviewID, threadID, body)
	}
	return wgithub.AddReviewReply(token, reviewID, threadID, body)
}

func (s *Server) postComment(token string, ref wgithub.PRRef, commitOid string, c wgithub.NewReviewComment) (int64, error) {
	if s.PostComment != nil {
		return s.PostComment(token, ref, commitOid, c)
	}
	return wgithub.PostComment(token, ref, commitOid, c)
}

func (s *Server) postReply(token string, ref wgithub.PRRef, inReplyTo int64, body string) (int64, error) {
	if s.PostReply != nil {
		return s.PostReply(token, ref, inReplyTo, body)
	}
	return wgithub.PostReply(token, ref, inReplyTo, body)
}

// invalidatePR drops the PR's cached threads and write context, so the next
// read shows a write's result.
func (s *Server) invalidatePR(id string) {
	s.prThreadsCacheOrInit().del("prthreads|"+id, "prctx|"+id)
}

// prForWrite is dir's PR, writing the response itself when there is none
// to write to: 409 {state:"off"} with the GitHub watcher off (nothing
// contacts GitHub), 409 {state:"no_token"} without a token, 404 with no PR,
// 502 when finding it failed.
func (s *Server) prForWrite(w http.ResponseWriter, dir string) (prComments, bool) {
	if !s.WatcherEnabled(config.ServiceGitHub) {
		writeJSON(w, http.StatusConflict, map[string]string{"state": prStateOff, "error": "the GitHub watcher is off"})
		return prComments{}, false
	}
	pc := s.loadPRComments(dir)
	switch {
	// Checked before pr: the no-token state still names the PR it can't reach.
	case pc.state == prStateNoToken:
		writeJSON(w, http.StatusConflict, map[string]string{"state": prStateNoToken, "error": "no GitHub token is configured"})
	case pc.pr != nil:
		return pc, true
	case pc.state == prStateNoPR:
		writeError(w, http.StatusNotFound, "the worktree has no PR")
	default:
		writeError(w, http.StatusBadGateway, pc.message)
	}
	return prComments{}, false
}

// prLinesRequest is the lines of a diff view a new PR comment is on.
type prLinesRequest struct {
	File      string `json:"file"`
	Side      string `json:"side"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	OldRev    string `json:"old_rev"`
	NewRev    string `json:"new_rev"`
}

// capturePRLines captures req's lines as an unsaved comment, as creating a
// local comment does: from the file at the side's rev, which must be one
// /patch handed out. It writes the error response itself on failure.
func (s *Server) capturePRLines(w http.ResponseWriter, dir string, req prLinesRequest) (reviewcomments.Comment, bool) {
	side := reviewcomments.Side(req.Side)
	if side != reviewcomments.SideOld && side != reviewcomments.SideNew {
		writeError(w, http.StatusBadRequest, "side must be old or new")
		return reviewcomments.Comment{}, false
	}
	if req.File == "" || !filepath.IsLocal(req.File) {
		writeError(w, http.StatusBadRequest, "invalid file")
		return reviewcomments.Comment{}, false
	}
	rev := req.NewRev
	if side == reviewcomments.SideOld {
		rev = req.OldRev
	}
	if rev == "" || !s.revSet().has(dir, rev) {
		writeError(w, http.StatusNotFound, "unknown rev")
		return reviewcomments.Comment{}, false
	}
	content, err := gitutil.ShowFile(dir, rev, req.File)
	if err != nil {
		writeError(w, http.StatusBadRequest, "file not found at that rev")
		return reviewcomments.Comment{}, false
	}
	anchor, err := reviewcomments.Capture(reviewcomments.SplitLines(content), req.StartLine, req.EndLine)
	if err != nil {
		if errors.Is(err, reviewcomments.ErrOutOfRange) {
			writeError(w, http.StatusBadRequest, "line range is outside the file")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return reviewcomments.Comment{}, false
	}
	return reviewcomments.Comment{File: req.File, Side: side, Rev: storedRev(dir, rev, req.File), Anchor: anchor}, true
}

// placeOnPR loads pc's target (the PR head when headOnly, else the pending
// review's commit when there is one) and places c on it. A missing commit
// is an unpostable placement with reasonMissingCommit, not an error.
func (s *Server) placeOnPR(dir string, pc prComments, c reviewcomments.Comment, headOnly bool) (*prTarget, prPlacement, error) {
	t, err := s.loadPRTarget(dir, pc, headOnly)
	if errors.Is(err, errMissingCommit) {
		return nil, prPlacement{reason: reasonMissingCommit}, nil
	}
	if err != nil {
		return nil, prPlacement{}, err
	}
	r := s.reviewResolver()
	p := placeForPR(dir, t, c,
		func(rev, file string) []string { return r.linesAt(dir, rev, file) },
		func(a, b string) bool { return gitutil.IsAncestor(dir, a, b) })
	return t, p, nil
}

// pendingReviewID is the viewer's pending review on the PR, started on
// commit when there is none. Starting one is a write, so it drops the PR's
// caches.
func (s *Server) pendingReviewID(pc prComments, ctx *wgithub.PRWriteContext, commit string) (string, error) {
	if ctx.Pending != nil && ctx.Pending.ID != "" {
		return ctx.Pending.ID, nil
	}
	id, err := s.startReview(pc.token, ctx.PullRequestID, commit)
	if err == nil {
		s.invalidatePR(pc.pr.ID)
	}
	return id, err
}

type prVerdict struct {
	Postable bool   `json:"postable"`
	Reason   string `json:"reason,omitempty"`
}

// prCheckResponse: whether the lines can go into the pending review
// (placed on its commit) and as a single comment (placed on the PR head).
// They differ when a pending review is on an older commit.
type prCheckResponse struct {
	Review prReviewVerdict `json:"review"`
	Single prVerdict       `json:"single"`
}

// prReviewVerdict adds, for the review mode, the pending review's commit
// (short) while it is older than the PR head, else null: why newer lines
// can't join it.
type prReviewVerdict struct {
	prVerdict
	StalePendingCommit *string `json:"stale_pending_commit"`
}

// handlePRWriteCheck: GET /api/pr-write/check?path=&file=&side=&start_line=&end_line=&old_rev=&new_rev=
//
// Whether a new comment on these lines of the view can be posted to the PR,
// per mode, and if not why.
func (s *Server) handlePRWriteCheck(w http.ResponseWriter, r *http.Request) {
	dir, ok := s.registeredWorktreePath(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	start, err1 := strconv.Atoi(q.Get("start_line"))
	end, err2 := strconv.Atoi(q.Get("end_line"))
	if err1 != nil || err2 != nil {
		writeError(w, http.StatusBadRequest, "start_line and end_line must be numbers")
		return
	}
	c, ok := s.capturePRLines(w, dir, prLinesRequest{
		File: q.Get("file"), Side: q.Get("side"), StartLine: start, EndLine: end,
		OldRev: q.Get("old_rev"), NewRev: q.Get("new_rev"),
	})
	if !ok {
		return
	}
	pc, ok := s.prForWrite(w, dir)
	if !ok {
		return
	}
	var out prCheckResponse
	for _, m := range []struct {
		v        *prVerdict
		headOnly bool
	}{{&out.Review.prVerdict, false}, {&out.Single, true}} {
		t, p, err := s.placeOnPR(dir, pc, c, m.headOnly)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		*m.v = prVerdict{Postable: p.ok, Reason: p.reason}
		if !m.headOnly && t != nil && t.stale && t.pendingCommit != "" {
			short := shortSHA(t.pendingCommit)
			out.Review.StalePendingCommit = &short
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type prCommentRequest struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	Body string `json:"body"`
	prLinesRequest
}

// handlePRWriteComment: POST /api/pr-write/comment
//
// Comments on the view's lines on the PR: added to the pending review
// (started when there is none) at its commit in "review" mode, posted now
// at the PR head in "single" mode. Lines GitHub would refuse are a 409
// with the reason, and nothing is written.
func (s *Server) handlePRWriteComment(w http.ResponseWriter, r *http.Request) {
	var req prCommentRequest
	if !decodeReviewBody(w, r, &req) {
		return
	}
	dir, ok := s.registeredBodyPath(w, req.Path)
	if !ok {
		return
	}
	if req.Mode != prModeReview && req.Mode != prModeSingle {
		writeError(w, http.StatusBadRequest, "mode must be review or single")
		return
	}
	if !checkReviewCommentBody(w, req.Body) {
		return
	}
	c, ok := s.capturePRLines(w, dir, req.prLinesRequest)
	if !ok {
		return
	}
	c.Body = req.Body
	pc, ok := s.prForWrite(w, dir)
	if !ok {
		return
	}
	// A single comment goes on the PR head; one added to a pending review
	// goes on the review's commit.
	t, p, err := s.placeOnPR(dir, pc, c, req.Mode == prModeSingle)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if !p.ok {
		writeJSON(w, http.StatusConflict, map[string]string{"reason": p.reason, "error": p.reason})
		return
	}
	var id int64
	if req.Mode == prModeReview {
		var reviewID string
		reviewID, err = s.pendingReviewID(pc, t.ctx, t.commit)
		if err == nil {
			id, err = s.addReviewThread(pc.token, reviewID, p.comment)
		}
	} else {
		id, err = s.postComment(pc.token, pc.ref, t.commit, p.comment)
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	s.invalidatePR(pc.pr.ID)
	writeJSON(w, http.StatusOK, map[string]int64{"comment_id": id})
}

type prReplyRequest struct {
	Path      string `json:"path"`
	ThreadID  string `json:"thread_id"`
	InReplyTo int64  `json:"in_reply_to"`
	Mode      string `json:"mode"`
	Body      string `json:"body"`
}

// handlePRWriteReply: POST /api/pr-write/reply
//
// Replies to a PR thread: added to the pending review (started on the PR
// head when there is none) in "review" mode, which needs thread_id; posted
// now in "single" mode, which needs in_reply_to.
func (s *Server) handlePRWriteReply(w http.ResponseWriter, r *http.Request) {
	var req prReplyRequest
	if !decodeReviewBody(w, r, &req) {
		return
	}
	dir, ok := s.registeredBodyPath(w, req.Path)
	if !ok {
		return
	}
	switch {
	case req.Mode != prModeReview && req.Mode != prModeSingle:
		writeError(w, http.StatusBadRequest, "mode must be review or single")
		return
	case req.Mode == prModeReview && req.ThreadID == "":
		writeError(w, http.StatusBadRequest, "missing thread_id")
		return
	case req.Mode == prModeSingle && req.InReplyTo <= 0:
		writeError(w, http.StatusBadRequest, "missing in_reply_to")
		return
	}
	if !checkReviewCommentBody(w, req.Body) {
		return
	}
	pc, ok := s.prForWrite(w, dir)
	if !ok {
		return
	}
	var id int64
	var err error
	if req.Mode == prModeReview {
		var ctx *wgithub.PRWriteContext
		ctx, err = s.cachedPRWriteContext(pc.token, pc.pr.ID, pc.ref)
		if err == nil {
			var reviewID string
			reviewID, err = s.pendingReviewID(pc, ctx, ctx.HeadRefOid)
			if err == nil {
				id, err = s.addReviewReply(pc.token, reviewID, req.ThreadID, req.Body)
			}
		}
	} else {
		id, err = s.postReply(pc.token, pc.ref, req.InReplyTo, req.Body)
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	s.invalidatePR(pc.pr.ID)
	writeJSON(w, http.StatusOK, map[string]int64{"comment_id": id})
}

// The review events GitHub accepts on submit.
const (
	reviewEventComment        = "COMMENT"
	reviewEventApprove        = "APPROVE"
	reviewEventRequestChanges = "REQUEST_CHANGES"
)

func (s *Server) submitReview(token, reviewID, event, body string) error {
	if s.SubmitReview != nil {
		return s.SubmitReview(token, reviewID, event, body)
	}
	return wgithub.SubmitReview(token, reviewID, event, body)
}

// reviewTarget is the commit a review's comments go on, the pending
// review's when there is one, else the PR head (as newPRTarget picks it),
// and the pending review's commit when that is older than the head.
func reviewTarget(ctx *wgithub.PRWriteContext) (commit, stalePending string) {
	if p := ctx.Pending; p != nil && p.CommitOid != "" {
		if p.CommitOid != ctx.HeadRefOid {
			stalePending = p.CommitOid
		}
		return p.CommitOid, stalePending
	}
	return ctx.HeadRefOid, ""
}

// headMovedReason: the submit was computed against a commit that is no
// longer the review's target.
func headMovedReason(number int) string {
	return fmt.Sprintf("PR #%d has new commits — review the list again", number)
}

func shortSHA(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

// placedLocal is a local comment and whether it can go in the review.
type placedLocal struct {
	c reviewcomments.Comment
	p prPlacement
}

// placeLocals reads pc's write context and places every local comment on
// the review's target (the pending review's commit, else the PR head).
// Missing commits make every comment unpostable with reasonMissingCommit,
// and blocked true.
func (s *Server) placeLocals(dir string, pc prComments) (ctx *wgithub.PRWriteContext, placed []placedLocal, blocked bool, err error) {
	locals, err := reviewcomments.List(s.DB, dir)
	if err != nil {
		return nil, nil, false, err
	}
	ctx, err = s.cachedPRWriteContext(pc.token, pc.pr.ID, pc.ref)
	if err != nil || len(locals) == 0 {
		return ctx, nil, false, err
	}
	t, err := s.loadPRTarget(dir, pc, false)
	missing := errors.Is(err, errMissingCommit)
	if err != nil && !missing {
		return nil, nil, false, err
	}
	if t != nil {
		ctx = t.ctx
	}
	r := s.reviewResolver()
	out := make([]placedLocal, len(locals))
	for i, c := range locals {
		out[i].c = c
		if missing {
			out[i].p = prPlacement{reason: reasonMissingCommit}
			continue
		}
		out[i].p = placeForPR(dir, t, c,
			func(rev, file string) []string { return r.linesAt(dir, rev, file) },
			func(a, b string) bool { return gitutil.IsAncestor(dir, a, b) })
	}
	return ctx, out, missing, nil
}

type prPendingCommentDTO struct {
	ID   int64  `json:"id"`
	File string `json:"file"`
	Line int    `json:"line"` // 0 when the thread is not in the PR's threads
	Body string `json:"body"`
}

type prPendingDTO struct {
	Comments []prPendingCommentDTO `json:"comments"`
}

// prLocalDTO is a local comment as the submit dialog lists it: where it
// would be posted when postable, else where it was written.
type prLocalDTO struct {
	ID        int64  `json:"id"`
	Version   int    `json:"version"`
	File      string `json:"file"`
	Side      string `json:"side"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Body      string `json:"body"`
	Postable  bool   `json:"postable"`
	Reason    string `json:"reason"`
}

type prReviewDialogResponse struct {
	PR                 *prRefDTO     `json:"pr"`
	ViewerIsAuthor     bool          `json:"viewer_is_author"`
	Head               string        `json:"head"`
	StalePendingCommit *string       `json:"stale_pending_commit"`
	Pending            *prPendingDTO `json:"pending"`
	Local              []prLocalDTO  `json:"local"`
	// BlockedReason is reasonMissingCommit when the PR's commits are not
	// local, so local comments cannot be placed; null otherwise.
	BlockedReason *string `json:"blocked_reason"`
}

// pendingLine is a pending comment's line, from the PR's threads: its
// thread's line, else its original line; 0 when not found.
func pendingLine(threads *wgithub.PRReviewThreads, id int64) int {
	if threads == nil {
		return 0
	}
	for _, th := range threads.Threads {
		for _, c := range th.Comments {
			if c.DatabaseID == id {
				if th.Line > 0 {
					return th.Line
				}
				return th.OriginalLine
			}
		}
	}
	return 0
}

// handlePRWriteReview: GET /api/pr-write/review?path=
//
// The submit dialog's data: the PR, whether the viewer opened it, the
// commit the review is on ("head", which submit sends back), the viewer's
// pending review, and every local comment with whether it can be added.
// The write context is read fresh, so the dialog never shows a head
// submit would then refuse.
func (s *Server) handlePRWriteReview(w http.ResponseWriter, r *http.Request) {
	dir, ok := s.registeredWorktreePath(w, r)
	if !ok {
		return
	}
	pc, ok := s.prForWrite(w, dir)
	if !ok {
		return
	}
	s.prThreadsCacheOrInit().del("prctx|" + pc.pr.ID)
	ctx, locals, blocked, err := s.placeLocals(dir, pc)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	head, stale := reviewTarget(ctx)
	out := prReviewDialogResponse{PR: pc.pr, ViewerIsAuthor: ctx.ViewerDidAuthor, Head: head, Local: []prLocalDTO{}}
	if blocked {
		reason := reasonMissingCommit
		out.BlockedReason = &reason
	}
	if stale != "" {
		short := shortSHA(stale)
		out.StalePendingCommit = &short
	}
	if ctx.Pending != nil {
		out.Pending = &prPendingDTO{Comments: []prPendingCommentDTO{}}
		for _, c := range ctx.Pending.Comments {
			out.Pending.Comments = append(out.Pending.Comments, prPendingCommentDTO{
				ID: c.DatabaseID, File: c.Path, Line: pendingLine(pc.threads, c.DatabaseID), Body: c.Body})
		}
	}
	for _, l := range locals {
		d := prLocalDTO{ID: l.c.ID, Version: l.c.Version, File: l.c.File, Side: string(l.c.Side),
			StartLine: l.c.Anchor.Start, EndLine: l.c.Anchor.End, Body: l.c.Body, Postable: l.p.ok, Reason: l.p.reason}
		if l.p.ok {
			d.File, d.EndLine, d.StartLine = l.p.comment.Path, l.p.comment.Line, l.p.comment.Line
			if l.p.comment.StartLine > 0 {
				d.StartLine = l.p.comment.StartLine
			}
		}
		out.Local = append(out.Local, d)
	}
	writeJSON(w, http.StatusOK, out)
}

type prSubmitRequest struct {
	Path         string `json:"path"`
	Head         string `json:"head"`
	Event        string `json:"event"`
	Body         string `json:"body"`
	IncludeLocal bool   `json:"include_local"`
}

type prSubmitResponse struct {
	SubmittedReviewID string  `json:"submitted_review_id,omitempty"`
	PostedLocalIDs    []int64 `json:"posted_local_ids"`
	KeptLocalIDs      []int64 `json:"kept_local_ids"`
	Error             string  `json:"error,omitempty"`
}

// submitLock serialises submits per worktree, so a double click or a
// second tab cannot add the same local comments twice.
func (s *Server) submitLock(dir string) *sync.Mutex {
	v, _ := s.prSubmitLocks.LoadOrStore(dir, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// presentOnGitHub reads, fresh, the ids of the PR's comments GitHub has:
// the viewer's pending review's, and every comment in the PR's threads
// (which include those of submitted reviews).
func (s *Server) presentOnGitHub(pc prComments) (map[int64]bool, error) {
	s.invalidatePR(pc.pr.ID)
	ctx, err := s.cachedPRWriteContext(pc.token, pc.pr.ID, pc.ref)
	if err != nil {
		return nil, err
	}
	threads, err := s.cachedReviewThreads(pc.token, pc.pr.ID, pc.ref)
	if err != nil {
		return nil, err
	}
	ids := map[int64]bool{}
	if ctx.Pending != nil {
		for _, c := range ctx.Pending.Comments {
			ids[c.DatabaseID] = true
		}
	}
	for _, th := range threads.Threads {
		for _, c := range th.Comments {
			ids[c.DatabaseID] = true
		}
	}
	return ids, nil
}

// handlePRWriteSubmit: POST /api/pr-write/submit {path, head, event, body, include_local}
//
// Submits the viewer's pending review (started when there is none), first
// adding the postable local comments when include_local. head is the
// dialog's target commit: a different one now is a 409, with no writes, as
// are missing commits while local comments are included.
//
// A local comment is never posted twice. The GitHub id each add returns is
// stored on the row at once. Every submit first reconciles rows that carry
// an id: one GitHub has (pending, or in a thread) is deleted if unedited
// since it was sent; one GitHub no longer has (its pending review was
// discarded), or one edited since, loses its id and is local again. After
// adding, the comments are read back (retried once): the ones GitHub has
// are reconciled the same way, and one it does not show yet keeps its id
// and withholds the submit with a 502, as does any failed add, so a retry
// adds only what is still local. See the spec's "Submitting, and
// reconciling local comments".
func (s *Server) handlePRWriteSubmit(w http.ResponseWriter, r *http.Request) {
	var req prSubmitRequest
	if !decodeReviewBody(w, r, &req) {
		return
	}
	dir, ok := s.registeredBodyPath(w, req.Path)
	if !ok {
		return
	}
	switch req.Event {
	case reviewEventComment, reviewEventApprove, reviewEventRequestChanges:
	default:
		writeError(w, http.StatusBadRequest, "event must be COMMENT, APPROVE or REQUEST_CHANGES")
		return
	}
	if len(req.Body) > maxReviewCommentBody {
		writeError(w, http.StatusRequestEntityTooLarge, "review message is too long")
		return
	}
	lock := s.submitLock(dir)
	lock.Lock()
	defer lock.Unlock()
	pc, ok := s.prForWrite(w, dir)
	if !ok {
		return
	}

	// 1. The write context, fresh, and the head the dialog was computed on.
	s.invalidatePR(pc.pr.ID)
	var ctx *wgithub.PRWriteContext
	var placed []placedLocal
	var blocked bool
	var err error
	if req.IncludeLocal {
		ctx, placed, blocked, err = s.placeLocals(dir, pc)
	} else {
		ctx, err = s.cachedPRWriteContext(pc.token, pc.pr.ID, pc.ref)
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	commit, _ := reviewTarget(ctx)
	if commit != req.Head {
		reason := headMovedReason(pc.pr.Number)
		writeJSON(w, http.StatusConflict, map[string]string{"reason": reason, "error": reason})
		return
	}
	if blocked {
		writeJSON(w, http.StatusConflict, map[string]string{"reason": reasonMissingCommit, "error": reasonMissingCommit})
		return
	}
	if ctx.ViewerDidAuthor && req.Event != reviewEventComment {
		writeError(w, http.StatusBadRequest, "you can't approve or request changes on your own PR")
		return
	}

	out := prSubmitResponse{PostedLocalIDs: []int64{}, KeptLocalIDs: []int64{}}

	// 2. Reconcile the rows sent by an earlier request.
	rows, err := reviewcomments.List(s.DB, dir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	gone, resent := map[int64]bool{}, map[int64]bool{}
	var earlier []reviewcomments.Comment
	for _, c := range rows {
		if c.GitHubCommentID != 0 {
			earlier = append(earlier, c)
		}
	}
	if len(earlier) > 0 {
		present, err := s.presentOnGitHub(pc)
		if err != nil {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("reading the PR's comments: %v", err))
			return
		}
		for _, c := range earlier {
			deleted := false
			if present[c.GitHubCommentID] {
				if deleted, err = reviewcomments.DeleteIfVersion(s.DB, dir, c.ID, c.GitHubSentVersion); err != nil {
					writeError(w, http.StatusInternalServerError, err.Error())
					return
				}
			}
			if deleted {
				gone[c.ID] = true
				out.PostedLocalIDs = append(out.PostedLocalIDs, c.ID)
				continue
			}
			// Discarded on GitHub, or edited since it was sent: local again.
			if err := reviewcomments.ClearGitHubCommentID(s.DB, dir, c.ID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			resent[c.ID] = true
		}
	}

	var postable []placedLocal
	for _, l := range placed {
		if l.p.ok && !gone[l.c.ID] && (l.c.GitHubCommentID == 0 || resent[l.c.ID]) {
			postable = append(postable, l)
		}
	}
	hasPending := ctx.Pending != nil && len(ctx.Pending.Comments) > 0
	if req.Event == reviewEventComment && strings.TrimSpace(req.Body) == "" && !hasPending && len(postable) == 0 {
		writeError(w, http.StatusBadRequest, "a comment review needs a message or comments")
		return
	}

	// 3. Add the postable local comments, past individual failures,
	// recording each one's GitHub id on its row as soon as it is known.
	type sentLocal struct {
		local, comment int64
		version        int
	}
	var sent []sentLocal
	var firstErr error
	fail := func(err error) {
		if firstErr == nil {
			firstErr = err
		}
	}
	reviewID := ""
	if ctx.Pending != nil {
		reviewID = ctx.Pending.ID
	}
	for _, l := range postable {
		if reviewID == "" {
			if reviewID, err = s.pendingReviewID(pc, ctx, commit); err != nil {
				fail(err)
				break
			}
		}
		id, err := s.addReviewThread(pc.token, reviewID, l.p.comment)
		if err != nil {
			fail(err)
			continue
		}
		if err := reviewcomments.SetGitHubCommentID(s.DB, dir, l.c.ID, id, l.c.Version); err != nil {
			fail(err)
		}
		sent = append(sent, sentLocal{local: l.c.ID, comment: id, version: l.c.Version})
	}

	// 4. Read them back, retrying once, and reconcile.
	if len(sent) > 0 {
		var present map[int64]bool
		var rerr error
		for attempt := 0; attempt < 2; attempt++ {
			present, rerr = s.presentOnGitHub(pc)
			if rerr == nil && allSent(present, len(sent), func(i int) int64 { return sent[i].comment }) {
				break
			}
		}
		if rerr != nil {
			fail(fmt.Errorf("reading the pending review back: %w", rerr))
		} else {
			unconfirmed := 0
			for _, sl := range sent {
				if !present[sl.comment] {
					unconfirmed++ // keeps its id: the next submit checks again
					continue
				}
				deleted, err := reviewcomments.DeleteIfVersion(s.DB, dir, sl.local, sl.version)
				if err != nil {
					fail(err)
					continue
				}
				if deleted {
					out.PostedLocalIDs = append(out.PostedLocalIDs, sl.local)
				} else if err := reviewcomments.ClearGitHubCommentID(s.DB, dir, sl.local); err != nil {
					fail(err) // edited since it was sent: local again
				}
			}
			if unconfirmed > 0 {
				fail(fmt.Errorf("%d of the comments added to your pending review do not show on GitHub yet; submit again to check", unconfirmed))
			}
		}
	}
	keep := func() {
		remaining, err := reviewcomments.List(s.DB, dir)
		if err != nil {
			msg := "listing local comments: " + err.Error()
			if out.Error != "" {
				msg = out.Error + "; " + msg
			}
			out.Error = msg
			return
		}
		for _, c := range remaining {
			out.KeptLocalIDs = append(out.KeptLocalIDs, c.ID)
		}
	}

	// 5. A failed add, or one not confirmed: the review is not submitted.
	if firstErr != nil {
		out.Error = firstErr.Error()
		keep()
		writeJSON(w, http.StatusBadGateway, out)
		return
	}

	// 6. Submit: a review that is only a message, or an approval, is
	// started first.
	err = nil
	if reviewID == "" {
		reviewID, err = s.pendingReviewID(pc, ctx, commit)
	}
	if err == nil {
		err = s.submitReview(pc.token, reviewID, req.Event, req.Body)
	}
	if err != nil {
		out.Error = err.Error()
		keep()
		writeJSON(w, http.StatusBadGateway, out)
		return
	}
	s.invalidatePR(pc.pr.ID)
	out.SubmittedReviewID = reviewID
	// The review is submitted: a failure listing what stays local is
	// reported in error, but the status stays 200 so it is not retried.
	keep()
	writeJSON(w, http.StatusOK, out)
}

// allSent reports whether present holds each of the n ids id(i) returns.
func allSent(present map[int64]bool, n int, id func(i int) int64) bool {
	for i := 0; i < n; i++ {
		if !present[id(i)] {
			return false
		}
	}
	return true
}
