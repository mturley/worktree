package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mturley/worktree/internal/registry"
)

func TestEventByID(t *testing.T) {
	t.Parallel()
	conn, wt := unreadOnlyFixture(t)
	if err := registry.Register(conn, registry.Entry{Path: wt, Repo: "r", RepoRoot: wt, Branch: "b", CreatedAt: "now"}); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/event?id=p3")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var got TimelineEvent
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ID != "p3" {
		t.Errorf("id = %q", got.ID)
	}
	if len(got.WorktreePaths) != 1 || got.WorktreePaths[0] != wt {
		t.Errorf("worktree paths = %v, want [%s]", got.WorktreePaths, wt)
	}
}

func TestEventByIDErrors(t *testing.T) {
	t.Parallel()
	conn, _ := unreadOnlyFixture(t)
	ts := httptest.NewServer((&Server{DB: conn}).Handler())
	defer ts.Close()

	for query, want := range map[string]int{
		"?id=no-such-event": http.StatusNotFound,
		"":                  http.StatusBadRequest,
	} {
		resp, err := http.Get(ts.URL + "/api/event" + query)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("%q: status %d, want %d", query, resp.StatusCode, want)
		}
	}
}
