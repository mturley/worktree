// Package prcomments holds the pure logic behind the Code tab's PR comments:
// which tracked PR belongs to a worktree, how many threads are open, a
// fingerprint that says when the threads changed, and which comments are
// unread.
//
// Nothing here touches the database, the network or git. Callers hand in the
// threads the watcher library fetched and the timeline events already read
// from the DB.
package prcomments

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/mturley/watcher"
	wgithub "github.com/mturley/watcher/github"
)

// Candidate is a tracked PR resource that might be the worktree's.
// RepoIsRemote says the PR's owner/repo is one of the worktree's remotes.
type Candidate struct {
	ID           string
	Primary      bool
	UpdatedAt    string
	HeadRefName  string
	Number       int
	RepoIsRemote bool
}

// PickPR chooses the worktree's PR. When the current branch tracks
// refs/pull/<trackedNumber>/head (trackedNumber > 0), a candidate with that
// number whose repo is one of the worktree's remotes wins, and only those
// are considered; this is how a worktree made from someone else's PR finds
// it, since its branch is not the PR's head. Otherwise it is the PR whose
// head branch is the given branch. Either way a primary (focus) resource
// wins over a related one; ties go to the newest UpdatedAt (RFC 3339
// strings compare correctly as text).
func PickPR(cands []Candidate, branch string, trackedNumber int) (Candidate, bool) {
	if trackedNumber > 0 {
		if c, ok := pickBest(cands, func(c Candidate) bool {
			return c.Number == trackedNumber && c.RepoIsRemote
		}); ok {
			return c, true
		}
	}
	return pickBest(cands, func(c Candidate) bool { return c.HeadRefName == branch })
}

func pickBest(cands []Candidate, match func(Candidate) bool) (Candidate, bool) {
	var best Candidate
	found := false
	for _, c := range cands {
		if !match(c) {
			continue
		}
		if !found || better(c, best) {
			best, found = c, true
		}
	}
	return best, found
}

func better(a, b Candidate) bool {
	if a.Primary != b.Primary {
		return a.Primary
	}
	return a.UpdatedAt > b.UpdatedAt
}

// Fingerprint is a hex digest that changes whenever a thread appears,
// resolves, goes outdated, or gains, loses or edits a comment. It does not
// depend on the order threads or comments arrive in.
func Fingerprint(t *wgithub.PRReviewThreads) string {
	var lines []string
	if t != nil {
		for _, th := range t.Threads {
			ids := make([]string, 0, len(th.Comments))
			for _, c := range th.Comments {
				ids = append(ids, fmt.Sprintf("%d@%s", c.DatabaseID, c.UpdatedAt))
			}
			sort.Strings(ids)
			lines = append(lines, fmt.Sprintf("%s|%t|%t|%s", th.ID, th.IsResolved, th.IsOutdated, strings.Join(ids, ",")))
		}
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(sum[:])
}

// OpenThreads counts the unresolved threads. A thread whose only comment is
// still Pending counts: it is open from the reviewer's point of view.
func OpenThreads(t *wgithub.PRReviewThreads) int {
	if t == nil {
		return 0
	}
	n := 0
	for _, th := range t.Threads {
		if !th.IsResolved {
			n++
		}
	}
	return n
}

// PendingCount counts the comments in the viewer's pending (unsubmitted)
// review.
func PendingCount(t *wgithub.PRReviewThreads) int {
	if t == nil {
		return 0
	}
	n := 0
	for _, th := range t.Threads {
		for _, c := range th.Comments {
			if c.Pending {
				n++
			}
		}
	}
	return n
}

const commentTagPrefix = "comment:"

// MatchEvents maps each comment's DatabaseID to its timeline event.
//
// The poller tags review comment events "comment:<databaseId>"; that tag is
// the match. Events polled before the tag existed carry none, so they match
// on the title "Review comment by <author> on <path>" plus ExternalTS equal
// to the comment's CreatedAt. An event that has a comment tag never falls
// back: it belongs to the comment it names, even if that comment is gone.
func MatchEvents(t *wgithub.PRReviewThreads, events []watcher.Event) map[int64]watcher.Event {
	out := map[int64]watcher.Event{}
	if t == nil {
		return out
	}
	byTag := map[int64]watcher.Event{}
	untagged := map[string]watcher.Event{}
	for _, e := range events {
		if e.Tags != nil && strings.HasPrefix(*e.Tags, commentTagPrefix) {
			if id, err := strconv.ParseInt((*e.Tags)[len(commentTagPrefix):], 10, 64); err == nil {
				byTag[id] = e
				continue
			}
		}
		if e.ExternalTS != nil {
			untagged[e.Title+"\x00"+*e.ExternalTS] = e
		}
	}
	for _, th := range t.Threads {
		for _, c := range th.Comments {
			if e, ok := byTag[c.DatabaseID]; ok {
				out[c.DatabaseID] = e
				continue
			}
			title := "Review comment by " + c.Author + " on " + th.Path
			if e, ok := untagged[title+"\x00"+c.CreatedAt]; ok {
				out[c.DatabaseID] = e
			}
		}
	}
	return out
}

// UnreadIDs lists the comments in open threads whose matched event isUnread
// reports unread. Pending comments (the viewer's own unsubmitted review) and
// comments with no matched event are never unread.
func UnreadIDs(t *wgithub.PRReviewThreads, matched map[int64]watcher.Event, isUnread func(watcher.Event) bool) []int64 {
	var ids []int64
	if t == nil {
		return ids
	}
	for _, th := range t.Threads {
		if th.IsResolved {
			continue
		}
		for _, c := range th.Comments {
			if c.Pending {
				continue
			}
			if e, ok := matched[c.DatabaseID]; ok && isUnread(e) {
				ids = append(ids, c.DatabaseID)
			}
		}
	}
	return ids
}
