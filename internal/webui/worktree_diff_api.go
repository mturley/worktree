package webui

import (
	"errors"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/registry"
)

const (
	revSetTTL = 30 * time.Minute
	revSetMax = 200
)

// revSet remembers which revs /patch handed out for which worktree, so /file
// can refuse anything else. /file runs `git show <rev>:<file>`, and an
// arbitrary rev would let a caller read any object in the repository; a
// snapshot tree built from the working tree (which excludes ignored files) is
// only reachable by being named in a /patch response. Entries expire and the
// set is capped, oldest evicted first, so it cannot grow without bound.
type revSet struct {
	mu      sync.Mutex
	now     func() time.Time // injectable for tests
	entries []revEntry       // oldest first
}

type revEntry struct {
	path, rev string
	at        time.Time
}

func newRevSet() *revSet { return &revSet{now: time.Now} }

func (s *revSet) add(path string, revs ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.pruneLocked(now)
	for _, rev := range revs {
		// Re-adding refreshes: drop the old entry and append anew.
		for i, e := range s.entries {
			if e.path == path && e.rev == rev {
				s.entries = append(s.entries[:i], s.entries[i+1:]...)
				break
			}
		}
		s.entries = append(s.entries, revEntry{path, rev, now})
	}
	if over := len(s.entries) - revSetMax; over > 0 {
		s.entries = append([]revEntry(nil), s.entries[over:]...)
	}
}

func (s *revSet) has(path, rev string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(s.now())
	for _, e := range s.entries {
		if e.path == path && e.rev == rev {
			return true
		}
	}
	return false
}

// pruneLocked drops expired entries. Entries are in insertion order, so the
// expired ones are a prefix.
func (s *revSet) pruneLocked(now time.Time) {
	i := 0
	for i < len(s.entries) && now.Sub(s.entries[i].at) > revSetTTL {
		i++
	}
	if i > 0 {
		s.entries = append([]revEntry(nil), s.entries[i:]...)
	}
}

// registeredWorktreePath resolves ?path= to a registered worktree's canonical
// path, writing the error response itself when it cannot.
func (s *Server) registeredWorktreePath(w http.ResponseWriter, r *http.Request) (string, bool) {
	path := r.URL.Query().Get("path")
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

// diffTarget is the worktree and base a diff request is about.
type diffTarget struct {
	dir, baseRef string
}

// diffTargetFor resolves path and base. An unknown base value is a 400; a
// known one that this repo cannot supply (no upstream, no tracking branch) is
// a 409, which the UI shows as an explanation rather than an error.
func (s *Server) diffTargetFor(w http.ResponseWriter, r *http.Request) (diffTarget, bool) {
	dir, ok := s.registeredWorktreePath(w, r)
	if !ok {
		return diffTarget{}, false
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		writeError(w, http.StatusConflict, "worktree is missing from disk")
		return diffTarget{}, false
	}
	ref, status, msg := baseRefFor(dir, r.URL.Query().Get("base"))
	if status != 0 {
		writeError(w, status, msg)
		return diffTarget{}, false
	}
	return diffTarget{dir: dir, baseRef: ref}, true
}

// baseRefFor maps a base value to the ref it compares against. status is 0 on
// success, else the HTTP status and message to answer with.
func baseRefFor(dir, base string) (ref string, status int, msg string) {
	var ok bool
	switch base {
	case "merge-base":
		if ref, ok = gitutil.MainUpstream(dir); !ok {
			return "", http.StatusConflict, "no upstream main branch to compare against"
		}
	case "tracking":
		if ref, ok = gitutil.TrackingBranch(dir); !ok {
			return "", http.StatusConflict, "this branch has no tracking branch"
		}
	default:
		return "", http.StatusBadRequest, "base must be merge-base or tracking"
	}
	return ref, 0, ""
}

// commitsAndListID lists the branch's commits and the list's identity.
func (t diffTarget) commitsAndListID() (commits []gitutil.Commit, mergeBase, listID string, err error) {
	commits, err = gitutil.FirstParentCommits(t.dir, t.baseRef)
	if err != nil {
		return nil, "", "", err
	}
	mergeBase, _ = gitutil.MergeBase(t.dir, t.baseRef)
	return commits, mergeBase, gitutil.ListID(commits, mergeBase), nil
}

// handleDiffCommits: GET /api/worktree-diff/commits?path=&base=
func (s *Server) handleDiffCommits(w http.ResponseWriter, r *http.Request) {
	t, ok := s.diffTargetFor(w, r)
	if !ok {
		return
	}
	commits, mb, id, err := t.commitsAndListID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if commits == nil {
		commits = []gitutil.Commit{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id": id, "base_ref": t.baseRef, "merge_base": mb, "commits": commits,
	})
}

// resolveDiff resolves the request's from/to into revs, writing the error
// response itself on failure. Both omitted is All changes; exactly one is a 400.
func (s *Server) resolveDiff(w http.ResponseWriter, r *http.Request, t diffTarget) (oldRev, newRev, listID string, ok bool) {
	q := r.URL.Query()
	from, to := q.Get("from"), q.Get("to")
	if (from == "") != (to == "") {
		writeError(w, http.StatusBadRequest, "from and to must be given together")
		return
	}
	commits, _, id, err := t.commitsAndListID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	oldRev, newRev, err = gitutil.ResolveRange(t.dir, t.baseRef, commits, gitutil.Range{From: from, To: to})
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, gitutil.ErrInvalidRange) {
			status = http.StatusBadRequest
		}
		writeError(w, status, err.Error())
		return
	}
	return oldRev, newRev, id, true
}

// handleDiffFiles: GET /api/worktree-diff/files?path=&base=&from=&to=
func (s *Server) handleDiffFiles(w http.ResponseWriter, r *http.Request) {
	t, ok := s.diffTargetFor(w, r)
	if !ok {
		return
	}
	fp, err := gitutil.ComputeFingerprint(t.dir, t.baseRef)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	oldRev, newRev, id, ok := s.resolveDiff(w, r, t)
	if !ok {
		return
	}
	files, err := gitutil.DiffFiles(t.dir, oldRev, newRev)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if files == nil {
		files = []gitutil.FileChange{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"fingerprint": fp.Full, "list_id": id, "files": files})
}

// handleDiffPatch: GET /api/worktree-diff/patch?path=&base=&from=&to=&ignore_ws=1
func (s *Server) handleDiffPatch(w http.ResponseWriter, r *http.Request) {
	t, ok := s.diffTargetFor(w, r)
	if !ok {
		return
	}
	// Fingerprint BEFORE snapshotting: an edit landing in between then makes
	// the client's next poll see a different fingerprint and refetch, instead
	// of the patch silently being newer than the fingerprint it is labelled with.
	fp, err := gitutil.ComputeFingerprint(t.dir, t.baseRef)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	oldRev, newRev, id, ok := s.resolveDiff(w, r, t)
	if !ok {
		return
	}
	patch, err := gitutil.DiffPatch(t.dir, oldRev, newRev, r.URL.Query().Get("ignore_ws") == "1")
	if errors.Is(err, gitutil.ErrPatchTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "diff is too large to display")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.revSet().add(t.dir, oldRev, newRev)
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id": id, "working_fingerprint": fp.Working,
		"old_rev": oldRev, "new_rev": newRev, "patch": patch,
	})
}

// handleDiffFile: GET /api/worktree-diff/file?path=&rev=&file=
//
// Serves one file at a rev this server handed out via /patch, so the diff view
// can expand unchanged lines. Anything else is a 404.
func (s *Server) handleDiffFile(w http.ResponseWriter, r *http.Request) {
	dir, ok := s.registeredWorktreePath(w, r)
	if !ok {
		return
	}
	rev, file := r.URL.Query().Get("rev"), r.URL.Query().Get("file")
	if rev == "" || file == "" {
		writeError(w, http.StatusBadRequest, "missing rev or file")
		return
	}
	if !s.revSet().has(dir, rev) {
		writeError(w, http.StatusNotFound, "unknown rev")
		return
	}
	content, err := gitutil.ShowFile(dir, rev, file)
	if err != nil {
		writeError(w, http.StatusNotFound, "file not found at rev")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

// revSet returns the server's handed-out-rev memory, creating it on first use.
func (s *Server) revSet() *revSet {
	s.revsMu.Lock()
	defer s.revsMu.Unlock()
	if s.revs == nil {
		s.revs = newRevSet()
	}
	return s.revs
}
