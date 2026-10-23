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

// handleListReviewComments: GET /api/review-comments?path=
func (s *Server) handleListReviewComments(w http.ResponseWriter, r *http.Request) {
	dir, ok := s.registeredWorktreePath(w, r)
	if !ok {
		return
	}
	comments, err := reviewcomments.List(s.DB, dir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	items := make([]reviewCommentItem, 0, len(comments))
	for _, c := range comments {
		items = append(items, reviewCommentItem{newReviewCommentDTO(c)})
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
	stored := reviewcomments.RevUncommitted
	if gitutil.IsCommit(dir, rev) {
		stored = rev
	} else if blob, ok := gitutil.BlobSHA(dir, rev, req.File); ok {
		// A snapshot tree: if the file is unchanged from HEAD, the content
		// is committed and HEAD names it.
		if head, ok := gitutil.BlobSHA(dir, "HEAD", req.File); ok && head == blob {
			if sha := gitutil.RevParse(dir, "HEAD"); sha != "" {
				stored = sha
			}
		}
	}
	c, err := reviewcomments.Create(s.DB, dir, reviewcomments.NewComment{
		File: req.File, Side: side, Rev: stored, Base: req.Base, BaseRef: baseRef,
		RangeFrom: req.From, RangeTo: req.To, Anchor: anchor, Body: req.Body,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, newReviewCommentDTO(c))
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
