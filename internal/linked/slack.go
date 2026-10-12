package linked

import (
	"context"
	"fmt"
	"strings"

	"github.com/mturley/watcher"
	"github.com/mturley/watcher/slack"
)

func (b *Builder) buildSlack(ctx context.Context, id string, resolveLinks bool) ([]Section, error) {
	if b.Src.Slack == nil {
		return nil, ErrNotConfigured
	}
	ch, ts, ok := strings.Cut(id, ":")
	if !ok {
		return nil, fmt.Errorf("invalid slack thread id %q", id)
	}
	th, err := b.Src.Slack.Thread(ctx, ch, ts)
	if err != nil {
		return nil, err
	}
	var refs []watcher.LinkRef
	for _, m := range th.Messages {
		// Attachments are unfurls: their "label" is the unfurled page's
		// title, which says nothing about how the message linked it, so only
		// their URLs are kept. Now that a later occurrence can supply a
		// row's context, an unfurl title would otherwise show up as one.
		body := m
		body.Attachments = nil
		refs = append(refs, slack.ExtractLinks(body)...)
		for _, ref := range slack.ExtractLinks(slack.Message{Attachments: m.Attachments}) {
			refs = append(refs, watcher.LinkRef{URL: ref.URL, Label: ref.URL})
		}
	}
	items := ClassifyLinks(refs, Key{"slack", id})
	b.resolve(ctx, items, resolveLinks)
	return []Section{{Kind: "thread", Title: "Linked in thread", Items: items}}, nil
}
