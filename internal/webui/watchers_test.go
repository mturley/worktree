package webui

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/watcher"
	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

const watchersBody = `{"worktrees_base":"~/wt","editor":"","cmux_features_enabled":true,
  "jira":{"projects":[],"alias_hosts":[]},
  "ui":{"https_port":8476,"allowed_hosts":[],"tls":{"cert_file":"","key_file":""}},
  "watchers":{"github":true,"jira":false,"slack":false}}`

func TestSettingsWatchersPutWritesAndGatesLive(t *testing.T) {
	s, path := settingsServer(t, "ui:\n    password: pw\n")
	got := decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", watchersBody))
	if !got.Worktree.Watchers["github"] || got.Worktree.Watchers["jira"] || got.Worktree.Watchers["slack"] {
		t.Fatalf("watchers in response: %v", got.Worktree.Watchers)
	}
	if !s.WatcherEnabled("github") || s.WatcherEnabled("jira") || s.WatcherEnabled("slack") {
		t.Fatal("live gates did not follow the save")
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "watchers:\n    jira: false\n    slack: false\n") {
		t.Fatalf("file:\n%s", data)
	}
	on := strings.NewReplacer(`"jira":false`, `"jira":true`, `"slack":false`, `"slack":true`).Replace(watchersBody)
	decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", on))
	if !s.WatcherEnabled("jira") || !s.WatcherEnabled("slack") {
		t.Fatal("re-enabling did not reopen the gates")
	}
	if data, _ := os.ReadFile(path); strings.Contains(string(data), "watchers") {
		t.Fatalf("all on should leave no watchers key:\n%s", data)
	}
}

func TestSettingsWatchersRejectsUnknown(t *testing.T) {
	s, _ := settingsServer(t, "")
	bad := strings.Replace(watchersBody, `"github":true`, `"gitlab":true`, 1)
	if rec := doReq(s, "PUT", "/api/settings/worktree", bad); rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d", rec.Code)
	}
}

// A PUT that omits watchers (an older client) leaves every gate as it was.
func TestSettingsWatchersOmittedKeepsState(t *testing.T) {
	s, _ := settingsServer(t, "")
	s.SetWatchersDisabled(map[string]bool{"jira": true})
	body := strings.Replace(watchersBody, `,
  "watchers":{"github":true,"jira":false,"slack":false}`, "", 1)
	decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", body))
	if s.WatcherEnabled("jira") {
		t.Fatal("an omitted watcher was turned back on")
	}
}

func TestCredRoutesRefuseWhileWatcherOff(t *testing.T) {
	s, log := credServer(t, nil, nil, nil)
	s.SetWatchersDisabled(map[string]bool{"github": true})
	rec := doReq(s, "POST", "/api/settings/credentials/github/test", `{"token":"ghp_NEW"}`)
	if r := decodeCredResult(t, rec.Body.String()); r.OK || r.Kind != "disabled" {
		t.Fatalf("test: %s", rec.Body)
	}
	before := readAuth(t, s)
	rec = doReq(s, "PUT", "/api/settings/credentials/github", `{"token":"ghp_NEW"}`)
	if rec.Code != http.StatusUnprocessableEntity || decodeCredResult(t, rec.Body.String()).Kind != "disabled" {
		t.Fatalf("replace: %d %s", rec.Code, rec.Body)
	}
	if len(log.github) != 0 || readAuth(t, s) != before {
		t.Fatalf("a disabled service was contacted or written: calls %v", log.github)
	}
}

func TestGateSlackNeverCallsThroughWhileOff(t *testing.T) {
	fake := newFakeSlack()
	on := false
	c := GateSlack(fake, func() bool { return on })
	if _, err := c.Replies(context.Background(), "C1", "1.0"); !errors.Is(err, ErrWatcherDisabled) {
		t.Fatalf("err = %v", err)
	}
	if _, err := c.PostReply(context.Background(), "C1", "1.0", "hi"); !errors.Is(err, ErrWatcherDisabled) || fake.replyCalls != 0 {
		t.Fatalf("PostReply err=%v calls=%d", err, fake.replyCalls)
	}
	on = true
	if th, err := c.Replies(context.Background(), "C1", "1.0"); err != nil || th.ThreadTS != "1.0" {
		t.Fatalf("on: %v %+v", err, th)
	}
}

func TestSlackRoutesSayWatcherDisabled(t *testing.T) {
	s := &Server{SlackClient: newFakeSlack(), SlackDomain: "acme.slack.com"}
	s.SetWatchersDisabled(map[string]bool{"slack": true})
	for _, url := range []string{"/api/thread?channel=C1&thread_ts=1.0", "/api/slack-avatar?url=https://avatars.slack-edge.com/x.png"} {
		rec := doReq(s, "GET", url, "")
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "The Slack watcher is disabled in Settings") {
			t.Fatalf("%s: %d %s", url, rec.Code, rec.Body)
		}
	}
}

func TestLinkedResourcesSayWatcherDisabled(t *testing.T) {
	s := &Server{}
	s.SetWatchersDisabled(map[string]bool{"github": true})
	rec := doReq(s, "GET", "/api/linked-resources?type=pr&id=o/r%231", "")
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "The GitHub watcher is disabled") {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func healthServer(t *testing.T) *Server {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return &Server{DB: conn, Logger: log.New(io.Discard, "", 0)}
}

func getHealth(t *testing.T, s *Server) map[string]watcherHealth {
	t.Helper()
	rec := doReq(s, "GET", "/api/watchers/health", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var out map[string]watcherHealth
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// Failing needs every polled resource of the service to have failed its
// latest poll, and one success clears it.
func TestWatcherHealthFailingUntilASuccess(t *testing.T) {
	s := healthServer(t)
	a := watcher.Resource{Type: "pr", ID: "o/r#1"}
	b := watcher.Resource{Type: "pr", ID: "o/r#2"}
	for _, r := range []watcher.Resource{a, b} {
		if err := watcherdb.Subscribe(s.DB, "worktree:/x", r, watcherdb.SubscribeOpts{}); err != nil {
			t.Fatal(err)
		}
	}
	if h := getHealth(t, s)["github"]; !h.Enabled || h.Failing {
		t.Fatalf("never polled: %+v", h)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	// Only polled resources count: one not yet polled (just added) doesn't
	// hide a failure every polled one shares.
	must(watcherdb.RecordResourcePoll(s.DB, a, false, "401 Bad credentials", watcherdb.ResourcePollDetail{HTTPStatus: 401}))
	if !getHealth(t, s)["github"].Failing {
		t.Fatal("the only polled resource failed")
	}
	must(watcherdb.RecordResourcePoll(s.DB, b, true, "", watcherdb.ResourcePollDetail{}))
	if getHealth(t, s)["github"].Failing {
		t.Fatal("one resource polling fine means the service is fine")
	}
	must(watcherdb.RecordResourcePoll(s.DB, b, false, "401 Bad credentials", watcherdb.ResourcePollDetail{HTTPStatus: 401}))
	if h := getHealth(t, s)["github"]; !h.Failing || h.Error != "401 Bad credentials" {
		t.Fatalf("all failing: %+v", h)
	}
	must(watcherdb.RecordResourcePoll(s.DB, a, true, "", watcherdb.ResourcePollDetail{}))
	if getHealth(t, s)["github"].Failing {
		t.Fatal("a successful poll should clear it")
	}
	s.SetWatchersDisabled(map[string]bool{"github": true})
	if h := getHealth(t, s)["github"]; h.Enabled || h.Failing {
		t.Fatalf("disabled: %+v", h)
	}
}
