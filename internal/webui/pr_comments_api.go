package webui

import (
	"database/sql"
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wgithub "github.com/mturley/watcher/github"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/prcomments"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/reviewcomments"
)

// PR comments: a worktree's tracked PR's review threads, fetched on demand
// through the watcher library (never polled into the DB), cached per PR so
// several open clients cost GitHub one fetch per period. See
// docs/web-ui-architecture.md "PR comments".
const (
	prSummaryTTL = 10 * time.Minute
	prThreadsTTL = 60 * time.Second
	// prWriteContextTTL is how long a PR's write context (node id, refs,
	// viewerDidAuthor, the viewer's pending review) is reused.
	prWriteContextTTL = 60 * time.Second
	// prErrorTTL is how long a failed fetch is remembered, so a failing
	// GitHub is not asked again on every client's 5s poll.
	prErrorTTL = 20 * time.Second
)

// errNoGitHubToken refuses a GitHub call with no token configured.
var errNoGitHubToken = errors.New("no GitHub token is configured")

// The summary/threads response states.
const (
	prStateOK      = "ok"
	prStateOff     = "off"
	prStateNoToken = "no_token"
	prStateNoPR    = "no_pr"
	prStateError   = "error"
)

func (s *Server) prThreadsCacheOrInit() *ttlCache {
	s.prThreadsOnce.Do(func() { s.prThreadsCache = newTTLCache() })
	return s.prThreadsCache
}

func (s *Server) fetchPRSummaries(token string, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
	if s.FetchPRSummaries != nil {
		return s.FetchPRSummaries(token, refs)
	}
	return ghLib.FetchPRSummaries(token, refs)
}

func (s *Server) fetchReviewThreads(token string, ref wgithub.PRRef) (*wgithub.PRReviewThreads, error) {
	if s.FetchReviewThreads != nil {
		return s.FetchReviewThreads(token, ref)
	}
	return ghLib.FetchReviewThreads(token, ref)
}

func (s *Server) fetchPRWriteContext(token string, ref wgithub.PRRef) (*wgithub.PRWriteContext, error) {
	if s.FetchPRWriteContext != nil {
		return s.FetchPRWriteContext(token, ref)
	}
	return ghLib.FetchPRWriteContext(token, ref)
}

// githubToken is the configured GitHub token, "" when there is none. The
// caller has already checked the GitHub watcher is on. A missing auth.yaml
// or one without GitHub is simply no token; an auth.yaml that cannot be
// read (bad permissions, bad YAML) is no token too, but is logged, once per
// distinct error, so it is not mistaken for an unconfigured service.
func (s *Server) githubToken() string {
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		s.logAuthErrorOnce(err)
		return ""
	}
	gh, err := cfg.GitHub()
	if err != nil {
		return ""
	}
	return gh.Token
}

func (s *Server) logAuthErrorOnce(err error) {
	s.prAuthErrMu.Lock()
	defer s.prAuthErrMu.Unlock()
	if s.prAuthErrLogged == err.Error() {
		return
	}
	s.prAuthErrLogged = err.Error()
	if s.Logger != nil {
		s.Logger.Printf("PR comments: reading auth.yaml: %v", err)
	}
}

type prRefDTO struct {
	ID     string `json:"id"`
	Number int    `json:"number"`
	URL    string `json:"url"`
	Title  string `json:"title"`
}

// prComments is a worktree's PR and its threads, or the state saying why
// there are none.
type prComments struct {
	state, branch, message string
	pr                     *prRefDTO
	threads                *wgithub.PRReviewThreads
	// token and ref are set with pr, for follow-up calls about the PR.
	token string
	ref   wgithub.PRRef
}

// prSummaryEntry is one PR's cached summary; found is false when GitHub
// could not resolve the PR (deleted, private), which is cached too.
type prSummaryEntry struct {
	sum   wgithub.PRSummary
	found bool
}

// offlinePR is dir's PR as far as it can be known without GitHub, for the
// off and no-token states, so the UI can still show (disabled) GitHub
// buttons: the PR its branch tracks (worktreePR: local git and the DB only),
// with its title and URL from a summary ALREADY in the cache when there is
// one, else the resource's URL and no title. Nil when no PR matches. It
// never fetches anything.
func (s *Server) offlinePR(dir string) *prRefDTO {
	chosen, ok := s.worktreePR(dir)
	if !ok {
		return nil
	}
	pr := &prRefDTO{ID: chosen.ID, Number: chosen.Number}
	if v, ok := s.prThreadsCacheOrInit().peek("prsum|" + chosen.ID); ok {
		if e, ok := v.(prSummaryEntry); ok && e.found {
			pr.Title, pr.URL = e.sum.Title, e.sum.URL
		}
	}
	if pr.URL == "" {
		if r, ok := s.prResource(dir, chosen.ID); ok {
			pr.URL = r.URL
		}
	}
	return pr
}

// prResource is dir's followed resource for PR id.
func (s *Server) prResource(dir, id string) (resources.Resource, bool) {
	tracked, err := resources.Load(s.DB, dir)
	if err != nil {
		return resources.Resource{}, false
	}
	for _, r := range resources.OfType(tracked, "pr") {
		if r.ID == id {
			return r, true
		}
	}
	return resources.Resource{}, false
}

// loadPRComments finds dir's PR (the one its branch tracks; worktreePR has
// the rule) and fetches that PR's summary and threads only. Nothing contacts
// GitHub while its watcher is off or no token is configured, or when no PR
// matches.
func (s *Server) loadPRComments(dir string) prComments {
	if !s.WatcherEnabled(config.ServiceGitHub) {
		return prComments{state: prStateOff, pr: s.offlinePR(dir)}
	}
	branch, _ := gitutil.CurrentBranch(dir)
	token := s.githubToken()
	if token == "" {
		return prComments{state: prStateNoToken, branch: branch, pr: s.offlinePR(dir)}
	}
	chosen, ok := s.worktreePR(dir)
	if !ok {
		return prComments{state: prStateNoPR, branch: branch}
	}
	ref, err := wgithub.ParsePRResourceID(chosen.ID)
	if err != nil {
		return prComments{state: prStateNoPR, branch: branch}
	}
	v, err := s.prThreadsCacheOrInit().getErrTTL("prsum|"+chosen.ID, prSummaryTTL, prErrorTTL, false, func() (interface{}, error) {
		batch, err := s.fetchPRSummaries(token, []wgithub.PRRef{ref})
		if err != nil {
			return nil, err
		}
		sum, ok := batch[ref]
		return prSummaryEntry{sum: sum, found: ok}, nil
	})
	if err != nil {
		return prComments{state: prStateError, branch: branch, message: err.Error()}
	}
	e := v.(prSummaryEntry)
	if !e.found {
		return prComments{state: prStateNoPR, branch: branch}
	}
	pr := &prRefDTO{ID: chosen.ID, Number: ref.Number, URL: e.sum.URL, Title: e.sum.Title}
	t, err := s.cachedReviewThreads(token, chosen.ID, ref)
	if err != nil {
		return prComments{state: prStateError, branch: branch, pr: pr, message: err.Error(), token: token, ref: ref}
	}
	return prComments{state: prStateOK, branch: branch, pr: pr, threads: t, token: token, ref: ref}
}

// cachedPRWriteContext is one PR's write context, from the cache when fresh.
// A failure is remembered for prErrorTTL. An empty token is refused before
// anything is fetched (and is not cached): GitHub is never asked
// unauthenticated.
func (s *Server) cachedPRWriteContext(token, id string, ref wgithub.PRRef) (*wgithub.PRWriteContext, error) {
	if token == "" {
		return nil, errNoGitHubToken
	}
	v, err := s.prThreadsCacheOrInit().getErrTTL("prctx|"+id, prWriteContextTTL, prErrorTTL, false, func() (interface{}, error) {
		c, err := s.fetchPRWriteContext(token, ref)
		if err == nil && c == nil {
			err = errors.New("no PR write context returned")
		}
		return c, err
	})
	if err != nil {
		return nil, err
	}
	return v.(*wgithub.PRWriteContext), nil
}

// viewerIsAuthor says whether the viewer opened pc's PR. A failed fetch is
// false: it only disables Approve / Request changes, and must not fail the
// response it is part of.
func (s *Server) viewerIsAuthor(pc prComments) bool {
	if pc.pr == nil || pc.token == "" {
		return false
	}
	c, err := s.cachedPRWriteContext(pc.token, pc.pr.ID, pc.ref)
	return err == nil && c.ViewerDidAuthor
}

// cachedReviewThreads is one PR's threads, from the cache when fresh.
func (s *Server) cachedReviewThreads(token, id string, ref wgithub.PRRef) (*wgithub.PRReviewThreads, error) {
	v, err := s.prThreadsCacheOrInit().getErrTTL("prthreads|"+id, prThreadsTTL, prErrorTTL, false, func() (interface{}, error) {
		t, err := s.fetchReviewThreads(token, ref)
		if err == nil && t == nil {
			err = errors.New("no review threads returned")
		}
		return t, err
	})
	if err != nil {
		return nil, err
	}
	return v.(*wgithub.PRReviewThreads), nil
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// prUnreadIDs lists t's unread comments under the PR's read cursor. The
// unread index excludes the user's own events.
func (s *Server) prUnreadIDs(id string, t *wgithub.PRReviewThreads) ([]int64, error) {
	events, err := watcherdb.EventsForResourceByType(s.DB, "pr", id, string(watcher.EventTypePRReviewComment))
	if err != nil {
		return nil, err
	}
	ix := s.newUnreadIndex()
	ids := prcomments.UnreadIDs(t, prcomments.MatchEvents(t, events), func(e watcher.Event) bool {
		return ix.IsUnread(e.ID, "pr", id, e.TS, derefStr(e.ExternalTS), string(e.Type), e.Source, derefStr(e.AuthorID), derefStr(e.AuthorType))
	})
	if ids == nil {
		ids = []int64{}
	}
	return ids, nil
}

type prCommentsSummaryDTO struct {
	State          string    `json:"state"`
	Branch         string    `json:"branch,omitempty"`
	Message        string    `json:"message,omitempty"`
	PR             *prRefDTO `json:"pr,omitempty"`
	Fingerprint    string    `json:"fingerprint,omitempty"`
	OpenThreads    int       `json:"open_threads"`
	UnreadComments int       `json:"unread_comments"`
	UnreadIDs      []int64   `json:"unread_ids"`
	// PendingComments counts the viewer's pending review's comments.
	PendingComments int  `json:"pending_comments"`
	ViewerIsAuthor  bool `json:"viewer_is_author"`
	// StalePendingCommit is the short sha of the viewer's pending review's
	// commit when it isn't the PR's head; null otherwise, or when the write
	// context couldn't be read.
	StalePendingCommit *string `json:"stale_pending_commit"`
}

// handlePRComments: GET /api/pr-comments?path=
//
// The counts and fingerprint the Code tab and diff view poll. Always 200
// for a registered worktree; state says why there is nothing to show.
func (s *Server) handlePRComments(w http.ResponseWriter, r *http.Request) {
	dir, ok := s.registeredWorktreePath(w, r)
	if !ok {
		return
	}
	pc := s.loadPRComments(dir)
	out := prCommentsSummaryDTO{State: pc.state, Branch: pc.branch, Message: pc.message, PR: pc.pr, UnreadIDs: []int64{}}
	if pc.state == prStateOK {
		ids, err := s.prUnreadIDs(pc.pr.ID, pc.threads)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		out.Fingerprint = prcomments.Fingerprint(pc.threads)
		out.OpenThreads = prcomments.OpenThreads(pc.threads)
		out.UnreadComments = len(ids)
		out.UnreadIDs = ids
		out.PendingComments = prcomments.PendingCount(pc.threads)
		out.ViewerIsAuthor = s.viewerIsAuthor(pc)
		out.StalePendingCommit = s.stalePendingCommit(pc)
	}
	writeJSON(w, http.StatusOK, out)
}

// stalePendingCommit is the short sha of the viewer's pending review's
// commit when it is behind the PR's head, from the same cached write context
// viewerIsAuthor reads. A failed fetch is nil, as for viewerIsAuthor.
func (s *Server) stalePendingCommit(pc prComments) *string {
	if pc.pr == nil || pc.token == "" {
		return nil
	}
	c, err := s.cachedPRWriteContext(pc.token, pc.pr.ID, pc.ref)
	if err != nil || c.Pending == nil || c.Pending.CommitOid == "" || c.Pending.CommitOid == c.HeadRefOid {
		return nil
	}
	short := shortSHA(c.Pending.CommitOid)
	return &short
}

type prCommentDTO struct {
	ID        int64  `json:"id"`
	Author    string `json:"author"`
	AvatarURL string `json:"avatar_url"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
	URL       string `json:"url"`
	Pending   bool   `json:"pending"`
}

type prThreadDTO struct {
	ID        string         `json:"id"`
	Resolved  bool           `json:"resolved"`
	Outdated  bool           `json:"outdated"`
	File      string         `json:"file"`
	Side      string         `json:"side"`
	StartLine int            `json:"start_line"`
	EndLine   int            `json:"end_line"`
	View      *reviewViewDTO `json:"view,omitempty"`
	Comments  []prCommentDTO `json:"comments"`
}

// newPRThreadDTO builds a thread's DTO. Lines and side are the anchor's when
// it was placed, else GitHub's original lines and diff side.
func newPRThreadDTO(th wgithub.ReviewThread, pv prThreadView) prThreadDTO {
	d := prThreadDTO{
		ID: th.ID, Resolved: th.IsResolved, Outdated: th.IsOutdated, File: th.Path,
		View: pv.view, Comments: make([]prCommentDTO, 0, len(th.Comments)),
	}
	if pv.anchor != nil {
		d.Side, d.StartLine, d.EndLine = string(pv.anchor.Side), pv.anchor.Anchor.Start, pv.anchor.Anchor.End
	} else {
		d.Side = string(reviewcomments.SideNew)
		if th.DiffSide == "LEFT" {
			d.Side = string(reviewcomments.SideOld)
		}
		d.StartLine, d.EndLine = th.OriginalStartLine, th.OriginalLine
		if d.StartLine == 0 {
			d.StartLine = d.EndLine
		}
	}
	for _, c := range th.Comments {
		d.Comments = append(d.Comments, prCommentDTO{
			ID: c.DatabaseID, Author: c.Author, AvatarURL: c.AvatarURL, Body: c.Body,
			CreatedAt: c.CreatedAt, URL: c.URL, Pending: c.Pending,
		})
	}
	return d
}

// sortPRThreads orders threads open first, then by file and line.
func sortPRThreads(ts []prThreadDTO) {
	sort.SliceStable(ts, func(i, j int) bool {
		a, b := ts[i], ts[j]
		if a.Resolved != b.Resolved {
			return !a.Resolved
		}
		if a.File != b.File {
			return a.File < b.File
		}
		return a.StartLine < b.StartLine
	})
}

type prThreadsResponse struct {
	State          string        `json:"state"`
	Branch         string        `json:"branch,omitempty"`
	Message        string        `json:"message,omitempty"`
	PR             *prRefDTO     `json:"pr,omitempty"`
	Fingerprint    string        `json:"fingerprint,omitempty"`
	ViewerIsAuthor bool          `json:"viewer_is_author"`
	Threads        []prThreadDTO `json:"threads"`
}

// handlePRCommentThreads: GET /api/pr-comments/threads?path=&old_rev=&new_rev=
//
// The PR's threads, each placed in the view when both revs (handed out by
// /api/worktree-diff/patch) are given.
func (s *Server) handlePRCommentThreads(w http.ResponseWriter, r *http.Request) {
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
	pc := s.loadPRComments(dir)
	out, err := s.threadsResponse(dir, pc, view)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// PRThreadsResponse is the PR threads response, for the CLI.
type PRThreadsResponse = prThreadsResponse

// PRThreads is dir's PR and its review threads, each placed with no diff
// view (the anchor's own lines), as GET /api/pr-comments/threads without
// revs. The State says why there is nothing to show: off, no_token, no_pr or
// error (with Message). Only the DB and in-memory caches are touched; nothing
// is marked read and no event is recorded.
func (s *Server) PRThreads(dir string) (PRThreadsResponse, error) {
	return s.threadsResponse(dir, s.loadPRComments(dir), nil)
}

func (s *Server) threadsResponse(dir string, pc prComments, view *reviewView) (prThreadsResponse, error) {
	out := prThreadsResponse{State: pc.state, Branch: pc.branch, Message: pc.message, PR: pc.pr, Threads: []prThreadDTO{}}
	if pc.state == prStateOK {
		placed, err := s.reviewResolver().placeThreads(dir, pc.threads, view)
		if err != nil {
			return out, err
		}
		for i, th := range pc.threads.Threads {
			out.Threads = append(out.Threads, newPRThreadDTO(th, placed[i]))
		}
		sortPRThreads(out.Threads)
		out.Fingerprint = prcomments.Fingerprint(pc.threads)
		out.ViewerIsAuthor = s.viewerIsAuthor(pc)
	}
	return out, nil
}

// eventPRResource is the PR an event was recorded against.
func (s *Server) eventPRResource(eventID string) (string, bool, error) {
	var id string
	err := s.DB.QueryRow(`SELECT resource_id FROM watcher_event_resources
		WHERE event_id = ? AND resource_type = 'pr' ORDER BY resource_id LIMIT 1`, eventID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

// prWorktreesForPR lists the registered worktrees actively tracking PR id
// whose branch tracks it (worktreePR), in registry order. Only worktree:
// subscribers count; a task's hold subscription is not a worktree.
func (s *Server) prWorktreesForPR(id string) ([]string, error) {
	subs, err := watcherdb.SubscribersOf(s.DB, "pr", id)
	if err != nil {
		return nil, err
	}
	active := map[string]bool{}
	for _, sub := range subs {
		if sub.DeletedAt != nil || sub.UnsubscribedByUser {
			continue
		}
		if _, ok := wdb.WorktreePathFromSubscriber(sub.Subscriber); ok {
			active[sub.Subscriber] = true
		}
	}
	entries, err := registry.List(s.DB)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if !active[wdb.Subscriber(e.Path)] {
			continue
		}
		if c, ok := s.worktreePR(e.Path); ok && c.ID == id {
			out = append(out, e.Path)
		}
	}
	return out, nil
}

// handlePRCommentLocate: GET /api/pr-comments/locate?event_id=&prefer_path=
//
// Where "Go to comment in diff view" goes for a pr_review_comment event: a
// worktree tracking the event's PR whose branch tracks it (prefer_path when
// it qualifies, else the first), and the GitHub comment id the event is
// about. 404 when any part can't be found, so the button is hidden.
func (s *Server) handlePRCommentLocate(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	eventID := q.Get("event_id")
	if eventID == "" {
		writeError(w, http.StatusBadRequest, "missing event_id")
		return
	}
	notFound := func(msg string) { writeError(w, http.StatusNotFound, msg) }
	ev, err := watcherdb.GetEvent(s.DB, eventID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if ev == nil || ev.Type != watcher.EventTypePRReviewComment {
		notFound("no such review comment event")
		return
	}
	id, ok, err := s.eventPRResource(eventID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		notFound("event has no PR")
		return
	}
	if !s.WatcherEnabled(config.ServiceGitHub) {
		notFound("GitHub watcher is off")
		return
	}
	token := s.githubToken()
	if token == "" {
		notFound("no GitHub token")
		return
	}
	ref, err := wgithub.ParsePRResourceID(id)
	if err != nil {
		notFound("bad PR id")
		return
	}
	t, err := s.cachedReviewThreads(token, id, ref)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	var commentID int64
	found := false
	for cid := range prcomments.MatchEvents(t, []watcher.Event{*ev}) {
		commentID, found = cid, true
	}
	if !found {
		notFound("comment not found on the PR")
		return
	}
	paths, err := s.prWorktreesForPR(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(paths) == 0 {
		notFound("no worktree on the PR's branch")
		return
	}
	path := paths[0]
	if prefer := q.Get("prefer_path"); prefer != "" {
		for _, p := range paths {
			if wdb.Subscriber(p) == wdb.Subscriber(prefer) {
				path = p
				break
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path, "comment_id": commentID})
}

// PRThread is one review thread as the CLI prints it.
type PRThread = prThreadDTO
