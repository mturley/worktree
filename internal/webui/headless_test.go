package webui

import (
	"encoding/json"
	"testing"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

// headlessJiraFixture follows one Jira issue from one worktree, with the
// given cached state, and returns a Server holding nothing but the DB (the
// way the CLI builds it) and the worktree path.
func headlessJiraFixture(t *testing.T, stateJSON string) (*Server, string) {
	t.Helper()
	conn := seededDB(t)
	wtPath := testgit.Worktree(t)
	must(t, registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"}))
	must(t, resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u1"}))
	must(t, watcherdb.UpsertResourceState(conn, "jira", "J-1", stateJSON, "2026-08-13T00:00:00Z", "2026-08-13T00:00:00Z"))
	return &Server{DB: conn}, wtPath
}

func TestWorktreeSummariesHeadless(t *testing.T) {
	t.Parallel()
	s, wtPath := headlessJiraFixture(t, `{"priority":"Critical","priority_rank":1}`)
	got, err := s.WorktreeSummaries()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Path != wtPath || got[0].Branch != "b1" {
		t.Fatalf("summaries = %+v", got)
	}
	if len(got[0].FocusResources) != 1 {
		t.Fatalf("focus = %+v", got[0].FocusResources)
	}
	r := got[0].FocusResources[0]
	if r.Priority != "Critical" || r.PriorityRank == nil || *r.PriorityRank != 1 {
		t.Fatalf("resource = %+v", r)
	}
}

func TestAllResourcesHeadless(t *testing.T) {
	t.Parallel()
	s, wtPath := headlessJiraFixture(t, `{"priority":"Critical","priority_rank":1}`)
	got, err := s.AllResources()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "J-1" || len(got[0].Worktrees) != 1 || got[0].Worktrees[0].Path != wtPath {
		t.Fatalf("all resources = %+v", got)
	}
	if got[0].PriorityRank == nil || *got[0].PriorityRank != 1 {
		t.Fatalf("rank = %v", got[0].PriorityRank)
	}
}

func TestWorktreeResourcesHeadless(t *testing.T) {
	t.Parallel()
	s, wtPath := headlessJiraFixture(t, `{"priority":"Critical","priority_rank":1}`)
	got, err := s.WorktreeResources(wtPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "J-1" || got[0].PriorityRank == nil || *got[0].PriorityRank != 1 {
		t.Fatalf("resources = %+v", got)
	}
}

// Rank 0 is the highest priority, a real value: it must be filled and must
// survive omitempty in JSON, while an absent rank is omitted.
func TestPriorityRankZeroSurvivesJSON(t *testing.T) {
	t.Parallel()
	s, _ := headlessJiraFixture(t, `{"priority":"Blocker","priority_rank":0}`)
	got, err := s.AllResources()
	if err != nil {
		t.Fatal(err)
	}
	if got[0].PriorityRank == nil || *got[0].PriorityRank != 0 {
		t.Fatalf("rank = %v", got[0].PriorityRank)
	}
	b, _ := json.Marshal(got[0])
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if v, ok := m["priority_rank"]; !ok || v != float64(0) {
		t.Fatalf("priority_rank in JSON = %v, %v", v, ok)
	}

	s2, _ := headlessJiraFixture(t, `{"priority":"Critical"}`)
	got2, _ := s2.AllResources()
	if got2[0].PriorityRank != nil {
		t.Fatalf("absent rank = %v", *got2[0].PriorityRank)
	}
	b, _ = json.Marshal(got2[0])
	m = nil
	_ = json.Unmarshal(b, &m)
	if _, ok := m["priority_rank"]; ok {
		t.Fatalf("absent rank was sent: %s", b)
	}
}

func TestEnrichRequestedReviewers(t *testing.T) {
	t.Parallel()
	conn := seededDB(t)
	must(t, watcherdb.UpsertResourceState(conn, "pr", "o/r#1",
		`{"title":"t","requested_reviewer_ids":["9","12"]}`, "2026-08-13T00:00:00Z", "2026-08-13T00:00:00Z"))
	s := &Server{DB: conn}
	dto := resourceDTO{Type: "pr", ID: "o/r#1"}
	s.enrichResourceDTO(&dto)
	if len(dto.RequestedReviewerIDs) != 2 || dto.RequestedReviewerIDs[0] != "9" || dto.RequestedReviewerIDs[1] != "12" {
		t.Fatalf("reviewers = %v", dto.RequestedReviewerIDs)
	}
	b, _ := json.Marshal(dto)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["RequestedReviewerIDs"]; ok {
		t.Fatalf("reviewer ids were sent: %s", b)
	}
}

func TestWatcherStatusesHeadless(t *testing.T) {
	t.Parallel()
	s := &Server{DB: seededDB(t)}
	got := s.WatcherStatuses()
	if len(got) != len(watcherSources) || got[0].Name != "github" {
		t.Fatalf("statuses = %+v", got)
	}
}
