package webui

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/reviewcomments"
)

// reviewCacheMax bounds each of reviewResolver's caches; a cache reaching it
// is cleared rather than evicted entry by entry.
const reviewCacheMax = 512

// reviewResolver works out where each review comment sits, both in the diff a
// client is showing (view) and in the working tree (prompt).
//
// Only inputs are cached, never positions: file contents at revs /patch handed
// out (immutable SHAs, snapshot trees included), changed-file lists between
// two such revs, and All-changes file sets keyed by the working-tree
// fingerprint. Working-tree files are read from disk on every request.
type reviewResolver struct {
	mu       sync.Mutex
	locks    map[string]*sync.Mutex          // per worktree dir
	contents map[string][]string             // rev\0file → lines; successful reads only
	changed  map[string][]gitutil.FileChange // old\0new → changes
	all      map[string][]gitutil.FileChange // dir\0base\0fingerprint → changes

	// showFile reads a file at a rev; a field so tests can make it fail.
	showFile func(dir, rev, file string) ([]byte, error)
}

func newReviewResolver() *reviewResolver {
	return &reviewResolver{
		locks:    map[string]*sync.Mutex{},
		contents: map[string][]string{},
		changed:  map[string][]gitutil.FileChange{},
		all:      map[string][]gitutil.FileChange{},
		showFile: gitutil.ShowFile,
	}
}

// lockDir serializes resolution for one worktree, so concurrent lists do not
// each build the same snapshot tree.
func (r *reviewResolver) lockDir(dir string) func() {
	r.mu.Lock()
	l, ok := r.locks[dir]
	if !ok {
		l = &sync.Mutex{}
		r.locks[dir] = l
	}
	r.mu.Unlock()
	l.Lock()
	return l.Unlock
}

func cacheGet[V any](r *reviewResolver, m map[string]V, key string) (V, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := m[key]
	return v, ok
}

func cachePut[V any](r *reviewResolver, m map[string]V, key string, v V) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(m) >= reviewCacheMax {
		clear(m)
	}
	m[key] = v
}

// linesAt returns file's lines at rev, or nil when they cannot be read. rev
// must be one /patch handed out, so it names immutable content. Only
// successful reads are cached: a failure may be transient (fork failure, too
// many open files), and git does not tell it apart from a missing file.
func (r *reviewResolver) linesAt(dir, rev, file string) []string {
	key := rev + "\x00" + file
	if lines, ok := cacheGet(r, r.contents, key); ok {
		return lines
	}
	content, err := r.showFile(dir, rev, file)
	if err != nil {
		return nil
	}
	lines := reviewcomments.SplitLines(content)
	cachePut(r, r.contents, key, lines)
	return lines
}

func (r *reviewResolver) changedFiles(dir, oldRev, newRev string) ([]gitutil.FileChange, error) {
	key := oldRev + "\x00" + newRev
	if files, ok := cacheGet(r, r.changed, key); ok {
		return files, nil
	}
	files, err := gitutil.DiffFiles(dir, oldRev, newRev)
	if err != nil {
		return nil, err
	}
	cachePut(r, r.changed, key, files)
	return files, nil
}

// allChanges returns the files changed in All changes for base (merge-base or
// tracking), as the diff view would list them now. ok is false when base
// cannot be resolved or the diff fails.
func (r *reviewResolver) allChanges(dir, base string) (files []gitutil.FileChange, ok bool) {
	baseRef, status, _ := baseRefFor(dir, base)
	if status != 0 {
		return nil, false
	}
	fp, err := gitutil.ComputeFingerprint(dir, baseRef)
	if err != nil {
		return nil, false
	}
	key := dir + "\x00" + base + "\x00" + fp.Full
	if files, ok := cacheGet(r, r.all, key); ok {
		return files, true
	}
	commits, _, _, err := diffTarget{dir: dir, baseRef: baseRef}.commitsAndListID()
	if err != nil {
		return nil, false
	}
	oldRev, newRev, err := gitutil.ResolveRange(dir, baseRef, commits, gitutil.Range{})
	if err != nil {
		return nil, false
	}
	files, err = gitutil.DiffFiles(dir, oldRev, newRev)
	if err != nil {
		return nil, false
	}
	cachePut(r, r.all, key, files)
	return files, true
}

// fileInChanges reports whether a comment's file on side has content in a
// diff with these changes: the new side needs the file to exist after (not
// deleted), the old side before (not added; a rename's old path counts).
func fileInChanges(files []gitutil.FileChange, side reviewcomments.Side, file string) bool {
	for _, f := range files {
		if side == reviewcomments.SideNew {
			if f.Path == file && f.Status != "D" {
				return true
			}
			continue
		}
		if (f.OldPath == file || f.Path == file) && f.Status != "A" {
			return true
		}
	}
	return false
}

// reviewView names the diff a client is showing.
type reviewView struct {
	oldRev, newRev string
}

// resolve fills each comment's prompt position, and its view position when
// view is non-nil, and returns them sorted by file, then line, then id. The
// view's revs must already have been checked against revSet.
func (r *reviewResolver) resolve(dir string, comments []reviewcomments.Comment, view *reviewView) ([]reviewCommentItem, error) {
	unlock := r.lockDir(dir)
	defer unlock()

	var viewFiles []gitutil.FileChange
	if view != nil {
		var err error
		if viewFiles, err = r.changedFiles(dir, view.oldRev, view.newRev); err != nil {
			return nil, err
		}
	}
	allByBase := map[string]allResult{}

	items := make([]reviewCommentItem, 0, len(comments))
	for _, c := range comments {
		item := reviewCommentItem{reviewCommentDTO: newReviewCommentDTO(c), Prompt: promptPosition(dir, c)}
		if view != nil {
			item.View = r.placeInView(dir, c, view, viewFiles, allByBase)
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if la, lb := sortLine(a), sortLine(b); la != lb {
			return la < lb
		}
		return a.ID < b.ID
	})
	return items, nil
}

// allResult is one base's All-changes file set, memoized per request so
// comments sharing a base compute it once.
type allResult struct {
	files []gitutil.FileChange
	ok    bool
}

// placeInView places c in view, whose changed files are viewFiles. A comment
// whose file is not in the view is "not_in_view" when All changes for its
// base still has it, else "outside_changes". allByBase memoizes allChanges
// across one request's calls.
func (r *reviewResolver) placeInView(dir string, c reviewcomments.Comment, view *reviewView, viewFiles []gitutil.FileChange, allByBase map[string]allResult) *reviewViewDTO {
	if v := r.viewPosition(dir, c, view, viewFiles); v != nil {
		return v
	}
	res, seen := allByBase[c.Base]
	if !seen {
		res.files, res.ok = r.allChanges(dir, c.Base)
		allByBase[c.Base] = res
	}
	status := "outside_changes"
	if res.ok && fileInChanges(res.files, c.Side, c.File) {
		status = "not_in_view"
	}
	return &reviewViewDTO{Status: status}
}

func sortLine(it reviewCommentItem) int {
	if it.View != nil && it.View.Status == "shown" {
		return it.View.StartLine
	}
	return it.StartLine
}

// viewPosition places c in the view, or returns nil when c's file is not
// among the view's changes on c's side.
func (r *reviewResolver) viewPosition(dir string, c reviewcomments.Comment, view *reviewView, files []gitutil.FileChange) *reviewViewDTO {
	if !fileInChanges(files, c.Side, c.File) {
		return nil
	}
	rev := view.newRev
	if c.Side == reviewcomments.SideOld {
		rev = view.oldRev
	}
	pos := reviewcomments.Resolve(c.Anchor, r.linesAt(dir, rev, c.File))
	switch pos.Match {
	case reviewcomments.MatchCurrent, reviewcomments.MatchMoved:
		return &reviewViewDTO{Status: "shown", StartLine: pos.Start, EndLine: pos.End, Moved: pos.Match == reviewcomments.MatchMoved}
	}
	// A removed line that no longer matches the old side is simply not
	// what this view shows; a new-side one is out of date.
	if c.Side == reviewcomments.SideOld {
		return &reviewViewDTO{Status: "not_in_view"}
	}
	return &reviewViewDTO{Status: "outdated"}
}

// promptPosition places c in the working tree. Old-side comments are about
// removed lines, which the working tree no longer has.
func promptPosition(dir string, c reviewcomments.Comment) reviewPromptDTO {
	anchored := func(status string) reviewPromptDTO {
		return reviewPromptDTO{Status: status, StartLine: c.Anchor.Start, EndLine: c.Anchor.End}
	}
	if c.Side == reviewcomments.SideOld {
		return anchored("removed")
	}
	path := filepath.Join(dir, c.File)
	if st, err := os.Lstat(path); err != nil || !st.Mode().IsRegular() {
		return anchored("outdated")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return anchored("outdated")
	}
	pos := reviewcomments.Resolve(c.Anchor, matchAnchorEOL(c.Anchor, reviewcomments.SplitLines(content)))
	if pos.Match == reviewcomments.MatchOutdated {
		return anchored("outdated")
	}
	return reviewPromptDTO{Status: string(pos.Match), StartLine: pos.Start, EndLine: pos.End}
}

// matchAnchorEOL compares working-tree lines on the anchor's terms. Anchors
// come from git objects, but an eol=crlf (or core.autocrlf) checkout puts CRLF
// on disk for an LF blob; then each line's single trailing "\r" is dropped.
// Only in that direction: an anchor that itself has "\r" is left alone.
func matchAnchorEOL(a reviewcomments.Anchor, lines []string) []string {
	if !anyEndsInCR(lines) || anyEndsInCR(a.Snippet) || anyEndsInCR(a.Before) || anyEndsInCR(a.After) {
		return lines
	}
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = strings.TrimSuffix(l, "\r")
	}
	return out
}

func anyEndsInCR(lines []string) bool {
	for _, l := range lines {
		if strings.HasSuffix(l, "\r") {
			return true
		}
	}
	return false
}

// reviewResolver returns the server's review comment resolver, creating it on
// first use.
func (s *Server) reviewResolver() *reviewResolver {
	s.reviewMu.Lock()
	defer s.reviewMu.Unlock()
	if s.review == nil {
		s.review = newReviewResolver()
	}
	return s.review
}
