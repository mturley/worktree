package linked

import (
	"context"
	"errors"
	"time"
)

// ErrUnsupportedType: only PRs, Jira issues and Slack threads have links.
var ErrUnsupportedType = errors.New("linked resources are only available for pr, jira and slack")

// Build assembles the Linked Resources view for one resource. resolveLinks
// gates outbound fetches of arbitrary pages (plain-link titles); it is only
// set once the user opens the tab.
func (b *Builder) Build(ctx context.Context, resType, id string, resolveLinks bool) (*Result, error) {
	var sections []Section
	var err error
	switch resType {
	case "jira":
		sections, err = b.buildJira(ctx, id, resolveLinks)
	case "pr":
		sections, err = b.buildPR(ctx, id, resolveLinks)
	case "slack":
		sections, err = b.buildSlack(ctx, id, resolveLinks)
	default:
		return nil, ErrUnsupportedType
	}
	if err != nil {
		return nil, err
	}
	return &Result{
		FetchedAt: b.now().UTC().Format(time.RFC3339),
		Count:     count(sections),
		Sections:  sections,
	}, nil
}

// count is the number of distinct linked resources across every section,
// excluding the current issue in the hierarchy.
func count(sections []Section) int {
	seen := map[Key]bool{}
	add := func(it Item) { seen[Key{it.Type, it.ID}] = true }
	var walk func(n *TreeNode)
	walk = func(n *TreeNode) {
		if !n.Current {
			add(n.Item)
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	for _, s := range sections {
		for _, it := range s.Items {
			add(it)
		}
		for _, g := range s.Groups {
			for _, it := range g.Items {
				add(it)
			}
		}
		for _, n := range s.Tree {
			walk(n)
		}
	}
	return len(seen)
}
