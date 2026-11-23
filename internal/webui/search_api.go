package webui

import (
	"errors"
	"sort"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/tasks"
)

// SearchQuery is what `worktree search` asks. It mirrors the search bar's
// dropdown (ui/src/components/search/suggestions.ts) with larger limits.
type SearchQuery struct {
	Query        string
	WorktreePath string   // "" = all worktrees
	Sources      []string // internal types: pr, jira, slack, task, link; empty = all
	Since        string   // RFC 3339; events only
	UnreadOnly   bool
	Archived     bool
	HumansOnly   bool
	EventTypes   []string
	Limits       SearchLimits // zero fields take the defaults 10/10/10/20
}

// SearchLimits caps each group; a zero field takes the default.
type SearchLimits struct{ Worktrees, Resources, Tasks, Events int }

const (
	defaultSearchWorktrees = 10
	defaultSearchResources = 10
	defaultSearchTasks     = 10
	defaultSearchEvents    = 20
)

// SearchResult is the grouped answer. Events carry no bodies.
type SearchResult struct {
	Terms     []string            `json:"terms"`
	Worktrees []SearchWorktreeHit `json:"worktrees"` // nil when scoped
	Resources []SearchResourceHit `json:"resources"`
	Tasks     []SearchTaskHit     `json:"tasks"` // nil when scoped or the tasks group is off
	Events    []SearchEventHit    `json:"events"`
}

type SearchWorktreeHit struct {
	Path   string       `json:"path"`
	Repo   string       `json:"repo"`
	Branch string       `json:"branch"`
	Match  *searchMatch `json:"match,omitempty"`
}

type SearchResourceHit struct {
	Type           string       `json:"type"`
	ID             string       `json:"id"`
	URL            string       `json:"url"`
	CustomName     string       `json:"custom_name,omitempty"`
	Title          string       `json:"title,omitempty"`
	ChannelName    string       `json:"channel_name,omitempty"`
	Status         string       `json:"status,omitempty"`
	State          string       `json:"state,omitempty"`
	Author         string       `json:"author,omitempty"`
	Assignee       string       `json:"assignee,omitempty"`
	Archived       bool         `json:"archived"`
	Unread         bool         `json:"unread"`
	Worktrees      []string     `json:"worktrees"` // paths
	LastFollowedBy []string     `json:"last_followed_by,omitempty"`
	Match          *searchMatch `json:"match,omitempty"`
}

type SearchTaskHit struct {
	ID        int64        `json:"id"`
	Ref       string       `json:"ref"`
	Title     string       `json:"title"`
	State     string       `json:"state"`
	Archived  bool         `json:"archived"`
	Worktrees []string     `json:"worktrees"`
	Match     *searchMatch `json:"match,omitempty"`
}

type SearchEventResource struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	URL        string `json:"url"`
	CustomName string `json:"custom_name,omitempty"`
	Title      string `json:"title,omitempty"`
}

type SearchEventHit struct {
	ID       string              `json:"id"`
	TS       string              `json:"ts"`
	Source   string              `json:"source"`
	Type     string              `json:"type"`
	Title    string              `json:"title"`
	Author   string              `json:"author"`
	Unread   bool                `json:"unread"`
	Resource SearchEventResource `json:"resource"`
	Match    *searchMatch        `json:"match,omitempty"`
}

// ErrEmptyQuery is returned for a query with no terms.
var ErrEmptyQuery = errors.New("search needs at least one term")

func (l SearchLimits) withDefaults() SearchLimits {
	if l.Worktrees <= 0 {
		l.Worktrees = defaultSearchWorktrees
	}
	if l.Resources <= 0 {
		l.Resources = defaultSearchResources
	}
	if l.Tasks <= 0 {
		l.Tasks = defaultSearchTasks
	}
	if l.Events <= 0 {
		l.Events = defaultSearchEvents
	}
	return l
}

// Search answers the search bar's question for the CLI: the matching
// worktrees, resources, tasks and events, grouped and ranked as the
// dropdown's buildSuggestions does. Read-only; works on a Server with only a
// DB.
func (s *Server) Search(q SearchQuery) (SearchResult, error) {
	terms := parseSearchTerms(q.Query)
	if len(terms) == 0 {
		return SearchResult{}, ErrEmptyQuery
	}
	lim := q.Limits.withDefaults()
	scoped := q.WorktreePath != ""
	archived := q.Archived && !scoped
	srcOK := func(typ string) bool { return len(q.Sources) == 0 || containsString(q.Sources, typ) }
	out := SearchResult{Terms: terms}

	// Resources (and the per-worktree resource lists the worktree group matches through).
	type cand struct {
		r     *resourceDTO
		hit   SearchResourceHit
		order int
	}
	var rcs []cand
	byWorktree := map[string][]resourceDTO{}
	if scoped {
		rs, err := s.WorktreeResources(q.WorktreePath)
		if err != nil {
			return out, err
		}
		for i := range rs {
			rcs = append(rcs, cand{r: &rs[i], hit: resourceHit(&rs[i], false, []string{q.WorktreePath}, nil)})
		}
	} else {
		all, err := s.AllResources()
		if err != nil {
			return out, err
		}
		for i := range all {
			var paths []string
			for _, w := range all[i].Worktrees {
				paths = append(paths, w.Path)
				byWorktree[w.Path] = append(byWorktree[w.Path], all[i].resourceDTO)
			}
			rcs = append(rcs, cand{r: &all[i].resourceDTO, hit: resourceHit(&all[i].resourceDTO, false, paths, nil)})
		}
		if archived {
			arch, err := s.ArchivedResources()
			if err != nil {
				return out, err
			}
			for i := range arch {
				var last []string
				for _, w := range arch[i].LastFollowedBy {
					last = append(last, w.Path)
				}
				rcs = append(rcs, cand{r: &arch[i].resourceDTO, hit: resourceHit(&arch[i].resourceDTO, true, []string{}, last)})
			}
		}
	}
	type ranked struct {
		hit  SearchResourceHit
		rank int
		i    int
	}
	var rr []ranked
	for i, c := range rcs {
		if !srcOK(c.r.Type) {
			continue
		}
		if q.UnreadOnly && c.r.UnreadCount <= 0 && !c.r.HasUnread {
			continue
		}
		m := matchResource(c.r, terms)
		if m == nil {
			continue
		}
		c.hit.Match = m
		rr = append(rr, ranked{c.hit, rankResource(c.r, terms), i})
	}
	sort.SliceStable(rr, func(a, b int) bool { return rr[a].rank < rr[b].rank })
	out.Resources = []SearchResourceHit{}
	for _, r := range rr {
		if len(out.Resources) >= lim.Resources {
			break
		}
		out.Resources = append(out.Resources, r.hit)
	}

	if !scoped {
		wts, err := s.WorktreeSummaries()
		if err != nil {
			return out, err
		}
		titles := s.workspaceTitlesByPath(wts)
		type wr struct {
			hit  SearchWorktreeHit
			rank int
		}
		var ws []wr
		for i := range wts {
			w := &wts[i]
			if q.UnreadOnly && !w.HasUnread {
				continue
			}
			var via []resourceDTO
			for _, r := range byWorktree[w.Path] {
				if srcOK(r.Type) {
					via = append(via, r)
				}
			}
			m := matchWorktree(w, titles[w.Path], via, terms)
			if m == nil {
				continue
			}
			ws = append(ws, wr{SearchWorktreeHit{Path: w.Path, Repo: w.Repo, Branch: w.Branch, Match: m}, rankText(w.Branch, terms)})
		}
		sort.SliceStable(ws, func(a, b int) bool { return ws[a].rank < ws[b].rank })
		out.Worktrees = []SearchWorktreeHit{}
		for _, w := range ws {
			if len(out.Worktrees) >= lim.Worktrees {
				break
			}
			out.Worktrees = append(out.Worktrees, w.hit)
		}

		if !q.UnreadOnly && srcOK("task") {
			ts, err := tasks.List(s.DB, tasks.Filter{IncludeCompleted: true, IncludeArchived: q.Archived})
			if err != nil {
				return out, err
			}
			type tr struct {
				hit  SearchTaskHit
				rank int
			}
			var trs []tr
			for _, t := range ts {
				m := matchTask(t, terms)
				if m == nil {
					continue
				}
				rank := rankTask(t, terms)
				if t.State == tasks.StateDone {
					rank += 10
				}
				trs = append(trs, tr{SearchTaskHit{
					ID: t.ID, Ref: taskRef(t), Title: t.Title, State: string(t.State),
					Archived: t.Archived, Worktrees: taskPaths(t), Match: m,
				}, rank})
			}
			sort.SliceStable(trs, func(a, b int) bool { return trs[a].rank < trs[b].rank })
			out.Tasks = []SearchTaskHit{}
			for _, t := range trs {
				if len(out.Tasks) >= lim.Tasks {
					break
				}
				out.Tasks = append(out.Tasks, t.hit)
			}
		}
	}

	evs, err := s.Timeline(TimelineQuery{
		WorktreePath: q.WorktreePath, ResourceTypes: q.Sources, Since: q.Since,
		UnreadOnly: q.UnreadOnly, Limit: lim.Events, Archived: archived,
		HumansOnly: q.HumansOnly, Query: q.Query, EventTypes: q.EventTypes,
	})
	if err != nil {
		return out, err
	}
	out.Events = []SearchEventHit{}
	for _, e := range evs {
		if len(out.Events) >= lim.Events {
			break
		}
		h := SearchEventHit{
			ID: e.ID, TS: e.TS, Source: e.Source, Type: e.Type, Title: e.Title, Author: e.Author,
			Unread: e.Unread, Match: e.Match,
			Resource: SearchEventResource{Type: e.ResourceType, ID: e.ResourceID, URL: e.ResourceURL, Title: e.ResourceTitle},
		}
		if e.Resource != nil {
			h.Resource.CustomName = e.Resource.CustomName
			h.Resource.Title = e.Resource.Title
		}
		out.Events = append(out.Events, h)
	}
	return out, nil
}

func resourceHit(r *resourceDTO, archived bool, paths, last []string) SearchResourceHit {
	return SearchResourceHit{
		Type: r.Type, ID: r.ID, URL: r.URL, CustomName: r.CustomName, Title: r.Title,
		ChannelName: r.ChannelName, Status: r.Status, State: r.State, Author: r.Author,
		Assignee: r.Assignee, Archived: archived, Unread: r.UnreadCount > 0 || r.HasUnread,
		Worktrees: paths, LastFollowedBy: last,
	}
}

// taskPaths is taskWorktreePaths in suggestions.ts: live worktree links, then
// the worktrees following its resource links, each once.
func taskPaths(t tasks.Task) []string {
	out := []string{}
	seen := map[string]bool{}
	add := func(p string) {
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	for _, l := range t.Links {
		if l.Kind == tasks.LinkWorktree && !l.Archived {
			add(l.Worktree)
		}
	}
	for _, p := range t.Implicit {
		add(p)
	}
	return out
}

// workspaceTitlesByPath maps worktree path to its cmux workspace titles. It
// asks cmux only when cmux features are enabled, and any error means no
// titles: search never fails over cmux.
func (s *Server) workspaceTitlesByPath(wts []worktreeSummary) map[string][]string {
	out := map[string][]string{}
	if !s.cmuxEnabled() {
		return out
	}
	ws, err := s.listCmuxWorkspaces()
	if err != nil {
		return out
	}
	paths := make([]string, 0, len(wts))
	for _, w := range wts {
		paths = append(paths, w.Path)
	}
	for p, hits := range cmux.Match(ws, paths) {
		for _, h := range hits {
			out[p] = append(out[p], h.DisplayTitle())
		}
	}
	return out
}

func containsString(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
