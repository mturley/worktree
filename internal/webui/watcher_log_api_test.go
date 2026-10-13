package webui

import (
	"encoding/json"
	"fmt"
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

type logResp struct {
	Entries []pollLogEntryDTO `json:"entries"`
	HasMore bool              `json:"has_more"`
}

func getLog(t *testing.T, base string, q url.Values, wantStatus int) logResp {
	t.Helper()
	resp, err := http.Get(base + "/api/watchers/log?" + q.Encode())
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != wantStatus {
		t.Fatalf("status %d, want %d", resp.StatusCode, wantStatus)
	}
	var out logResp
	if wantStatus == 200 {
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

func seedLog(t *testing.T, f watcherLogFixture) (ghStart, prRow, slackRow, jiraStart int64) {
	t.Helper()
	ins := func(e watcherdb.PollLogEntry) int64 {
		id, err := watcherdb.InsertPollLog(f.srv.DB, e)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	ghStart = ins(watcherdb.PollLogEntry{Source: "github", Level: "info", Kind: "poll", Message: "github poll started"})
	prRow = ins(watcherdb.PollLogEntry{Source: "github", Level: "error", Kind: "http", Message: "POST → 504",
		HTTPStatus: 504, ErrorBody: "Unicorn! · GitHub", Resources: []watcher.Resource{f.prA}})
	slackRow = ins(watcherdb.PollLogEntry{Source: "slack", Level: "error", Kind: "resource", Message: "thread_not_found",
		Resources: []watcher.Resource{f.slackB}})
	jiraStart = ins(watcherdb.PollLogEntry{Source: "jira", Level: "info", Kind: "poll", Message: "jira poll started"})
	return
}

func entryIDs(r logResp) []int64 {
	var out []int64
	for _, e := range r.Entries {
		out = append(out, e.ID)
	}
	return out
}

func TestWatcherLog_UnscopedNewestFirstWithNames(t *testing.T) {
	f := newWatcherLogFixture(t)
	gh, pr, sl, ji := seedLog(t, f)
	got := getLog(t, f.url, nil, 200)
	if want := []int64{ji, sl, pr, gh}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("ids %v want %v", entryIDs(got), want)
	}
	if got.Entries[2].Resources[0].Name != "My PR" || got.Entries[2].ErrorBody != "Unicorn! · GitHub" {
		t.Fatalf("pr row: %+v", got.Entries[2])
	}
}

func TestWatcherLog_ResourceScopeIncludesOwnSourcePollRowsOnly(t *testing.T) {
	f := newWatcherLogFixture(t)
	gh, pr, _, _ := seedLog(t, f)
	got := getLog(t, f.url, url.Values{"resource": {"pr:" + f.prA.ID}}, 200)
	if want := []int64{pr, gh}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("ids %v want %v", entryIDs(got), want)
	}
}

func TestWatcherLog_FiltersAndCursors(t *testing.T) {
	f := newWatcherLogFixture(t)
	gh, pr, sl, ji := seedLog(t, f)
	got := getLog(t, f.url, url.Values{"level": {"warn"}}, 200)
	if want := []int64{sl, pr}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("warn ids %v", entryIDs(got))
	}
	got = getLog(t, f.url, url.Values{"source": {"github", "jira"}}, 200)
	if want := []int64{ji, pr, gh}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("source ids %v", entryIDs(got))
	}
	got = getLog(t, f.url, url.Values{"after_id": {fmt.Sprint(pr)}}, 200)
	if want := []int64{ji, sl}; fmt.Sprint(entryIDs(got)) != fmt.Sprint(want) {
		t.Fatalf("after ids %v", entryIDs(got))
	}
	got = getLog(t, f.url, url.Values{"limit": {"1"}}, 200)
	if len(got.Entries) != 1 || !got.HasMore {
		t.Fatalf("limit 1: %+v", got)
	}
}

func TestWatcherLog_BadParams(t *testing.T) {
	f := newWatcherLogFixture(t)
	for _, q := range []url.Values{
		{"level": {"loud"}}, {"source": {"bitbucket"}}, {"after_id": {"x"}},
		{"limit": {"0"}}, {"limit": {"501"}}, {"resource": {"nocolon"}},
	} {
		getLog(t, f.url, q, http.StatusBadRequest)
	}
}
