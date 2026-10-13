package webui

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

type watcherLogFixture struct {
	srv          *Server
	url          string
	wtA, wtALink string // wtALink is a symlink to wtA
	wtB          string
	prA, slackB  watcher.Resource
}

func newWatcherLogFixture(t *testing.T) watcherLogFixture {
	t.Helper()
	srv, ts := watchersTestServer(t)
	root := t.TempDir()
	f := watcherLogFixture{srv: srv, url: ts.URL,
		wtA: filepath.Join(root, "a"), wtB: filepath.Join(root, "b"), wtALink: filepath.Join(root, "a-link"),
		prA:    watcher.Resource{Type: "pr", ID: "o/r#1", URL: "https://github.com/o/r/pull/1"},
		slackB: watcher.Resource{Type: "slack", ID: "C1:1699000000.000100"},
	}
	for _, d := range []string{f.wtA, f.wtB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(f.wtA, f.wtALink); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(watcherdb.Subscribe(srv.DB, wdb.Subscriber(f.wtA), f.prA, watcherdb.SubscribeOpts{}))
	must(watcherdb.Subscribe(srv.DB, wdb.Subscriber(f.wtB), f.prA, watcherdb.SubscribeOpts{}))
	must(watcherdb.Subscribe(srv.DB, wdb.Subscriber(f.wtB), f.slackB, watcherdb.SubscribeOpts{}))
	must(watcherdb.SetResourceMeta(srv.DB, f.prA, "My PR", ""))
	must(watcherdb.RecordResourcePoll(srv.DB, f.slackB, false, "Failed to fetch thread: slack error: thread_not_found", watcherdb.ResourcePollDetail{}))
	return f
}

func getWatched(t *testing.T, base string, q url.Values) []watchedResourceDTO {
	t.Helper()
	resp, err := http.Get(base + "/api/watchers/resources?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var out struct{ Resources []watchedResourceDTO }
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.Resources
}

func TestWatchedResources_Unscoped(t *testing.T) {
	f := newWatcherLogFixture(t)
	got := getWatched(t, f.url, nil)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	if got[0].ID != f.slackB.ID || got[0].Status != "error" || got[0].ErrorMessage == "" {
		t.Fatalf("errors must sort first: %+v", got[0])
	}
	if got[1].Name != "My PR" || got[1].Status != "never" || len(got[1].Worktrees) != 2 {
		t.Fatalf("pr row: %+v", got[1])
	}
}

func TestWatchedResources_WorktreeScopeViaSymlink(t *testing.T) {
	f := newWatcherLogFixture(t)
	got := getWatched(t, f.url, url.Values{"worktree": {f.wtALink}})
	if len(got) != 1 || got[0].ID != f.prA.ID {
		t.Fatalf("scoped via symlink = %+v", got)
	}
}

func TestWatchedResources_SlackIDWithColon(t *testing.T) {
	f := newWatcherLogFixture(t)
	got := getWatched(t, f.url, url.Values{"resource": {"slack:" + f.slackB.ID}, "worktree": {f.wtA}})
	if len(got) != 1 || got[0].Type != "slack" || got[0].ID != f.slackB.ID {
		t.Fatalf("resource wins over worktree; got %+v", got)
	}
}

func TestWatchedResources_BadResourceParam(t *testing.T) {
	f := newWatcherLogFixture(t)
	resp, _ := http.Get(f.url + "/api/watchers/resources?resource=nocolon")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
}
