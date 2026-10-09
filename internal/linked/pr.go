package linked

import (
	"context"
	"fmt"

	wgithub "github.com/mturley/watcher/github"
)

func (b *Builder) buildPR(ctx context.Context, id string, resolveLinks bool) ([]Section, error) {
	if b.Src.PR == nil {
		return nil, ErrNotConfigured
	}
	ref, err := wgithub.ParsePRResourceID(id)
	if err != nil {
		return nil, err
	}
	got, err := b.Src.PR.Summaries(ctx, []wgithub.PRRef{ref})
	if err != nil {
		return nil, err
	}
	pr, ok := got[ref]
	if !ok {
		return nil, fmt.Errorf("pull request %s not found", id)
	}
	desc := ClassifyLinks(ExtractMarkdownLinks(pr.Body), Key{"pr", id})
	b.resolve(ctx, desc, resolveLinks)
	sections := []Section{{Kind: "description", Title: "Linked in description", Items: desc}}

	if b.Src.JiraState != nil {
		refs, err := b.Src.JiraState.IssuesReferencingPR(ctx, id)
		switch {
		case err != nil:
			sections = append(sections, Section{Kind: "referenced_by", Title: "Referenced by Jira", Error: err.Error()})
		case len(refs) > 0:
			sections = append(sections, Section{Kind: "referenced_by", Title: "Referenced by Jira", Items: refs})
		}
	}
	return sections, nil
}
