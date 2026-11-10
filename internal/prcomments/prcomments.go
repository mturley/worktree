// Package prcomments holds the pure logic behind the Code tab's PR comments:
// which followed PR belongs to a worktree (the one its branch tracks, judged
// from the PR's cached head and the branch's upstream; see PickPR), how many
// threads are open, a
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

// Candidate is a followed PR resource that might be the worktree's. The
// head fields come from the poller's cached state; they are empty when the
// state predates them, and HeadSlug is empty for a deleted fork.
type Candidate struct {
	ID        string // resource ID, "owner/repo#N"
	Primary   bool
	UpdatedAt string
	Number    int
	BaseSlug  string // lowercased owner/repo from the resource ID
	HeadSlug  string // lowercased head_repo_owner/head_repo_name; "" for a deleted fork
	HeadRef   string // head_ref_name
	BaseRef   string // base_ref_name
}

// Upstream is what the current branch tracks: the remote's slug
// (gitutil.RemoteSlug) and the merge ref (branch.<b>.merge).
type Upstream struct{ Slug, Merge string }

// PickPR chooses the worktree's PR: the one its branch tracks. A merge ref
// refs/heads/<h> matches the PR whose head repo is the upstream's and whose
// head branch is h, whatever the local branch is called. A merge ref
// refs/pull/<N>/head (a PR whose fork is gone) matches PR N of the
// upstream's repo. Any other merge ref, or an upstream with no slug (a local
// branch, an unknown remote), matches nothing. Slugs compare ignoring case.
// Among matches a primary (focus) resource wins over a related one; ties go
// to the newest UpdatedAt (RFC 3339 strings compare correctly as text).
func PickPR(cands []Candidate, up Upstream) (Candidate, bool) {
	if up.Slug == "" {
		return Candidate{}, false
	}
	if head, ok := strings.CutPrefix(up.Merge, "refs/heads/"); ok {
		if head == "" {
			return Candidate{}, false
		}
		return pickBest(cands, func(c Candidate) bool {
			return c.HeadSlug != "" && strings.EqualFold(c.HeadSlug, up.Slug) && c.HeadRef == head
		})
	}
	if n, ok := pullNumber(up.Merge); ok {
		return pickBest(cands, func(c Candidate) bool {
			return strings.EqualFold(c.BaseSlug, up.Slug) && c.Number == n
		})
	}
	return Candidate{}, false
}

// pullNumber is N from refs/pull/<N>/head.
func pullNumber(merge string) (int, bool) {
	rest, ok := strings.CutPrefix(merge, "refs/pull/")
	if !ok {
		return 0, false
	}
	num, ok := strings.CutSuffix(rest, "/head")
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(num)
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
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
