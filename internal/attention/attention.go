// Package attention computes what deserves the user's attention from facts
// its caller has already gathered: named signals and a fixed order, no
// judgment. Pure: no DB, no network. See webui.Server.AttentionInput for the
// gathering and `worktree attention` for the output.
package attention

import (
	"cmp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// Resource is one followed resource and what is known about it.
type Resource struct {
	Type       string   `json:"type"`
	ID         string   `json:"id"`
	URL        string   `json:"url,omitempty"`
	Title      string   `json:"title,omitempty"`
	CustomName string   `json:"custom_name,omitempty"`
	Worktrees  []string `json:"worktrees"` // paths

	// PR
	State                 string `json:"state,omitempty"`
	ReviewDecision        string `json:"review_decision,omitempty"`
	CIStatus              string `json:"ci_status,omitempty"`
	Mine                  bool   `json:"mine"`                     // the user opened this PR
	ReviewRequestedFromMe bool   `json:"review_requested_from_me"` // from the PR's requested reviewers

	// Jira
	AssignedToMe bool   `json:"assigned_to_me"`
	Assignee     string `json:"assignee,omitempty"`
	Status       string `json:"status,omitempty"`
	Priority     string `json:"priority,omitempty"`
	PriorityRank *int   `json:"priority_rank,omitempty"`

	// UnreadCount is the resource's own unread events, task events excluded.
	UnreadCount    int    `json:"unread_count"`
	NewestUnreadTS string `json:"newest_unread_ts,omitempty"`
	// Unread is every unread event, newest first, with full bodies. Input
	// only: the output is Item.Events.
	Unread []Event `json:"-"`

	Tasks         []Task `json:"tasks"`
	DraftComments int    `json:"draft_comments"` // unposted review comments in its worktrees
}

// Event is one unread event.
type Event struct {
	ID     string `json:"id"`
	TS     string `json:"ts"`
	Source string `json:"source"`
	Type   string `json:"type"`
	Author string `json:"author,omitempty"`
	Title  string `json:"title,omitempty"`
	Body   string `json:"body,omitempty"`
}

// Task is a to-do item as a resource's linked task or an item's task.
type Task struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	State    string `json:"state"`
	Priority string `json:"priority"`
	Due      string `json:"due,omitempty"` // YYYY-MM-DD
}

// OpenTask is a task that is not done, with what makes it an item.
type OpenTask struct {
	Task
	Worktrees       []string `json:"worktrees"`            // linked + implicit
	UnblockedUnread bool     `json:"unblocked_unread"`     // an unread automatic blocker resolution
	UpdatedAt       string   `json:"updated_at,omitempty"` // RFC 3339; a task item's recency
}

// Item is one thing that deserves attention.
type Item struct {
	Kind     string    `json:"kind"`               // "resource" | "task"
	Resource *Resource `json:"resource,omitempty"` // Kind == "resource"
	Task     *OpenTask `json:"task,omitempty"`     // Kind == "task"
	Signals  []string  `json:"signals"`
	Rank     *int      `json:"priority_rank,omitempty"` // effective
	Events   []Event   `json:"events"`                  // up to 5, newest first
}

// Self is the user's identity as Build needs it.
type Self struct{ SlackID string }

// Limits on what an item carries.
const (
	maxEvents    = 5
	maxBodyRunes = 500
	dueSoonDays  = 3
)

// Build returns the items, in the fixed order: effective rank ascending (no
// rank last), then most signals, then newest, then kind+type+id. Never nil.
// linkedJira maps a PR key ("pr:<id>") to the priority ranks of the Jira
// issues sharing a worktree with it.
func Build(now time.Time, self Self, rs []Resource, ts []OpenTask, linkedJira map[string][]int) []Item {
	type entry struct {
		item   Item
		newest time.Time
		key    string
	}
	entries := []entry{}
	for _, r := range rs {
		signals := resourceSignals(self, r)
		if len(signals) == 0 && r.UnreadCount == 0 {
			continue
		}
		res := r
		if res.Worktrees == nil {
			res.Worktrees = []string{}
		}
		if res.Tasks == nil {
			res.Tasks = []Task{}
		}
		entries = append(entries, entry{
			item: Item{
				Kind:     "resource",
				Resource: &res,
				Signals:  signals,
				Rank:     effectiveRank(r, linkedJira),
				Events:   outputEvents(r.Unread),
			},
			newest: parseTime(r.NewestUnreadTS),
			key:    "resource\x00" + r.Type + "\x00" + r.ID,
		})
	}
	for _, t := range ts {
		signals := taskSignals(now, t)
		if len(signals) == 0 {
			continue
		}
		task := t
		if task.Worktrees == nil {
			task.Worktrees = []string{}
		}
		entries = append(entries, entry{
			item: Item{
				Kind:    "task",
				Task:    &task,
				Signals: signals,
				Rank:    taskRank(t.Priority),
				Events:  []Event{},
			},
			newest: parseTime(t.UpdatedAt),
			key:    "task\x00\x00" + t.ID,
		})
	}
	slices.SortStableFunc(entries, func(a, b entry) int {
		return cmp.Or(
			compareRanks(a.item.Rank, b.item.Rank),
			cmp.Compare(len(b.item.Signals), len(a.item.Signals)),
			b.newest.Compare(a.newest),
			cmp.Compare(a.key, b.key),
		)
	})
	out := make([]Item, len(entries))
	for i, e := range entries {
		out[i] = e.item
	}
	return out
}

// resourceSignals returns r's signals, in a fixed order. Never nil. The PR
// signals need an open PR: a merged PR's old CI failure asks nothing of anyone.
func resourceSignals(self Self, r Resource) []string {
	signals := []string{}
	open := strings.EqualFold(r.State, "open")
	if r.ReviewRequestedFromMe && open {
		signals = append(signals, "review_requested")
	}
	if r.Mine && open && r.ReviewDecision == "CHANGES_REQUESTED" {
		signals = append(signals, "changes_requested")
	}
	if r.Mine && open && r.CIStatus == "FAILURE" {
		signals = append(signals, "ci_failing")
	}
	if r.AssignedToMe && r.UnreadCount > 0 {
		signals = append(signals, "assigned_to_you")
	}
	if mentioned(self, r.Unread) {
		signals = append(signals, "mentioned")
	}
	if r.DraftComments > 0 && open {
		signals = append(signals, "stale_draft")
	}
	return signals
}

// mentioned reports whether an unread Slack event's full body mentions the
// user. Stored Slack bodies keep the raw <@USERID>.
func mentioned(self Self, unread []Event) bool {
	if self.SlackID == "" {
		return false
	}
	tag := "<@" + self.SlackID + ">"
	return slices.ContainsFunc(unread, func(e Event) bool {
		return e.Source == "slack" && strings.Contains(e.Body, tag)
	})
}

// taskSignals returns t's signals, in a fixed order. Never nil.
func taskSignals(now time.Time, t OpenTask) []string {
	signals := []string{}
	if dueSoon(now, t.Due) {
		signals = append(signals, "task_due_soon")
	}
	if t.UnblockedUnread {
		signals = append(signals, "blocker_resolved")
	}
	return signals
}

// dueSoon reports whether due, a YYYY-MM-DD date, is past or within
// dueSoonDays of now's calendar date in now's location. Both dates are
// compared as UTC midnights so a DST change cannot shift the day count.
func dueSoon(now time.Time, due string) bool {
	d, err := time.Parse(time.DateOnly, due)
	if err != nil {
		return false
	}
	y, m, day := now.Date()
	today := time.Date(y, m, day, 0, 0, 0, 0, time.UTC)
	return !d.After(today.AddDate(0, 0, dueSoonDays))
}

// taskRank lines a task's priority up with a typical Jira scheme's
// Critical/Major/Normal. No priority has no rank.
func taskRank(p string) *int {
	var n int
	switch p {
	case "high":
		n = 1
	case "medium":
		n = 2
	case "low":
		n = 3
	default:
		return nil
	}
	return &n
}

// effectiveRank is r's own rank, or for a PR the minimum of that and the
// ranks of its linked Jira issues. Always a new pointer.
func effectiveRank(r Resource, linkedJira map[string][]int) *int {
	var best *int
	take := func(n int) {
		if best == nil || n < *best {
			best = &n
		}
	}
	if r.PriorityRank != nil {
		take(*r.PriorityRank)
	}
	if r.Type == "pr" {
		for _, n := range linkedJira["pr:"+r.ID] {
			take(n)
		}
	}
	return best
}

// compareRanks orders ranks ascending, with no rank after every rank.
func compareRanks(a, b *int) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	}
	return cmp.Compare(*a, *b)
}

// outputEvents is the newest maxEvents of unread (which is newest first),
// bodies truncated. Never nil, and never aliases unread.
func outputEvents(unread []Event) []Event {
	out := slices.Clone(unread[:min(len(unread), maxEvents)])
	if out == nil {
		return []Event{}
	}
	for i := range out {
		out[i].Body = truncateBody(out[i].Body)
	}
	return out
}

func truncateBody(s string) string {
	if utf8.RuneCountInString(s) <= maxBodyRunes {
		return s
	}
	return string([]rune(s)[:maxBodyRunes]) + "…"
}

// parseTime reads an RFC 3339 time; anything else is the zero time, which
// sorts as oldest.
func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
