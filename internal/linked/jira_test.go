package linked

import (
	"context"
	"testing"

	wjira "github.com/mturley/watcher/jira"
)

func sum(key, typ string, level int) wjira.IssueSummary {
	return wjira.IssueSummary{Key: key, Summary: "S " + key, Status: "New", IssueType: typ, HierarchyLevel: level}
}

func storyFixture() *fakeJira {
	return &fakeJira{
		graphs: map[string]*wjira.LinkGraph{
			"PROJ-1": {
				Issue:     sum("PROJ-1", "Story", 0),
				Ancestors: []wjira.IssueSummary{sum("PROJ-10", "Epic", 1), sum("FEAT-1", "Feature", 2)},
				Subtasks:  []wjira.IssueSummary{sum("PROJ-2", "Sub-task", -1)},
				Links: []wjira.IssueLink{
					{Label: "blocks", Issue: sum("PROJ-3", "Bug", 0)},
					{Label: "clones", Issue: sum("PROJ-4", "Story", 0)},
					{Label: "blocks", Issue: sum("PROJ-5", "Task", 0)},
				},
				DescriptionURLs: []string{"https://example.atlassian.net/browse/PROJ-9", "https://example.atlassian.net/browse/PROJ-1"},
				GitPRURLs:       []string{},
			},
		},
		issues: map[string]wjira.IssueSummary{"PROJ-9": sum("PROJ-9", "Story", 0)},
		children: map[string][]wjira.IssueSummary{
			"PROJ-1":  {sum("PROJ-2", "Sub-task", -1)},
			"PROJ-10": {sum("PROJ-0", "Story", 0), sum("PROJ-1", "Story", 0), sum("PROJ-7", "Story", 0)},
			"FEAT-1":  {sum("PROJ-8", "Epic", 1), sum("PROJ-10", "Epic", 1)},
		},
	}
}

func section(t *testing.T, ss []Section, kind string) *Section {
	t.Helper()
	for i := range ss {
		if ss[i].Kind == kind {
			return &ss[i]
		}
	}
	return nil
}

func TestBuildJiraSections(t *testing.T) {
	b := &Builder{Src: Sources{Jira: storyFixture()}}
	ss, err := b.buildJira(context.Background(), "PROJ-1", false)
	if err != nil {
		t.Fatal(err)
	}
	if section(t, ss, "git_pr") != nil {
		t.Error("empty Git PR field must omit the section")
	}
	d := section(t, ss, "description")
	if d == nil || len(d.Items) != 1 || d.Items[0].ID != "PROJ-9" || !d.Items[0].Resolved {
		t.Errorf("description = %+v (self link must be dropped)", d)
	}
	l := section(t, ss, "links")
	if l == nil || len(l.Groups) != 2 || l.Groups[0].Label != "blocks" || len(l.Groups[0].Items) != 2 || l.Groups[1].Label != "clones" {
		t.Errorf("links = %+v", l)
	}
	if l.Groups[0].Items[0].URL != "https://example.atlassian.net/browse/PROJ-3" {
		t.Errorf("link url = %q", l.Groups[0].Items[0].URL)
	}
}

func TestBuildJiraHierarchy(t *testing.T) {
	b := &Builder{Src: Sources{Jira: storyFixture()}}
	ss, _ := b.buildJira(context.Background(), "PROJ-1", false)
	h := section(t, ss, "hierarchy")
	if h == nil || len(h.Tree) != 1 {
		t.Fatalf("hierarchy = %+v", h)
	}
	feat := h.Tree[0]
	if feat.ID != "FEAT-1" || !feat.Expanded || len(feat.Children) != 2 {
		t.Fatalf("root = %+v", feat)
	}
	other, epic := feat.Children[0], feat.Children[1]
	if other.ID != "PROJ-8" || other.Expanded || other.HasChildren != nil {
		t.Errorf("sibling epic should be collapsed/unknown: %+v", other)
	}
	if epic.ID != "PROJ-10" || !epic.Expanded || len(epic.Children) != 3 {
		t.Fatalf("epic = %+v", epic)
	}
	cur := epic.Children[1]
	if cur.ID != "PROJ-1" || !cur.Current || !cur.Expanded || len(cur.Children) != 1 || cur.Children[0].ID != "PROJ-2" {
		t.Errorf("current = %+v", cur)
	}
	if cur.Children[0].HasChildren == nil || *cur.Children[0].HasChildren {
		t.Errorf("a sub-task has no children: %+v", cur.Children[0])
	}
	if epic.Children[0].Current || epic.Children[2].Current {
		t.Error("only one node is current")
	}
}

func TestBuildJiraHierarchyNoParent(t *testing.T) {
	fj := &fakeJira{graphs: map[string]*wjira.LinkGraph{"PROJ-1": {Issue: sum("PROJ-1", "Task", 0)}},
		children: map[string][]wjira.IssueSummary{}}
	b := &Builder{Src: Sources{Jira: fj}}
	ss, _ := b.buildJira(context.Background(), "PROJ-1", false)
	h := section(t, ss, "hierarchy")
	if len(h.Tree) != 1 || !h.Tree[0].Current || h.Tree[0].HasChildren == nil || *h.Tree[0].HasChildren {
		t.Errorf("tree = %+v", h.Tree[0])
	}
}

func TestBuildJiraHierarchySearchErrorKeepsPath(t *testing.T) {
	fj := storyFixture()
	fj.failJQL = map[string]bool{"parent = PROJ-10 ORDER BY key ASC": true}
	b := &Builder{Src: Sources{Jira: fj}}
	ss, _ := b.buildJira(context.Background(), "PROJ-1", false)
	h := section(t, ss, "hierarchy")
	if h.Error == "" {
		t.Error("a failed sibling search must surface as a section error")
	}
	epic := h.Tree[0].Children[1]
	if len(epic.Children) != 1 || epic.Children[0].ID != "PROJ-1" {
		t.Errorf("path must still render: %+v", epic.Children)
	}
}

func TestBuildJiraChildrenCap(t *testing.T) {
	fj := storyFixture()
	var many []wjira.IssueSummary
	for i := 0; i < MaxChildren+5; i++ {
		many = append(many, sum("KID-"+string(rune('A'+i%26))+string(rune('a'+i/26)), "Story", 0))
	}
	fj.children["PROJ-10"] = append([]wjira.IssueSummary{sum("PROJ-1", "Story", 0)}, many...)
	b := &Builder{Src: Sources{Jira: fj}}
	ss, _ := b.buildJira(context.Background(), "PROJ-1", false)
	epic := section(t, ss, "hierarchy").Tree[0].Children[1]
	if epic.More == nil || epic.More.URL == "" {
		t.Errorf("capped node needs a More link: %+v", epic.More)
	}
	if len(epic.Children) != MaxChildren {
		t.Errorf("children = %d", len(epic.Children))
	}
}

func TestChildren(t *testing.T) {
	b := &Builder{Src: Sources{Jira: storyFixture()}}
	kids, more, err := b.Children(context.Background(), "FEAT-1")
	if err != nil || more != nil || len(kids) != 2 || kids[0].ID != "PROJ-8" || kids[0].URL == "" {
		t.Fatalf("kids=%+v more=%v err=%v", kids, more, err)
	}
}

func TestBuildJiraGraphErrorIsFatal(t *testing.T) {
	b := &Builder{Src: Sources{Jira: &fakeJira{}}}
	if _, err := b.buildJira(context.Background(), "NOPE-1", false); err == nil {
		t.Fatal("want error")
	}
	if _, err := (&Builder{}).buildJira(context.Background(), "PROJ-1", false); err != ErrNotConfigured {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
}
