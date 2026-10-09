package linked

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/linkmeta"
)

type fakeJira struct {
	mu       sync.Mutex
	graphs   map[string]*wjira.LinkGraph
	issues   map[string]wjira.IssueSummary   // for "key in"/"key =" lookups
	children map[string][]wjira.IssueSummary // parent key → children
	failJQL  map[string]bool                 // exact JQL → error
	queries  []string
}

func (f *fakeJira) LinkGraph(_ context.Context, key string) (*wjira.LinkGraph, error) {
	if g, ok := f.graphs[key]; ok {
		return g, nil
	}
	return nil, fmt.Errorf("404 %s", key)
}

func (f *fakeJira) Search(_ context.Context, jql string, max int) ([]wjira.IssueSummary, bool, error) {
	f.mu.Lock()
	f.queries = append(f.queries, jql)
	f.mu.Unlock()
	if f.failJQL[jql] {
		return nil, false, errors.New("jql failed")
	}
	if strings.HasPrefix(jql, "parent = ") {
		key := strings.Fields(strings.TrimPrefix(jql, "parent = "))[0]
		kids := f.children[key]
		if len(kids) > max {
			return kids[:max], true, nil
		}
		return kids, false, nil
	}
	if strings.HasPrefix(jql, "key in (") {
		var out []wjira.IssueSummary
		for _, k := range strings.Split(strings.TrimSuffix(strings.TrimPrefix(jql, "key in ("), ")"), ",") {
			s, ok := f.issues[strings.TrimSpace(k)]
			if !ok {
				// Real Jira rejects the whole query for an unknown key.
				return nil, false, fmt.Errorf("key %s does not exist", k)
			}
			out = append(out, s)
		}
		return out, false, nil
	}
	if strings.HasPrefix(jql, "key = ") {
		if s, ok := f.issues[strings.TrimPrefix(jql, "key = ")]; ok {
			return []wjira.IssueSummary{s}, false, nil
		}
		return nil, false, errors.New("does not exist")
	}
	return nil, false, fmt.Errorf("unexpected jql %q", jql)
}

func (f *fakeJira) IssueURL(key string) string { return "https://example.atlassian.net/browse/" + key }
func (f *fakeJira) SearchURL(jql string) string {
	return "https://example.atlassian.net/issues/?jql=" + jql
}

type fakePR struct {
	prs map[wgithub.PRRef]wgithub.PRSummary
	err error
}

func (f *fakePR) Summaries(_ context.Context, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := map[wgithub.PRRef]wgithub.PRSummary{}
	for _, r := range refs {
		if s, ok := f.prs[r]; ok {
			out[r] = s
		}
	}
	return out, nil
}

type fakeSlack struct {
	threads  map[string]slack.Thread // "C:ts"
	channels map[string]string
	calls    int
	mu       sync.Mutex
}

func (f *fakeSlack) Thread(_ context.Context, ch, ts string) (slack.Thread, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if t, ok := f.threads[ch+":"+ts]; ok {
		return t, nil
	}
	return slack.Thread{}, errors.New("thread_not_found")
}

func (f *fakeSlack) ChannelName(_ context.Context, id string) (string, error) {
	return f.channels[id], nil
}

type fakeLinks struct {
	meta  map[string]linkmeta.Meta
	calls int
	mu    sync.Mutex
}

func (f *fakeLinks) Resolve(_ context.Context, u string) linkmeta.Meta {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return f.meta[u]
}

type fakeState struct {
	byPR map[string][]Item
	err  error
}

func (f *fakeState) IssuesReferencingPR(_ context.Context, prID string) ([]Item, error) {
	return f.byPR[prID], f.err
}
