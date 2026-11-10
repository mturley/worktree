package prcomments

import (
	"reflect"
	"testing"

	"github.com/mturley/watcher"
	wgithub "github.com/mturley/watcher/github"
)

func sp(s string) *string { return &s }

func TestPickPROwnPR(t *testing.T) {
	cands := []Candidate{
		{ID: "opendatahub-io/odh-dashboard#1", BaseSlug: "opendatahub-io/odh-dashboard", HeadSlug: "mturley/odh-dashboard", HeadRef: "other", Number: 1},
		{ID: "opendatahub-io/odh-dashboard#2", BaseSlug: "opendatahub-io/odh-dashboard", HeadSlug: "mturley/odh-dashboard", HeadRef: "feat", Number: 2},
	}
	got, ok := PickPR(cands, Upstream{Slug: "mturley/odh-dashboard", Merge: "refs/heads/feat"})
	if !ok || got.ID != "opendatahub-io/odh-dashboard#2" {
		t.Fatalf("got %+v ok=%v; want #2", got, ok)
	}
}

func TestPickPRForkRenamedBranch(t *testing.T) {
	cands := []Candidate{
		{ID: "opendatahub-io/odh-dashboard#5", BaseSlug: "opendatahub-io/odh-dashboard", HeadSlug: "sridarna/odh-dashboard", HeadRef: "main", Number: 5},
	}
	got, ok := PickPR(cands, Upstream{Slug: "sridarna/odh-dashboard", Merge: "refs/heads/main"})
	if !ok || got.ID != "opendatahub-io/odh-dashboard#5" {
		t.Fatalf("got %+v ok=%v; want #5", got, ok)
	}
}

func TestPickPRDeletedFork(t *testing.T) {
	cands := []Candidate{
		{ID: "opendatahub-io/odh-dashboard#10598", BaseSlug: "opendatahub-io/odh-dashboard", HeadRef: "gone", Number: 10598},
	}
	got, ok := PickPR(cands, Upstream{Slug: "opendatahub-io/odh-dashboard", Merge: "refs/pull/10598/head"})
	if !ok || got.Number != 10598 {
		t.Fatalf("got %+v ok=%v; want #10598", got, ok)
	}
}

func TestPickPRIgnoresUnrelated(t *testing.T) {
	match := Candidate{ID: "o/r#1", BaseSlug: "o/r", HeadSlug: "me/r", HeadRef: "feat", Number: 1}
	other := Candidate{ID: "o/r#2", Primary: true, UpdatedAt: "2026-12-01T00:00:00Z", BaseSlug: "o/r", HeadSlug: "me/r", HeadRef: "other", Number: 2}
	up := Upstream{Slug: "me/r", Merge: "refs/heads/feat"}
	if got, ok := PickPR([]Candidate{other, match}, up); !ok || got.ID != match.ID {
		t.Fatalf("got %+v ok=%v; want the matching candidate", got, ok)
	}
	if got, ok := PickPR([]Candidate{other}, up); ok {
		t.Fatalf("got %+v; want no match", got)
	}
}

func TestPickPRNoMatchShapes(t *testing.T) {
	c := Candidate{ID: "o/r#1", BaseSlug: "o/r", HeadSlug: "o/r", HeadRef: "feat", Number: 1}
	for _, tc := range []struct {
		name string
		c    Candidate
		up   Upstream
	}{
		{"local remote", c, Upstream{Slug: "", Merge: "refs/heads/feat"}},
		{"local remote, pull ref", c, Upstream{Slug: "", Merge: "refs/pull/1/head"}},
		{"tag", c, Upstream{Slug: "o/r", Merge: "refs/tags/x"}},
		{"empty head ref", Candidate{ID: "o/r#1", BaseSlug: "o/r", HeadSlug: "o/r", Number: 1}, Upstream{Slug: "o/r", Merge: "refs/heads/feat"}},
		{"empty head ref, empty merge branch", Candidate{ID: "o/r#1", BaseSlug: "o/r", HeadSlug: "o/r", Number: 1}, Upstream{Slug: "o/r", Merge: "refs/heads/"}},
	} {
		if got, ok := PickPR([]Candidate{tc.c}, tc.up); ok {
			t.Errorf("%s: got %+v; want no match", tc.name, got)
		}
	}
}

func TestPickPRCaseInsensitive(t *testing.T) {
	cands := []Candidate{{ID: "o/r#1", BaseSlug: "o/r", HeadSlug: "SriDarna/ODH-Dashboard", HeadRef: "main", Number: 1}}
	if _, ok := PickPR(cands, Upstream{Slug: "sridarna/odh-dashboard", Merge: "refs/heads/main"}); !ok {
		t.Fatal("slug comparison should ignore case")
	}
}

func TestPickPRTieBreak(t *testing.T) {
	up := Upstream{Slug: "me/r", Merge: "refs/heads/feat"}
	mk := func(id string, primary bool, updated string) Candidate {
		return Candidate{ID: id, Primary: primary, UpdatedAt: updated, BaseSlug: "o/r", HeadSlug: "me/r", HeadRef: "feat"}
	}
	got, _ := PickPR([]Candidate{mk("related", false, "2026-03-01T00:00:00Z"), mk("primary", true, "2026-01-01T00:00:00Z")}, up)
	if got.ID != "primary" {
		t.Fatalf("primary should win, got %+v", got)
	}
	got, _ = PickPR([]Candidate{mk("old", false, "2026-01-01T00:00:00Z"), mk("new", false, "2026-02-01T00:00:00Z")}, up)
	if got.ID != "new" {
		t.Fatalf("newer should win, got %+v", got)
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
