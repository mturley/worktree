package prcomments

import (
	"reflect"
	"testing"

	"github.com/mturley/watcher"
	wgithub "github.com/mturley/watcher/github"
)

func sp(s string) *string { return &s }

func TestPickPR(t *testing.T) {
	cands := []Candidate{
		{ID: "a", Primary: false, UpdatedAt: "2026-02-01T00:00:00Z", HeadRefName: "feat"},
		{ID: "b", Primary: true, UpdatedAt: "2026-01-01T00:00:00Z", HeadRefName: "feat"},
		{ID: "c", Primary: true, UpdatedAt: "2026-03-01T00:00:00Z", HeadRefName: "other"},
	}
	got, ok := PickPR(cands, "feat", 0)
	if !ok || got.ID != "b" {
		t.Fatalf("primary should win, got %+v ok=%v", got, ok)
	}
	if _, ok := PickPR(cands, "nope", 0); ok {
		t.Fatal("no candidate on branch should give ok=false")
	}
	related := []Candidate{
		{ID: "x", UpdatedAt: "2026-01-01T00:00:00Z", HeadRefName: "feat"},
		{ID: "y", UpdatedAt: "2026-02-01T00:00:00Z", HeadRefName: "feat"},
	}
	got, ok = PickPR(related, "feat", 0)
	if !ok || got.ID != "y" {
		t.Fatalf("newer should win, got %+v", got)
	}
}

func TestPickPRByNumber(t *testing.T) {
	cands := []Candidate{
		{ID: "branch", Primary: true, UpdatedAt: "2026-03-01T00:00:00Z", HeadRefName: "review/pr-7-x", Number: 3, RepoIsRemote: true},
		{ID: "num", Primary: false, UpdatedAt: "2026-01-01T00:00:00Z", HeadRefName: "author-branch", Number: 7, RepoIsRemote: true},
		{ID: "fork", Primary: true, UpdatedAt: "2026-04-01T00:00:00Z", HeadRefName: "other", Number: 7, RepoIsRemote: false},
	}
	if got, ok := PickPR(cands, "review/pr-7-x", 7); !ok || got.ID != "num" {
		t.Fatalf("tracked number should win over the head branch, got %+v ok=%v", got, ok)
	}
	// Only the remote-less number match: ignored, so the branch match wins.
	if got, ok := PickPR([]Candidate{cands[0], cands[2]}, "review/pr-7-x", 7); !ok || got.ID != "branch" {
		t.Fatalf("number match not on a remote should be ignored, got %+v ok=%v", got, ok)
	}
	if _, ok := PickPR([]Candidate{cands[2]}, "review/pr-7-x", 7); ok {
		t.Fatal("number match not on a remote alone should give ok=false")
	}
	if got, ok := PickPR(cands, "review/pr-7-x", 0); !ok || got.ID != "branch" {
		t.Fatalf("no tracked number falls back to the branch, got %+v ok=%v", got, ok)
	}
	// Ties among number matches: primary first, then newest.
	tied := []Candidate{
		{ID: "old", UpdatedAt: "2026-01-01T00:00:00Z", Number: 7, RepoIsRemote: true},
		{ID: "new", UpdatedAt: "2026-02-01T00:00:00Z", Number: 7, RepoIsRemote: true},
		{ID: "prim", Primary: true, UpdatedAt: "2025-01-01T00:00:00Z", Number: 7, RepoIsRemote: true},
	}
	if got, _ := PickPR(tied, "x", 7); got.ID != "prim" {
		t.Fatalf("primary should win a number tie, got %+v", got)
	}
	if got, _ := PickPR(tied[:2], "x", 7); got.ID != "new" {
		t.Fatalf("newest should win a number tie, got %+v", got)
	}
}

func TestPendingCount(t *testing.T) {
	if n := PendingCount(nil); n != 0 {
		t.Fatalf("nil = %d", n)
	}
	s := sample()
	s.Threads[0].Comments[1].Pending = true
	if n := PendingCount(s); n != 2 {
		t.Fatalf("PendingCount = %d, want 2", n)
	}
}

func sample() *wgithub.PRReviewThreads {
	return &wgithub.PRReviewThreads{Threads: []wgithub.ReviewThread{
		{ID: "t1", Path: "a.go", Comments: []wgithub.ThreadComment{
			{DatabaseID: 1, Author: "bob", CreatedAt: "c1", UpdatedAt: "u1"},
			{DatabaseID: 2, Author: "amy", CreatedAt: "c2", UpdatedAt: "u2"}}},
		{ID: "t2", Path: "b.go", IsResolved: true, Comments: []wgithub.ThreadComment{
			{DatabaseID: 3, Author: "bob", CreatedAt: "c3", UpdatedAt: "u3"}}},
		{ID: "t3", Path: "c.go", Comments: []wgithub.ThreadComment{
			{DatabaseID: 4, Author: "bob", Pending: true, CreatedAt: "c4"}}},
	}}
}

func TestFingerprintChanges(t *testing.T) {
	base := Fingerprint(sample())
	if base != Fingerprint(sample()) {
		t.Fatal("not deterministic")
	}
	s := sample()
	s.Threads[0], s.Threads[2] = s.Threads[2], s.Threads[0]
	if Fingerprint(s) != base {
		t.Fatal("should be stable under thread order")
	}
	s = sample()
	s.Threads[0].IsResolved = true
	if Fingerprint(s) == base {
		t.Fatal("resolve flip should change")
	}
	s = sample()
	s.Threads[0].Comments[1].UpdatedAt = "u2b"
	if Fingerprint(s) == base {
		t.Fatal("comment edit should change")
	}
	s = sample()
	s.Threads[0].IsOutdated = true
	if Fingerprint(s) == base {
		t.Fatal("outdated flip should change")
	}
}

func TestOpenThreads(t *testing.T) {
	if n := OpenThreads(sample()); n != 2 {
		t.Fatalf("got %d, want 2 (pending-only thread counts)", n)
	}
	if OpenThreads(nil) != 0 {
		t.Fatal("nil should be 0")
	}
}

func TestMatchEventsByTag(t *testing.T) {
	evs := []watcher.Event{
		{ID: "e1", Title: "whatever", Tags: sp("comment:2")},
		{ID: "e2", Title: "Review comment by bob on a.go", ExternalTS: sp("c1"), Tags: sp("comment:99")},
	}
	m := MatchEvents(sample(), evs)
	if m[2].ID != "e1" {
		t.Fatalf("tag match failed: %+v", m)
	}
	if _, ok := m[1]; ok {
		t.Fatal("event tagged for another comment must not fallback-match")
	}
}

func TestMatchEventsFallback(t *testing.T) {
	evs := []watcher.Event{
		{ID: "e1", Title: "Review comment by bob on a.go", ExternalTS: sp("c1")},
		{ID: "e2", Title: "Review comment by amy on a.go", ExternalTS: sp("other")},
	}
	m := MatchEvents(sample(), evs)
	if m[1].ID != "e1" {
		t.Fatalf("fallback failed: %+v", m)
	}
	if _, ok := m[2]; ok {
		t.Fatal("different ExternalTS must not match")
	}
}

func TestUnreadIDs(t *testing.T) {
	matched := map[int64]watcher.Event{
		1: {ID: "e1"}, 2: {ID: "e2"}, 3: {ID: "e3"}, 4: {ID: "e4"},
	}
	got := UnreadIDs(sample(), matched, func(e watcher.Event) bool { return e.ID != "e2" })
	if want := []int64{1}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}
