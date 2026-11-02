package webui

import (
	"slices"
	"strconv"

	"github.com/mturley/worktree/internal/attention"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/reviewcomments"
	"github.com/mturley/worktree/internal/selfid"
	"github.com/mturley/worktree/internal/tasks"
	"github.com/mturley/worktree/internal/unread"
)

// attentionEventLimit caps the unread events read per call.
const attentionEventLimit = 500

// AttentionInput gathers the facts attention.Build works from. worktreePath
// narrows the resources and tasks to that worktree; empty means every
// worktree. linkedJira always comes from every resource, so a PR's rank does
// not depend on the scope. Read-only, and usable on a Server that has only a
// DB.
func (s *Server) AttentionInput(worktreePath string) ([]attention.Resource, []attention.OpenTask, map[string][]int, attention.Self, error) {
	all, err := s.AllResources()
	if err != nil {
		return nil, nil, nil, attention.Self{}, err
	}
	self, err := selfid.Load(s.DB)
	if err != nil {
		return nil, nil, nil, attention.Self{}, err
	}
	open, err := tasks.List(s.DB, tasks.Filter{})
	if err != nil {
		return nil, nil, nil, attention.Self{}, err
	}
	unreadEvents, err := s.attentionUnread()
	if err != nil {
		return nil, nil, nil, attention.Self{}, err
	}
	openTasks, err := s.attentionTasks(open, worktreePath)
	if err != nil {
		return nil, nil, nil, attention.Self{}, err
	}

	byResource := map[string][]attention.Task{}
	for _, t := range open {
		for _, l := range t.Links {
			if l.Kind == tasks.LinkResource {
				k := unread.Key(l.ResourceType, l.ResourceID)
				byResource[k] = append(byResource[k], attentionTask(t))
			}
		}
	}

	var scope string
	if worktreePath != "" {
		scope = wdb.Subscriber(worktreePath)
	}
	drafts := s.draftCounter()
	out := []attention.Resource{}
	for _, r := range all {
		paths := make([]string, len(r.Worktrees))
		inScope := scope == ""
		for i, w := range r.Worktrees {
			paths[i] = w.Path
			inScope = inScope || wdb.Subscriber(w.Path) == scope
		}
		if !inScope {
			continue
		}
		key := unread.Key(r.Type, r.ID)
		res := attention.Resource{
			Type: r.Type, ID: r.ID, URL: r.URL,
			Title: r.Title, CustomName: r.CustomName,
			Worktrees: paths,
			State:     r.State, ReviewDecision: r.ReviewDecision, CIStatus: r.CIStatus,
			Assignee: r.Assignee, Status: r.Status, Priority: r.Priority, PriorityRank: r.PriorityRank,
			// UnreadCount also counts the unread events of tasks linking the
			// resource, which clear through each task's own cursor.
			UnreadCount:    r.UnreadCount - r.TaskUnreadCount,
			NewestUnreadTS: r.UnreadThroughTS,
			Unread:         unreadEvents[key],
			Tasks:          byResource[key],
		}
		if res.Title == "" && r.ChannelName != "" {
			res.Title = "#" + r.ChannelName
		}
		// A Slack thread has no through-ts; its unread events are newest first.
		if res.NewestUnreadTS == "" && len(res.Unread) > 0 {
			res.NewestUnreadTS = res.Unread[0].TS
		}
		switch r.Type {
		case "pr":
			res.Mine = selfid.IsMine(self, "github", r.authorID)
			res.ReviewRequestedFromMe = slices.ContainsFunc(r.RequestedReviewerIDs, func(id string) bool {
				return selfid.IsMine(self, "github", id)
			})
			for _, p := range paths {
				res.DraftComments += drafts(p)
			}
		case "jira":
			res.AssignedToMe = selfid.IsMine(self, "jira", r.assigneeID)
		}
		out = append(out, res)
	}
	return out, openTasks, attentionLinkedJira(all), attention.Self{SlackID: self["slack"]}, nil
}

// attentionUnread returns the resources' unread events by unread.Key, newest
// first. It leaves task events out of the query: they belong to no resource,
// and they would use up the limit.
func (s *Server) attentionUnread() (map[string][]attention.Event, error) {
	events, err := s.Timeline(TimelineQuery{
		UnreadOnly:    true,
		Limit:         attentionEventLimit,
		ResourceTypes: []string{"pr", "jira", "slack", "link"},
	})
	if err != nil {
		return nil, err
	}
	out := map[string][]attention.Event{}
	for _, e := range events {
		k := unread.Key(e.ResourceType, e.ResourceID)
		out[k] = append(out[k], attention.Event{
			ID: e.ID, TS: e.TS, Source: e.Source, Type: e.Type,
			Author: e.Author, Title: e.Title, Body: e.Body,
		})
	}
	return out, nil
}

// attentionTasks converts the open tasks in scope: with a path, those whose
// linked or implicit worktrees include it.
func (s *Server) attentionTasks(open []tasks.Task, worktreePath string) ([]attention.OpenTask, error) {
	cursors, err := unread.Cursors(s.DB)
	if err != nil {
		return nil, err
	}
	var scope string
	if worktreePath != "" {
		scope, _ = wdb.WorktreePathFromSubscriber(wdb.Subscriber(worktreePath))
	}
	out := []attention.OpenTask{}
	for _, t := range open {
		worktrees := slices.Clone(t.Implicit)
		for _, l := range t.Links {
			if l.Kind == tasks.LinkWorktree && !l.Archived {
				worktrees = append(worktrees, l.Worktree)
			}
		}
		slices.Sort(worktrees)
		worktrees = slices.Compact(worktrees)
		if scope != "" && !slices.Contains(worktrees, scope) {
			continue
		}
		cursor := cursors[unread.Key(taskResourceType, strconv.FormatInt(t.ID, 10))]
		unblocked, err := s.taskUnblockedSince(t.ID, cursor)
		if err != nil {
			return nil, err
		}
		out = append(out, attention.OpenTask{
			Task:            attentionTask(t),
			Worktrees:       worktrees,
			UnblockedUnread: unblocked,
			UpdatedAt:       t.UpdatedAt,
		})
	}
	return out, nil
}

// taskUnblockedSince reports whether the task has an automatic blocker
// resolution newer than cursor. FeedQuery's SinceTS is inclusive, a cursor is
// not; no cursor means every event counts, as in unread.TaskSummaries.
func (s *Server) taskUnblockedSince(id int64, cursor string) (bool, error) {
	events, err := tasks.FeedEvents(s.DB, tasks.FeedQuery{
		TaskIDs:          []int64{id},
		UnreadActorsOnly: true,
		SinceTS:          cursor,
	})
	if err != nil {
		return false, err
	}
	return slices.ContainsFunc(events, func(e tasks.FeedEvent) bool {
		return e.TS > cursor && isUnblockEvent(e)
	}), nil
}

func attentionTask(t tasks.Task) attention.Task {
	return attention.Task{
		ID:       strconv.FormatInt(t.ID, 10),
		Title:    t.Title,
		State:    string(t.State),
		Priority: string(t.Priority),
		Due:      t.Due,
	}
}

// draftCounter returns a function counting a worktree's draft review
// comments, reading each worktree once. A failure is logged and counts 0.
func (s *Server) draftCounter() func(path string) int {
	counts := map[string]int{}
	return func(path string) int {
		if n, ok := counts[path]; ok {
			return n
		}
		cs, err := reviewcomments.List(s.DB, path)
		if err != nil {
			s.logger().Printf("reviewcomments.List(%s): %v", path, err)
		}
		counts[path] = len(cs)
		return len(cs)
	}
}

// attentionLinkedJira maps each PR key ("pr:<id>") to the priority ranks of
// the Jira issues sharing a worktree with it.
func attentionLinkedJira(all []AllResource) map[string][]int {
	ranks := map[string][]int{}
	for _, r := range all {
		if r.Type == "jira" && r.PriorityRank != nil {
			for _, w := range r.Worktrees {
				ranks[w.Path] = append(ranks[w.Path], *r.PriorityRank)
			}
		}
	}
	out := map[string][]int{}
	for _, r := range all {
		if r.Type != "pr" {
			continue
		}
		for _, w := range r.Worktrees {
			if rs := ranks[w.Path]; len(rs) > 0 {
				out["pr:"+r.ID] = append(out["pr:"+r.ID], rs...)
			}
		}
	}
	return out
}
