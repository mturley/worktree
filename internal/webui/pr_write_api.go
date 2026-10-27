package webui

import (
	"errors"
	"net/http"
	"path/filepath"
	"strconv"

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
	case pc.pr != nil:
		return pc, true
	case pc.state == prStateNoToken:
		writeJSON(w, http.StatusConflict, map[string]string{"state": prStateNoToken, "error": "no GitHub token is configured"})
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

// placeOnPR loads pc's target and places c on it. A missing commit is an
// unpostable placement with reasonMissingCommit, not an error.
func (s *Server) placeOnPR(dir string, pc prComments, c reviewcomments.Comment) (*prTarget, prPlacement, error) {
	t, err := s.loadPRTarget(dir, pc)
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

type prCheckResponse struct {
	Postable bool   `json:"postable"`
	Reason   string `json:"reason,omitempty"`
}

// handlePRWriteCheck: GET /api/pr-write/check?path=&file=&side=&start_line=&end_line=&old_rev=&new_rev=
//
// Whether a new comment on these lines of the view can be posted to the PR,
// and if not why.
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
	_, p, err := s.placeOnPR(dir, pc, c)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, prCheckResponse{Postable: p.ok, Reason: p.reason})
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
// (started when there is none) in "review" mode, posted now in "single"
// mode, both at the target commit. Lines GitHub would refuse are a 409
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
	t, p, err := s.placeOnPR(dir, pc, c)
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
