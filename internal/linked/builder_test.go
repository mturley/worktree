package linked

import (
	"context"
	"errors"
	"testing"
	"time"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
)

var fixedNow = func() time.Time { return time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC) }

func TestBuildPR(t *testing.T) {
	ref := wgithub.PRRef{Owner: "example", Repo: "repo", Number: 1}
	b := &Builder{Now: fixedNow, Src: Sources{
		PR: &fakePR{prs: map[wgithub.PRRef]wgithub.PRSummary{
			ref: {Title: "Me", URL: "https://github.com/example/repo/pull/1",
				Body: "Fixes https://example.atlassian.net/browse/PROJ-9 and https://github.com/example/repo/pull/1 (self)"},
		}},
		Jira:      &fakeJira{issues: map[string]wjira.IssueSummary{"PROJ-9": sum("PROJ-9", "Story", 0)}},
		JiraState: &fakeState{byPR: map[string][]Item{"example/repo#1": {{Type: "jira", ID: "PROJ-7", Resolved: true}}}},
	}}
	r, err := b.Build(context.Background(), "pr", "example/repo#1", false)
	if err != nil {
		t.Fatal(err)
	}
	if r.FetchedAt != "2026-10-09T12:00:00Z" {
		t.Errorf("fetched_at %q", r.FetchedAt)
	}
	d := section(t, r.Sections, "description")
	if d == nil || len(d.Items) != 1 || d.Items[0].ID != "PROJ-9" || !d.Items[0].Resolved {
		t.Errorf("description %+v", d)
	}
	rb := section(t, r.Sections, "referenced_by")
	if rb == nil || rb.Title != "Referenced by Jira" || len(rb.Items) != 1 {
		t.Errorf("referenced_by %+v", rb)
	}
	if r.Count != 2 {
		t.Errorf("count = %d", r.Count)
	}
}

func TestBuildPRNoReverseHitsOmitsSection(t *testing.T) {
	ref := wgithub.PRRef{Owner: "example", Repo: "repo", Number: 1}
	b := &Builder{Src: Sources{PR: &fakePR{prs: map[wgithub.PRRef]wgithub.PRSummary{ref: {}}}, JiraState: &fakeState{}}}
	r, _ := b.Build(context.Background(), "pr", "example/repo#1", false)
	if section(t, r.Sections, "referenced_by") != nil {
		t.Error("empty reverse lookup must be omitted")
	}
}

func TestBuildPRErrors(t *testing.T) {
	if _, err := (&Builder{}).Build(context.Background(), "pr", "example/repo#1", false); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("no PR source: %v", err)
	}
	b := &Builder{Src: Sources{PR: &fakePR{prs: map[wgithub.PRRef]wgithub.PRSummary{}}}}
	if _, err := b.Build(context.Background(), "pr", "example/repo#1", false); err == nil {
		t.Error("missing PR must error")
	}
	if _, err := b.Build(context.Background(), "link", "x", false); !errors.Is(err, ErrUnsupportedType) {
		t.Errorf("link: %v", err)
	}
}

func TestBuildSlack(t *testing.T) {
	b := &Builder{Src: Sources{Slack: &fakeSlack{threads: map[string]slack.Thread{
		"C0TEST:1700000000.000100": {Messages: []slack.Message{
			{Text: "<https://github.com/example/repo/pull/3>"},
			{Text: "<https://example.slack.com/archives/C0TEST/p1700000000000100> and <https://docs.example.com/x>"},
		}},
	}}}}
	r, err := b.Build(context.Background(), "slack", "C0TEST:1700000000.000100", false)
	if err != nil {
		t.Fatal(err)
	}
	s := section(t, r.Sections, "thread")
	if s == nil || s.Title != "Linked in thread" || len(s.Items) != 2 {
		t.Fatalf("thread section %+v (self thread link must be dropped)", s)
	}
	if s.Items[0].Type != "pr" || s.Items[1].Type != "link" {
		t.Errorf("order/types %+v", s.Items)
	}
}

func TestCountExcludesCurrentAndDedupes(t *testing.T) {
	b := &Builder{Src: Sources{Jira: storyFixture()}}
	r, err := b.Build(context.Background(), "jira", "PROJ-1", false)
	if err != nil {
		t.Fatal(err)
	}
	// description PROJ-9; links PROJ-3,4,5; tree FEAT-1, PROJ-8, PROJ-10, PROJ-0, PROJ-7, PROJ-2
	if r.Count != 10 {
		t.Errorf("count = %d", r.Count)
	}
}

func TestBuildSlackIgnoresUnfurlTitlesAsContext(t *testing.T) {
	b := &Builder{Src: Sources{Slack: &fakeSlack{threads: map[string]slack.Thread{
		"C0TEST:1700000000.000100": {Messages: []slack.Message{{
			Text: "<https://github.com/example/repo/pull/3>",
			Attachments: []slack.Attachment{{
				FromURL: "https://github.com/example/repo/pull/3",
				Title:   "Fix the thing · Pull Request #3",
			}},
		}}},
	}}}}
	r, err := b.Build(context.Background(), "slack", "C0TEST:1700000000.000100", false)
	if err != nil {
		t.Fatal(err)
	}
	items := section(t, r.Sections, "thread").Items
	if len(items) != 1 || items[0].Context != nil {
		t.Fatalf("an unfurl title must not become context: %+v", items)
	}
}
