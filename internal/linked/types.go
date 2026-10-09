// Package linked assembles the "Linked Resources" view of a PR, Jira issue
// or Slack thread: the other resources it links to, grouped into sections.
//
// It is pure: every network or DB access goes through the Sources
// interfaces, so the assembly logic is testable without credentials. The
// webui package supplies real adapters (internal/webui/linked_api.go).
package linked

import (
	"context"
	"errors"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/linkmeta"
)

// ErrNotConfigured means the source a resource type needs has no
// credentials. The API maps it to 503.
var ErrNotConfigured = errors.New("source not configured")

// Item is one linked resource row. Field names mirror the UI's ResourceDTO
// so the existing status icon and key rendering apply unchanged.
type Item struct {
	Type             string `json:"type"` // pr | jira | slack | link
	ID               string `json:"id"`
	URL              string `json:"url"`
	Resolved         bool   `json:"resolved"`
	Title            string `json:"title,omitempty"`
	State            string `json:"state,omitempty"`
	IsDraft          bool   `json:"is_draft,omitempty"`
	Status           string `json:"status,omitempty"`
	StatusCategory   string `json:"status_category,omitempty"`
	IssueType        string `json:"issue_type,omitempty"`
	IssueTypeIconURL string `json:"issue_type_icon_url,omitempty"`
	ChannelName      string `json:"channel_name,omitempty"`
	Excerpt          string `json:"excerpt,omitempty"`
	Domain           string `json:"domain,omitempty"`
	Favicon          string `json:"favicon,omitempty"`
	// Context is the link's label and surrounding text where it was written;
	// nil when there is nothing worth showing.
	Context *LinkContext `json:"context,omitempty"`
}

// More marks a node whose children were capped; URL is the JQL search on
// Jira that shows the rest.
type More struct {
	URL string `json:"url"`
}

// TreeNode is one issue in the hierarchy tree. HasChildren is nil when
// unknown (the UI offers a lazy expand).
type TreeNode struct {
	Item
	Current     bool        `json:"current,omitempty"`
	Expanded    bool        `json:"expanded"`
	HasChildren *bool       `json:"has_children"`
	Children    []*TreeNode `json:"children,omitempty"`
	More        *More       `json:"more,omitempty"`
}

type Group struct {
	Label string `json:"label"`
	Items []Item `json:"items"`
}

// Section kinds: git_pr, description, hierarchy, links, referenced_by, thread.
type Section struct {
	Kind   string      `json:"kind"`
	Title  string      `json:"title"`
	Error  string      `json:"error,omitempty"`
	Items  []Item      `json:"items,omitempty"`
	Groups []Group     `json:"groups,omitempty"`
	Tree   []*TreeNode `json:"tree,omitempty"`
}

type Result struct {
	FetchedAt string    `json:"fetched_at"`
	Count     int       `json:"count"`
	Sections  []Section `json:"sections"`
}

// Key identifies a resource by worktree type and id.
type Key struct{ Type, ID string }

type JiraSource interface {
	LinkGraph(ctx context.Context, key string) (*wjira.LinkGraph, error)
	Search(ctx context.Context, jql string, max int) ([]wjira.IssueSummary, bool, error)
	IssueURL(key string) string
	SearchURL(jql string) string
}

type PRSource interface {
	Summaries(ctx context.Context, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error)
}

type SlackSource interface {
	Thread(ctx context.Context, channel, ts string) (slack.Thread, error)
	ChannelName(ctx context.Context, id string) (string, error)
}

type LinkResolver interface {
	Resolve(ctx context.Context, url string) linkmeta.Meta
}

// JiraStateIndex answers from worktree's own cached Jira state — never a
// Jira search.
type JiraStateIndex interface {
	IssuesReferencingPR(ctx context.Context, prID string) ([]Item, error)
}

// Sources is what a Builder reads from. A nil source means "not configured".
type Sources struct {
	Jira      JiraSource
	PR        PRSource
	Slack     SlackSource
	Links     LinkResolver
	JiraState JiraStateIndex
}

func jiraItem(s wjira.IssueSummary, url string) Item {
	return Item{
		Type: "jira", ID: s.Key, URL: url, Resolved: true,
		Title: s.Summary, Status: s.Status, StatusCategory: s.StatusCategory,
		IssueType: s.IssueType, IssueTypeIconURL: s.IssueTypeIconURL,
	}
}
