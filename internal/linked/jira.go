package linked

import (
	"context"
	"sync"

	wjira "github.com/mturley/watcher/jira"
)

func childrenJQL(key string) string { return "parent = " + key + " ORDER BY key ASC" }

func boolPtr(b bool) *bool { return &b }

// unknownChildren: sub-tasks can't have children; anything else might.
func unknownChildren(s wjira.IssueSummary) *bool {
	if s.HierarchyLevel < 0 {
		return boolPtr(false)
	}
	return nil
}

func (b *Builder) node(s wjira.IssueSummary) *TreeNode {
	return &TreeNode{Item: jiraItem(s, b.Src.Jira.IssueURL(s.Key)), HasChildren: unknownChildren(s)}
}

func (b *Builder) buildJira(ctx context.Context, key string, resolveLinks bool) ([]Section, error) {
	if b.Src.Jira == nil {
		return nil, ErrNotConfigured
	}
	g, err := b.Src.Jira.LinkGraph(ctx, key)
	if err != nil {
		return nil, err
	}
	self := Key{"jira", g.Issue.Key}
	var sections []Section

	gitPR := Classify(g.GitPRURLs, self)
	desc := Classify(g.DescriptionURLs, self)
	// One resolve pass over both, so linked keys are batched together.
	all := append(append([]Item{}, gitPR...), desc...)
	b.resolve(ctx, all, resolveLinks)
	gitPR, desc = all[:len(gitPR)], all[len(gitPR):]

	if len(gitPR) > 0 {
		sections = append(sections, Section{Kind: "git_pr", Title: "Git Pull Request", Items: gitPR})
	}
	sections = append(sections, Section{Kind: "description", Title: "Linked in description", Items: desc})
	sections = append(sections, b.hierarchy(ctx, g))
	sections = append(sections, b.linkGroups(g))
	return sections, nil
}

func (b *Builder) linkGroups(g *wjira.LinkGraph) Section {
	s := Section{Kind: "links", Title: "Linked work items"}
	pos := map[string]int{}
	for _, l := range g.Links {
		i, ok := pos[l.Label]
		if !ok {
			i = len(s.Groups)
			pos[l.Label] = i
			s.Groups = append(s.Groups, Group{Label: l.Label})
		}
		s.Groups[i].Items = append(s.Groups[i].Items, jiraItem(l.Issue, b.Src.Jira.IssueURL(l.Issue.Key)))
	}
	return s
}

type childResult struct {
	kids []wjira.IssueSummary
	more bool
	err  error
}

// hierarchy builds: root ancestor → … → parent → [siblings incl. current] →
// current's children. Every ancestor on the path is expanded with ALL its
// children listed (other branches collapsed, lazily expandable). Searches
// run concurrently; a failed one keeps the path and sets the section error.
func (b *Builder) hierarchy(ctx context.Context, g *wjira.LinkGraph) Section {
	sec := Section{Kind: "hierarchy", Title: "Hierarchy"}

	// parentKeys[0] is the current issue; then each ancestor.
	parentKeys := []string{g.Issue.Key}
	for _, a := range g.Ancestors {
		parentKeys = append(parentKeys, a.Key)
	}
	results := make([]childResult, len(parentKeys))
	var wg sync.WaitGroup
	for i, k := range parentKeys {
		wg.Add(1)
		go func(i int, k string) {
			defer wg.Done()
			kids, more, err := b.Src.Jira.Search(ctx, childrenJQL(k), MaxChildren)
			results[i] = childResult{kids, more, err}
		}(i, k)
	}
	wg.Wait()

	// The current issue and its children (search results ∪ subtasks).
	cur := b.node(g.Issue)
	cur.Current, cur.Expanded = true, true
	seen := map[string]bool{}
	addKid := func(s wjira.IssueSummary) {
		if !seen[s.Key] {
			seen[s.Key] = true
			cur.Children = append(cur.Children, b.node(s))
		}
	}
	if results[0].err != nil {
		sec.Error = "Couldn't load child issues: " + results[0].err.Error()
	} else {
		for _, s := range results[0].kids {
			addKid(s)
		}
		if results[0].more {
			cur.More = &More{URL: b.Src.Jira.SearchURL(childrenJQL(g.Issue.Key))}
		}
	}
	for _, s := range g.Subtasks {
		addKid(s)
	}
	cur.HasChildren = boolPtr(len(cur.Children) > 0)

	// Walk upward, wrapping the path node in each ancestor.
	path := cur
	for i, a := range g.Ancestors {
		anc := b.node(a)
		anc.Expanded = true
		r := results[i+1]
		placed := false
		if r.err != nil {
			if sec.Error == "" {
				sec.Error = "Couldn't load some of the hierarchy: " + r.err.Error()
			}
		} else {
			for _, s := range r.kids {
				if s.Key == path.ID {
					anc.Children = append(anc.Children, path)
					placed = true
				} else {
					anc.Children = append(anc.Children, b.node(s))
				}
			}
			if r.more {
				anc.More = &More{URL: b.Src.Jira.SearchURL(childrenJQL(a.Key))}
			}
		}
		if !placed {
			// Capped out of, or missing from, the search: the path must show.
			anc.Children = append(anc.Children, path)
		}
		anc.HasChildren = boolPtr(true)
		path = anc
	}
	sec.Tree = []*TreeNode{path}
	return sec
}

// Children lists an issue's children for a lazily expanded tree node.
func (b *Builder) Children(ctx context.Context, key string) ([]*TreeNode, *More, error) {
	if b.Src.Jira == nil {
		return nil, nil, ErrNotConfigured
	}
	kids, more, err := b.Src.Jira.Search(ctx, childrenJQL(key), MaxChildren)
	if err != nil {
		return nil, nil, err
	}
	out := make([]*TreeNode, 0, len(kids))
	for _, s := range kids {
		out = append(out, b.node(s))
	}
	var m *More
	if more {
		m = &More{URL: b.Src.Jira.SearchURL(childrenJQL(key))}
	}
	return out, m, nil
}
