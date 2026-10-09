package linked

import (
	"context"
	"fmt"
	"testing"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/linkmeta"
)

func TestResolveFillsEachType(t *testing.T) {
	b := &Builder{Src: Sources{
		Jira: &fakeJira{issues: map[string]wjira.IssueSummary{
			"PROJ-9": {Key: "PROJ-9", Summary: "Nine", Status: "Review", IssueType: "Story"},
		}},
		PR: &fakePR{prs: map[wgithub.PRRef]wgithub.PRSummary{
			{Owner: "example", Repo: "repo", Number: 2}: {Title: "Two", State: "MERGED"},
		}},
		Slack: &fakeSlack{
			threads:  map[string]slack.Thread{"C0TEST:1700000000.000100": {Messages: []slack.Message{{Text: "  hello\n  world  "}}}},
			channels: map[string]string{"C0TEST": "general"},
		},
		Links: &fakeLinks{meta: map[string]linkmeta.Meta{"https://docs.example.com/a": {Title: "Doc A", Favicon: "https://docs.example.com/f.ico"}}},
	}}
	items := []Item{
		{Type: "pr", ID: "example/repo#2"},
		{Type: "jira", ID: "PROJ-9"},
		{Type: "slack", ID: "C0TEST:1700000000.000100"},
		{Type: "link", ID: "https://docs.example.com/a", Resolved: true},
	}
	b.resolve(context.Background(), items, true)
	if !items[0].Resolved || items[0].Title != "Two" || items[0].State != "MERGED" {
		t.Errorf("pr %+v", items[0])
	}
	if !items[1].Resolved || items[1].Title != "Nine" || items[1].Status != "Review" {
		t.Errorf("jira %+v", items[1])
	}
	if !items[2].Resolved || items[2].ChannelName != "general" || items[2].Excerpt != "hello world" {
		t.Errorf("slack %+v", items[2])
	}
	if items[3].Title != "Doc A" || items[3].Favicon == "" {
		t.Errorf("link %+v", items[3])
	}
}

func TestResolveBadJiraKeyDoesNotSinkBatch(t *testing.T) {
	fj := &fakeJira{issues: map[string]wjira.IssueSummary{"PROJ-1": {Key: "PROJ-1", Summary: "One"}}}
	b := &Builder{Src: Sources{Jira: fj}}
	items := []Item{{Type: "jira", ID: "PROJ-1"}, {Type: "jira", ID: "GONE-1"}}
	b.resolve(context.Background(), items, false)
	if !items[0].Resolved || items[0].Title != "One" {
		t.Errorf("good key must still resolve: %+v", items[0])
	}
	if items[1].Resolved {
		t.Errorf("bad key must be unresolved: %+v", items[1])
	}
}

func TestResolveLinksOnlyWhenAsked(t *testing.T) {
	fl := &fakeLinks{meta: map[string]linkmeta.Meta{}}
	b := &Builder{Src: Sources{Links: fl}}
	b.resolve(context.Background(), []Item{{Type: "link", ID: "https://x.example.com", Resolved: true}}, false)
	if fl.calls != 0 {
		t.Fatalf("resolveLinks=false made %d outbound resolutions", fl.calls)
	}
}

func TestResolveCaps(t *testing.T) {
	fs := &fakeSlack{threads: map[string]slack.Thread{}}
	fl := &fakeLinks{meta: map[string]linkmeta.Meta{}}
	b := &Builder{Src: Sources{Slack: fs, Links: fl}}
	var items []Item
	for i := 0; i < 30; i++ {
		items = append(items, Item{Type: "slack", ID: fmt.Sprintf("C0TEST:1700000000.%06d", i)})
		items = append(items, Item{Type: "link", ID: fmt.Sprintf("https://x.example.com/%d", i), Resolved: true})
	}
	b.resolve(context.Background(), items, true)
	if fs.calls != MaxSlackResolutions || fl.calls != MaxLinkResolutions {
		t.Fatalf("slack calls %d, link calls %d", fs.calls, fl.calls)
	}
}

func TestResolveNilSourcesLeaveItemsUnresolved(t *testing.T) {
	b := &Builder{}
	items := []Item{{Type: "pr", ID: "example/repo#2"}, {Type: "jira", ID: "PROJ-1"}, {Type: "slack", ID: "C0TEST:1.2"}}
	b.resolve(context.Background(), items, true)
	for _, it := range items {
		if it.Resolved {
			t.Errorf("%+v resolved with no source", it)
		}
	}
}
