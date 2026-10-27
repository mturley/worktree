package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/reviewcomments"
)

// maxReviewCommentBody caps one comment's text.
const maxReviewCommentBody = 64 << 10

// reviewCommentDTO is a comment as the UI sees it. Context lines are never
// sent: they exist only for the server's re-anchoring.
type reviewCommentDTO struct {
	ID        int64    `json:"id"`
	Source    string   `json:"source"`
	Author    string   `json:"author,omitempty"`
	Editable  bool     `json:"editable"`
	File      string   `json:"file"`
	Side      string   `json:"side"`
	StartLine int      `json:"start_line"`
	EndLine   int      `json:"end_line"`
	Rev       string   `json:"rev"`
	Base      string   `json:"base"`
	BaseRef   string   `json:"base_ref"`
	RangeFrom string   `json:"range_from,omitempty"`
	RangeTo   string   `json:"range_to,omitempty"`
	Snippet   []string `json:"snippet"`
	Body      string   `json:"body"`
	Version   int      `json:"version"`
	CreatedAt string   `json:"created_at"`
	UpdatedAt string   `json:"updated_at"`
}

func newReviewCommentDTO(c reviewcomments.Comment) reviewCommentDTO {
	snippet := c.Anchor.Snippet
	if snippet == nil {
		snippet = []string{}
	}
	return reviewCommentDTO{
		ID: c.ID, Source: c.Source, Editable: c.Source == reviewcomments.SourceDraft,
		File: c.File, Side: string(c.Side), StartLine: c.Anchor.Start, EndLine: c.Anchor.End,
		Rev: c.Rev, Base: c.Base, BaseRef: c.BaseRef, RangeFrom: c.RangeFrom, RangeTo: c.RangeTo,
		Snippet: snippet, Body: c.Body, Version: c.Version, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt,
	}
}

// reviewCommentItem is one entry of the list response. It embeds the comment
// so later additions (resolved view, prompt) do not reshape it.
type reviewCommentItem struct {
	reviewCommentDTO
	View   *reviewViewDTO  `json:"view,omitempty"`
	Prompt reviewPromptDTO `json:"prompt"`
}

// reviewViewDTO is where a comment sits in the diff the client is showing.
type reviewViewDTO struct {
	Status    string `json:"status"`
	StartLine int    `json:"start_line,omitempty"`
	EndLine   int    `json:"end_line,omitempty"`
	Moved     bool   `json:"moved,omitempty"`
}

// reviewPromptDTO is where a comment sits in the working tree, which is what
// an agent sent the comments will edit.
type reviewPromptDTO struct {
	Status    string `json:"status"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
}

// registeredBodyPath resolves a JSON body's path to a registered worktree's
// canonical path, writing the error response itself when it cannot.
func (s *Server) registeredBodyPath(w http.ResponseWriter, path string) (string, bool) {
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return "", false
	}
	entry, err := registry.Get(s.DB, path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return "", false
	}
	if entry == nil {
		writeError(w, http.StatusNotFound, "not a registered worktree")
		return "", false
	}
	return entry.Path, true
}

func decodeReviewBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*maxReviewCommentBody)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

// checkReviewCommentBody rejects blank or oversized text.
func checkReviewCommentBody(w http.ResponseWriter, body string) bool {
	if strings.TrimSpace(body) == "" {
		writeError(w, http.StatusBadRequest, "comment is empty")
		return false
	}
	if len(body) > maxReviewCommentBody {
		writeError(w, http.StatusRequestEntityTooLarge, "comment is too long")
		return false
	}
	return true
}

// handleListReviewComments: GET /api/review-comments?path=&old_rev=&new_rev=
//
// Every comment carries its prompt position (in the working tree). With both
// revs of a diff /patch handed out, each also carries its view position.
func (s *Server) handleListReviewComments(w http.ResponseWriter, r *http.Request) {
	dir, ok := s.registeredWorktreePath(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	oldRev, newRev := q.Get("old_rev"), q.Get("new_rev")
	if (oldRev == "") != (newRev == "") {
		writeError(w, http.StatusBadRequest, "old_rev and new_rev must be given together")
		return
	}
	var view *reviewView
	if oldRev != "" {
		if !s.revSet().has(dir, oldRev) || !s.revSet().has(dir, newRev) {
			writeError(w, http.StatusNotFound, "unknown rev")
			return
		}
		view = &reviewView{oldRev: oldRev, newRev: newRev}
	}
	comments, err := reviewcomments.List(s.DB, dir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	items, err := s.reviewResolver().resolve(dir, comments, view)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"comments": items})
}

type createReviewCommentRequest struct {
	Path      string `json:"path"`
	File      string `json:"file"`
	Side      string `json:"side"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Body      string `json:"body"`
	Base      string `json:"base"`
	From      string `json:"from"`
	To        string `json:"to"`
	OldRev    string `json:"old_rev"`
	NewRev    string `json:"new_rev"`
}

// handleCreateReviewComment: POST /api/review-comments
//
// The server captures the anchor itself from the file at a rev it handed out
// via /patch; clients never supply positions' context.
func (s *Server) handleCreateReviewComment(w http.ResponseWriter, r *http.Request) {
	var req createReviewCommentRequest
	if !decodeReviewBody(w, r, &req) {
		return
	}
	dir, ok := s.registeredBodyPath(w, req.Path)
	if !ok {
		return
	}
	if !checkReviewCommentBody(w, req.Body) {
		return
	}
	side := reviewcomments.Side(req.Side)
	if side != reviewcomments.SideOld && side != reviewcomments.SideNew {
		writeError(w, http.StatusBadRequest, "side must be old or new")
		return
	}
	if req.File == "" || !filepath.IsLocal(req.File) {
		writeError(w, http.StatusBadRequest, "invalid file")
		return
	}
	if req.Base != "merge-base" && req.Base != "tracking" {
		writeError(w, http.StatusBadRequest, "base must be merge-base or tracking")
		return
	}
	rev := req.NewRev
	if side == reviewcomments.SideOld {
		rev = req.OldRev
	}
	if rev == "" || !s.revSet().has(dir, rev) {
		writeError(w, http.StatusNotFound, "unknown rev")
		return
	}
	content, err := gitutil.ShowFile(dir, rev, req.File)
	if err != nil {
		writeError(w, http.StatusBadRequest, "file not found at that rev")
		return
	}
	anchor, err := reviewcomments.Capture(reviewcomments.SplitLines(content), req.StartLine, req.EndLine)
	if err != nil {
		if errors.Is(err, reviewcomments.ErrOutOfRange) {
			writeError(w, http.StatusBadRequest, "line range is outside the file")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	baseRef, status, msg := baseRefFor(dir, req.Base)
	if status != 0 {
		writeError(w, status, msg)
		return
	}
	c, err := reviewcomments.Create(s.DB, dir, reviewcomments.NewComment{
		File: req.File, Side: side, Rev: storedRev(dir, rev, req.File), Base: req.Base, BaseRef: baseRef,
		RangeFrom: req.From, RangeTo: req.To, Anchor: anchor, Body: req.Body,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, newReviewCommentDTO(c))
}

// storedRev is the rev a comment on file at view rev rev is stored under:
// rev itself when it is a commit; for a working-tree snapshot, HEAD when the
// file is unchanged from it, else reviewcomments.RevUncommitted.
func storedRev(dir, rev, file string) string {
	if gitutil.IsCommit(dir, rev) {
		return rev
	}
	if blob, ok := gitutil.BlobSHA(dir, rev, file); ok {
		if head, ok := gitutil.BlobSHA(dir, "HEAD", file); ok && head == blob {
			if sha := gitutil.RevParse(dir, "HEAD"); sha != "" {
				return sha
			}
		}
	}
	return reviewcomments.RevUncommitted
}

type updateReviewCommentRequest struct {
	Path    string `json:"path"`
	ID      int64  `json:"id"`
	Version int    `json:"version"`
	Body    string `json:"body"`
}

// handleUpdateReviewComment: POST /api/review-comments/update
//
// A stale version is a 409 carrying the current comment so the client can
// keep the user's text next to it.
func (s *Server) handleUpdateReviewComment(w http.ResponseWriter, r *http.Request) {
	var req updateReviewCommentRequest
	if !decodeReviewBody(w, r, &req) {
		return
	}
	dir, ok := s.registeredBodyPath(w, req.Path)
	if !ok {
		return
	}
	if !checkReviewCommentBody(w, req.Body) {
		return
	}
	c, err := reviewcomments.Update(s.DB, dir, req.ID, req.Version, req.Body)
	switch {
	case errors.Is(err, reviewcomments.ErrNotFound):
		writeError(w, http.StatusNotFound, "comment not found")
	case errors.Is(err, reviewcomments.ErrConflict):
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "changed elsewhere", "comment": newReviewCommentDTO(c),
		})
	case err != nil:
		writeError(w, http.StatusInternalServerError, err.Error())
	default:
		writeJSON(w, http.StatusOK, newReviewCommentDTO(c))
	}
}

// handleDeleteReviewComment: POST /api/review-comments/delete
func (s *Server) handleDeleteReviewComment(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		ID   int64  `json:"id"`
	}
	if !decodeReviewBody(w, r, &req) {
		return
	}
	dir, ok := s.registeredBodyPath(w, req.Path)
	if !ok {
		return
	}
	if err := reviewcomments.Delete(s.DB, dir, req.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleClearReviewComments: POST /api/review-comments/clear
func (s *Server) handleClearReviewComments(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if !decodeReviewBody(w, r, &req) {
		return
	}
	dir, ok := s.registeredBodyPath(w, req.Path)
	if !ok {
		return
	}
	if err := reviewcomments.DeleteAll(s.DB, dir); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
