package linked

import (
	"context"
	"strings"
	"sync"
	"time"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
)

const (
	MaxChildren         = 50
	MaxSlackResolutions = 20
	MaxLinkResolutions  = 20
	resolveConcurrency  = 4
	excerptRunes        = 100
)

// Builder assembles Results from Sources.
type Builder struct {
	Src Sources
	Now func() time.Time
}

func (b *Builder) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

// resolve enriches items in place, batching per source. Failures leave an
// item unresolved rather than failing the view: a linked issue you can't
// see is still worth listing.
func (b *Builder) resolve(ctx context.Context, items []Item, resolveLinks bool) {
	var jiraIdx, prIdx, slackIdx, linkIdx []int
	for i, it := range items {
		switch it.Type {
		case "jira":
			jiraIdx = append(jiraIdx, i)
		case "pr":
			prIdx = append(prIdx, i)
		case "slack":
			slackIdx = append(slackIdx, i)
		case "link":
			linkIdx = append(linkIdx, i)
		}
	}
	var wg sync.WaitGroup
	if b.Src.Jira != nil && len(jiraIdx) > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); b.resolveJira(ctx, items, jiraIdx) }()
	}
	if b.Src.PR != nil && len(prIdx) > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); b.resolvePRs(ctx, items, prIdx) }()
	}
	if b.Src.Slack != nil && len(slackIdx) > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); b.resolveSlack(ctx, items, capIdx(slackIdx, MaxSlackResolutions)) }()
	}
	if resolveLinks && b.Src.Links != nil && len(linkIdx) > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); b.resolveLinks(ctx, items, capIdx(linkIdx, MaxLinkResolutions)) }()
	}
	wg.Wait()
}

func capIdx(idx []int, n int) []int {
	if len(idx) > n {
		return idx[:n]
	}
	return idx
}

// forEachLimited runs fn over idx with at most resolveConcurrency in flight.
func forEachLimited(idx []int, fn func(i int)) {
	sem := make(chan struct{}, resolveConcurrency)
	var wg sync.WaitGroup
	for _, i := range idx {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(i)
		}(i)
	}
	wg.Wait()
}

func (b *Builder) resolveJira(ctx context.Context, items []Item, idx []int) {
	keys := make([]string, len(idx))
	for n, i := range idx {
		keys[n] = items[i].ID
	}
	apply := func(found []wjira.IssueSummary) {
		byKey := map[string]wjira.IssueSummary{}
		for _, s := range found {
			byKey[s.Key] = s
		}
		for _, i := range idx {
			if s, ok := byKey[items[i].ID]; ok {
				url := items[i].URL
				if url == "" {
					url = b.Src.Jira.IssueURL(s.Key)
				}
				items[i] = jiraItem(s, url)
			}
		}
	}
	found, _, err := b.Src.Jira.Search(ctx, "key in ("+strings.Join(keys, ",")+")", len(keys))
	if err == nil {
		apply(found)
		return
	}
	// One unknown or invisible key fails the whole "key in" query, so fall
	// back to one search per key; bad keys just stay unresolved.
	var mu sync.Mutex
	var all []wjira.IssueSummary
	forEachLimited(idx, func(i int) {
		got, _, err := b.Src.Jira.Search(ctx, "key = "+items[i].ID, 1)
		if err == nil {
			mu.Lock()
			all = append(all, got...)
			mu.Unlock()
		}
	})
	apply(all)
}

func (b *Builder) resolvePRs(ctx context.Context, items []Item, idx []int) {
	refs := make([]wgithub.PRRef, 0, len(idx))
	refOf := map[int]wgithub.PRRef{}
	for _, i := range idx {
		ref, err := wgithub.ParsePRResourceID(items[i].ID)
		if err != nil {
			continue
		}
		refs = append(refs, ref)
		refOf[i] = ref
	}
	got, err := b.Src.PR.Summaries(ctx, refs)
	if err != nil {
		return
	}
	for i, ref := range refOf {
		if s, ok := got[ref]; ok {
			items[i].Resolved = true
			items[i].Title = s.Title
			items[i].State = s.State
			items[i].IsDraft = s.IsDraft
		}
	}
}

func (b *Builder) resolveSlack(ctx context.Context, items []Item, idx []int) {
	forEachLimited(idx, func(i int) {
		ch, ts, ok := strings.Cut(items[i].ID, ":")
		if !ok {
			return
		}
		th, err := b.Src.Slack.Thread(ctx, ch, ts)
		if err != nil || len(th.Messages) == 0 {
			return
		}
		name, _ := b.Src.Slack.ChannelName(ctx, ch)
		items[i].Resolved = true
		items[i].ChannelName = name
		items[i].Excerpt = excerpt(th.Messages[0].Text, excerptRunes)
	})
}

func (b *Builder) resolveLinks(ctx context.Context, items []Item, idx []int) {
	forEachLimited(idx, func(i int) {
		u := items[i].URL
		if u == "" {
			u = items[i].ID // a link's ID is its URL
		}
		m := b.Src.Links.Resolve(ctx, u)
		if m.Title != "" {
			items[i].Title = m.Title
		}
		items[i].Favicon = m.Favicon
	})
}

// excerpt collapses whitespace and truncates to n runes with an ellipsis.
func excerpt(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n-1])) + "…"
}
