package webui

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
)

func TestWorktreeResourcesEndpoint(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := t.TempDir()
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})                // primary
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2", Related: true}) // related

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []resourceDTO
	json.NewDecoder(resp.Body).Decode(&got)
	if len(got) != 2 {
		t.Fatalf("want 2, got %d", len(got))
	}
	var prPrimary, jiraPrimary bool
	for _, r := range got {
		if r.Type == "pr" {
			prPrimary = r.Primary
		}
		if r.Type == "jira" {
			jiraPrimary = r.Primary
		}
	}
	if !prPrimary || jiraPrimary {
		t.Fatalf("pr should be primary, jira related: %+v", got)
	}
}

func TestWorktreeResourcesEndpointEnrichment(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := t.TempDir()
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2", Related: true})
	// A never-polled resource, added so we can assert graceful degrade.
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#2", URL: "u3", Related: true})

	prState := `{"title":"Fix the widget","state":"OPEN","review_decision":"CHANGES_REQUESTED","has_new_commits_since_review":true,"ci_status":"failure","author":"octocat","latest_commit_sha":"abc123"}`
	if err := watcherdb.UpsertResourceState(conn, "pr", "o/r#1", prState, "2026-08-01T00:00:00Z", "2026-08-01T00:05:00Z"); err != nil {
		t.Fatal(err)
	}
	jiraState := `{"summary":"Investigate the flux capacitor","status":"In Progress","priority":"High","assignee":"jdoe","issue_type":"Bug","labels":["backend","urgent"],"reporter":"asmith","created_at":"2026-07-01T00:00:00Z","updated_at":"2026-08-01T00:00:00Z"}`
	if err := watcherdb.UpsertResourceState(conn, "jira", "J-1", jiraState, "2026-08-02T00:00:00Z", "2026-08-02T00:05:00Z"); err != nil {
		t.Fatal(err)
	}

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []resourceDTO
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3, got %d: %+v", len(got), got)
	}

	byID := map[string]resourceDTO{}
	for _, r := range got {
		byID[r.ID] = r
	}

	pr, ok := byID["o/r#1"]
	if !ok {
		t.Fatalf("missing pr o/r#1 in %+v", got)
	}
	if pr.Title != "Fix the widget" || pr.State != "OPEN" || pr.ReviewDecision != "CHANGES_REQUESTED" ||
		pr.CIStatus != "failure" || !pr.NewCommitsSinceReview || pr.Author != "octocat" || pr.UpdatedAt != "2026-08-01T00:00:00Z" {
		t.Fatalf("pr enrichment mismatch: %+v", pr)
	}

	jira, ok := byID["J-1"]
	if !ok {
		t.Fatalf("missing jira J-1 in %+v", got)
	}
	if jira.Title != "Investigate the flux capacitor" || jira.Status != "In Progress" || jira.Priority != "High" ||
		jira.IssueType != "Bug" || jira.Assignee != "jdoe" || jira.UpdatedAt != "2026-08-02T00:00:00Z" {
		t.Fatalf("jira enrichment mismatch: %+v", jira)
	}
	if len(jira.Labels) != 2 || jira.Labels[0] != "backend" || jira.Labels[1] != "urgent" {
		t.Fatalf("jira labels mismatch: %+v", jira.Labels)
	}

	// Never-polled resource must degrade gracefully: no enriched fields set.
	unpolled, ok := byID["o/r#2"]
	if !ok {
		t.Fatalf("missing unpolled pr o/r#2 in %+v", got)
	}
	if unpolled.Title != "" || unpolled.State != "" || unpolled.ReviewDecision != "" || unpolled.CIStatus != "" ||
		unpolled.NewCommitsSinceReview || unpolled.Author != "" || unpolled.UpdatedAt != "" {
		t.Fatalf("unpolled pr should have no enriched fields, got %+v", unpolled)
	}
}

func TestSlackEnrich(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wtPath := t.TempDir()
	resources.Add(conn, wtPath, resources.Resource{Type: "slack", ID: "C123:1699000000.000100", URL: "u1"})

	slackState := `{"title":"e2e regression thread","channel_name":"wg-dashboard-zaffre","author":"Christian Vogt","created_ts":"1699000000.000100","updated_ts":"1699000500.000200"}`
	if err := watcherdb.UpsertResourceState(conn, "slack", "C123:1699000000.000100", slackState, "2026-08-01T00:00:00Z", "2026-08-01T00:05:00Z"); err != nil {
		t.Fatal(err)
	}

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got []resourceDTO
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1, got %d: %+v", len(got), got)
	}
	slack := got[0]
	if slack.Title != "e2e regression thread" || slack.ChannelName != "wg-dashboard-zaffre" ||
		slack.Author != "Christian Vogt" || slack.CreatedTS != "1699000000.000100" || slack.UpdatedTS != "1699000500.000200" {
		t.Fatalf("slack enrichment mismatch: %+v", slack)
	}
}

func TestEnrichResourceDTOHandlesMalformedState(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := watcherdb.UpsertResourceState(conn, "jira", "J-BAD", `not valid json`, "2026-08-01T00:00:00Z", "2026-08-01T00:05:00Z"); err != nil {
		t.Fatal(err)
	}
	srv := &Server{DB: conn}
	dto := resourceDTO{Type: "jira", ID: "J-BAD"}
	srv.enrichResourceDTO(&dto)
	if dto.Title != "" || dto.Status != "" || dto.UpdatedAt != "" {
		t.Fatalf("malformed state must not populate any fields, got %+v", dto)
	}

	// A jira resource with a null assignee must not panic and must leave
	// Assignee empty.
	if err := watcherdb.UpsertResourceState(conn, "jira", "J-NULL", `{"summary":"x","assignee":null,"labels":null}`, "2026-08-01T00:00:00Z", "2026-08-01T00:05:00Z"); err != nil {
		t.Fatal(err)
	}
	dto2 := resourceDTO{Type: "jira", ID: "J-NULL"}
	srv.enrichResourceDTO(&dto2)
	if dto2.Title != "x" || dto2.Assignee != "" || dto2.Labels != nil {
		t.Fatalf("null assignee/labels should degrade cleanly, got %+v", dto2)
	}
}

// TestEnrichResourceDTOLogsRealErrors verifies that a genuine
// GetResourceState error (as opposed to the expected "never polled" nil, nil
// case) is logged via s.Logger rather than silently swallowed - it must
// remain distinguishable from "never polled" in the logs, even though both
// cases leave the DTO's enriched fields empty.
func TestEnrichResourceDTOLogsRealErrors(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	conn.Close() // force any subsequent query to fail with a real error

	var buf bytes.Buffer
	srv := &Server{DB: conn, Logger: log.New(&buf, "", 0)}
	dto := resourceDTO{Type: "pr", ID: "o/r#1"}
	srv.enrichResourceDTO(&dto)

	if dto.Title != "" || dto.State != "" {
		t.Fatalf("dto should have no enriched fields on error, got %+v", dto)
	}
	if !strings.Contains(buf.String(), "GetResourceState") {
		t.Fatalf("expected GetResourceState error to be logged, got log: %q", buf.String())
	}
}
