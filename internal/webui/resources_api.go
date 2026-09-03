package webui

import (
	"encoding/json"
	"net/http"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/resources"
)

type resourceDTO struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	URL     string `json:"url"`
	Primary bool   `json:"primary"`
	// user-supplied custom metadata (from resources.SetMeta):
	CustomName        string `json:"custom_name,omitempty"`
	CustomDescription string `json:"custom_description,omitempty"`
	// enriched from watcher_resource_state (empty if never polled):
	Title                 string   `json:"title,omitempty"`                    // PR title or Jira summary
	ChannelName           string   `json:"channel_name,omitempty"`             // slack: cached #channel name
	HasUnread             bool     `json:"has_unread,omitempty"`               // slack: unread as of the last poll
	CreatedTS             string   `json:"created_ts,omitempty"`               // slack: root message ts (creation)
	UpdatedTS             string   `json:"updated_ts,omitempty"`               // slack: latest message ts
	State                 string   `json:"state,omitempty"`                    // PR state (open/closed/merged)
	ReviewDecision        string   `json:"review_decision,omitempty"`          // PR
	CIStatus              string   `json:"ci_status,omitempty"`                // PR
	NewCommitsSinceReview bool     `json:"new_commits_since_review,omitempty"` // PR
	Author                string   `json:"author,omitempty"`                   // PR author
	Status                string   `json:"status,omitempty"`                   // Jira status
	Priority              string   `json:"priority,omitempty"`                 // Jira
	IssueType             string   `json:"issue_type,omitempty"`               // Jira
	IssueTypeIconURL      string   `json:"issue_type_icon_url,omitempty"`      // Jira
	Assignee              string   `json:"assignee,omitempty"`                 // Jira
	Labels                []string `json:"labels,omitempty"`                   // Jira
	UpdatedAt             string   `json:"updated_at,omitempty"`               // resource_updated_at (RFC3339)
	UnreadCount           int      `json:"unread_count,omitempty"`             // non-slack: events newer than the read cursor
}

func (s *Server) handleWorktreeResources(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	rs, err := resources.Load(s.DB, path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ix := s.newUnreadIndex()
	out := make([]resourceDTO, 0, len(rs))
	for _, res := range rs {
		dto := s.newResourceDTO(res)
		dto.UnreadCount = ix.Count(dto.Type, dto.ID)
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, out)
}

// newResourceDTO builds a resourceDTO from a resources.Resource, enriching it
// from watcher_resource_state. Shared by handleWorktreeResources (above) and
// handleWorktrees (worktrees.go), which build DTOs from the same underlying
// resources.Resource but for different purposes (full list vs. focus-only).
func (s *Server) newResourceDTO(res resources.Resource) resourceDTO {
	dto := resourceDTO{
		Type: res.Type, ID: res.ID, URL: res.URL, Primary: !res.Related,
		CustomName: res.CustomName, CustomDescription: res.CustomDescription,
	}
	s.enrichResourceDTO(&dto)
	return dto
}

// enrichResourceDTO looks up the cached watcher_resource_state row for the
// given resource and populates the DTO's metadata fields. If the resource
// was never polled (GetResourceState returns nil, nil) or the cached blob
// is malformed, the DTO is left with its enriched fields empty/zero -
// callers must not assume state is present. A real GetResourceState error
// (as opposed to the expected "never polled" nil) is logged, matching the
// resources.Load error-logging pattern in worktrees.go.
func (s *Server) enrichResourceDTO(dto *resourceDTO) {
	st, err := watcherdb.GetResourceState(s.DB, dto.Type, dto.ID)
	if err != nil {
		if s.Logger != nil {
			s.Logger.Printf("GetResourceState(%s,%s): %v", dto.Type, dto.ID, err)
		}
		return // degrade to empty enriched fields
	}
	if st == nil {
		return // never polled — expected, no log
	}
	var m map[string]any
	if json.Unmarshal([]byte(st.StateJSON), &m) != nil {
		return
	}
	dto.UpdatedAt = st.ResourceUpdatedAt
	switch dto.Type {
	case "pr":
		if v, ok := m["title"].(string); ok {
			dto.Title = v
		}
		if v, ok := m["state"].(string); ok {
			dto.State = v
		}
		if v, ok := m["review_decision"].(string); ok {
			dto.ReviewDecision = v
		}
		if v, ok := m["ci_status"].(string); ok {
			dto.CIStatus = v
		}
		if v, ok := m["has_new_commits_since_review"].(bool); ok {
			dto.NewCommitsSinceReview = v
		}
		if v, ok := m["author"].(string); ok {
			dto.Author = v
		}
	case "jira":
		if v, ok := m["summary"].(string); ok {
			dto.Title = v
		}
		if v, ok := m["status"].(string); ok {
			dto.Status = v
		}
		if v, ok := m["priority"].(string); ok {
			dto.Priority = v
		}
		if v, ok := m["issue_type"].(string); ok {
			dto.IssueType = v
		}
		if v, ok := m["issue_type_icon_url"].(string); ok {
			dto.IssueTypeIconURL = v
		}
		if v, ok := m["assignee"].(string); ok {
			dto.Assignee = v
		}
		if raw, ok := m["labels"].([]interface{}); ok {
			labels := make([]string, 0, len(raw))
			for _, item := range raw {
				if s, ok := item.(string); ok {
					labels = append(labels, s)
				}
			}
			if len(labels) > 0 {
				dto.Labels = labels
			}
		}
	case "slack":
		if v, ok := m["title"].(string); ok {
			dto.Title = v
		}
		if v, ok := m["has_unread"].(bool); ok {
			dto.HasUnread = v
		}
		if v, ok := m["channel_name"].(string); ok {
			dto.ChannelName = v
		}
		if v, ok := m["author"].(string); ok {
			dto.Author = v
		}
		if v, ok := m["created_ts"].(string); ok {
			dto.CreatedTS = v
		}
		if v, ok := m["updated_ts"].(string); ok {
			dto.UpdatedTS = v
		}
	}
}
