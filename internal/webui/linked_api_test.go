package webui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	"github.com/mturley/worktree/internal/linked"
	"github.com/mturley/worktree/internal/linkmeta"
)

type stubPR struct{ calls int }

func (s *stubPR) Summaries(_ context.Context, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error) {
	s.calls++
	out := map[wgithub.PRRef]wgithub.PRSummary{}
	for _, r := range refs {
		out[r] = wgithub.PRSummary{Title: "T", Body: "https://docs.example.com/a"}
	}
	return out, nil
}

type stubJira struct{}

func (stubJira) LinkGraph(context.Context, string) (*wjira.LinkGraph, error) { return nil, nil }
func (stubJira) Search(_ context.Context, jql string, _ int) ([]wjira.IssueSummary, bool, error) {
	return []wjira.IssueSummary{{Key: "PROJ-2", Summary: "kid"}}, true, nil
}
func (stubJira) IssueURL(k string) string  { return "https://example.atlassian.net/browse/" + k }
func (stubJira) SearchURL(q string) string { return "https://example.atlassian.net/issues/?jql=" + q }

func getJSON(t *testing.T, h http.Handler, url string, into interface{}) int {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
	if into != nil && rec.Code == 200 {
		if err := json.Unmarshal(rec.Body.Bytes(), into); err != nil {
			t.Fatal(err)
		}
	}
	return rec.Code
}

func TestLinkedResourcesCachesAndRefreshes(t *testing.T) {
	pr := &stubPR{}
	s := &Server{LinkedSources: func() linked.Sources { return linked.Sources{PR: pr} }}
	h := s.Handler()
	var r linked.Result
	if code := getJSON(t, h, "/api/linked-resources?type=pr&id=example/repo%231", &r); code != 200 {
		t.Fatalf("code %d", code)
	}
	if len(r.Sections) == 0 || r.Count != 1 {
		t.Fatalf("result %+v", r)
	}
	getJSON(t, h, "/api/linked-resources?type=pr&id=example/repo%231", nil)
	if pr.calls != 1 {
		t.Errorf("second request must hit the cache; calls=%d", pr.calls)
	}
	getJSON(t, h, "/api/linked-resources?type=pr&id=example/repo%231&resolve_links=1", nil)
	if pr.calls != 2 {
		t.Errorf("resolve_links is a separate cache entry; calls=%d", pr.calls)
	}
	getJSON(t, h, "/api/linked-resources?type=pr&id=example/repo%231&refresh=1", nil)
	if pr.calls != 3 {
		t.Errorf("refresh must bypass the cache; calls=%d", pr.calls)
	}
}

func TestLinkedResourcesErrors(t *testing.T) {
	s := &Server{LinkedSources: func() linked.Sources { return linked.Sources{} }}
	h := s.Handler()
	cases := map[string]int{
		"/api/linked-resources?type=pr":                     400,
		"/api/linked-resources?type=link&id=https://x.com":  400,
		"/api/linked-resources?type=pr&id=example/repo%231": 503,
		"/api/linked-resources/children?key=not%20a%20key":  400,
		"/api/linked-resources/children?key=PROJ-1":         503,
	}
	for url, want := range cases {
		if got := getJSON(t, h, url, nil); got != want {
			t.Errorf("%s: got %d want %d", url, got, want)
		}
	}
}

func TestLinkedChildren(t *testing.T) {
	s := &Server{LinkedSources: func() linked.Sources { return linked.Sources{Jira: stubJira{}} }}
	var body struct {
		Items []linked.TreeNode `json:"items"`
		More  *linked.More      `json:"more"`
	}
	if code := getJSON(t, s.Handler(), "/api/linked-resources/children?key=PROJ-1", &body); code != 200 {
		t.Fatalf("code %d", code)
	}
	if len(body.Items) != 1 || body.Items[0].ID != "PROJ-2" || body.More == nil {
		t.Errorf("body %+v", body)
	}
}

func TestJiraStateIndexFindsReferencingIssues(t *testing.T) {
	db := unreadTestDB(t)
	_, err := db.Exec(`INSERT INTO watcher_resource_state (resource_type, resource_id, state_json, resource_updated_at, watcher_updated_at) VALUES
		('jira','PROJ-1','{"summary":"One","status":"Review","issue_type":"Story","git_pull_request_urls":["https://github.com/example/repo/pull/1/files"]}','x','x'),
		('jira','PROJ-2','{"summary":"Two","git_pull_request_urls":["https://github.com/example/repo/pull/2"]}','x','x'),
		('jira','PROJ-3','{"summary":"Three"}','x','x')`)
	if err != nil {
		t.Fatal(err)
	}
	idx := jiraStateIndex{db: db, issueURL: func(k string) string { return "https://example.atlassian.net/browse/" + k }}
	got, err := idx.IssuesReferencingPR(context.Background(), "example/repo#1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "PROJ-1" || got[0].Title != "One" || got[0].Status != "Review" || !got[0].Resolved {
		t.Errorf("got %+v", got)
	}
}

func TestTTLCachePanicDoesNotWedgeKey(t *testing.T) {
	c := newTTLCache()
	_, err := c.get("k", time.Minute, false, func() (interface{}, error) { panic("boom") })
	if err == nil {
		t.Fatal("panic should surface as error")
	}
	done := make(chan error, 1)
	go func() {
		_, err := c.get("k", time.Minute, false, func() (interface{}, error) { return 1, nil })
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("second get blocked: inflight entry wedged")
	}
}

type countingMeta struct{ calls int }

func (c *countingMeta) Resolve(context.Context, string) linkmeta.Meta {
	c.calls++
	return linkmeta.Meta{Title: "t"}
}

func TestCachedLinkResolverDoesNotCacheCancelled(t *testing.T) {
	cm := &countingMeta{}
	r := cachedLinkResolver{r: cm, cache: newTTLCache()}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if m := r.Resolve(ctx, "https://x.com"); m.Title != "t" {
		t.Errorf("caller should still get the meta: %+v", m)
	}
	r.Resolve(context.Background(), "https://x.com")
	r.Resolve(context.Background(), "https://x.com")
	if cm.calls != 2 {
		t.Errorf("cancelled result must not be cached, live one must; calls=%d", cm.calls)
	}
}
