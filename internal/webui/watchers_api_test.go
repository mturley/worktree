package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	watcherdb "github.com/mturley/watcher/db"
	wdb "github.com/mturley/worktree/internal/db"
)

func watchersTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

func getWatchers(t *testing.T, ts *httptest.Server) watchersResponse {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/watchers")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var out watchersResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func byName(t *testing.T, out watchersResponse, name string) watcherStatusDTO {
	t.Helper()
	for _, w := range out.Watchers {
		if w.Name == name {
			return w
		}
	}
	t.Fatalf("watcher %q absent from %+v", name, out.Watchers)
	return watcherStatusDTO{}
}

// TestWatchersReportsAllThreeEvenWhenNeverRun pins that the endpoint answers
// for every source, not only the ones with a status row. A fresh install has
// no rows at all, and a UI that renders only what it receives would show no
// toggles rather than three unannotated ones.
func TestWatchersReportsAllThreeEvenWhenNeverRun(t *testing.T) {
	_, ts := watchersTestServer(t)
	out := getWatchers(t, ts)
	if len(out.Watchers) != 3 {
		t.Fatalf("want 3 watchers, got %d: %+v", len(out.Watchers), out.Watchers)
	}
	for _, name := range []string{"github", "jira", "slack"} {
		w := byName(t, out, name)
		if w.LastSuccess != "" || w.HasError {
			t.Fatalf("%s should report nothing known, got %+v", name, w)
		}
	}
}

// TestWatchersMapsGitHubToPRType guards the one place two vocabularies meet:
// the poller is named "github", the resources it polls are type "pr". Getting
// this wrong leaves the GitHub toggle silently statusless.
func TestWatchersMapsGitHubToPRType(t *testing.T) {
	_, ts := watchersTestServer(t)
	out := getWatchers(t, ts)
	if got := byName(t, out, "github").Type; got != "pr" {
		t.Fatalf("github watcher type = %q, want %q", got, "pr")
	}
	if got := byName(t, out, "slack").Type; got != "slack" {
		t.Fatalf("slack watcher type = %q, want %q", got, "slack")
	}
}

func TestWatchersReportsSuccessAndError(t *testing.T) {
	srv, ts := watchersTestServer(t)
	if err := watcherdb.RecordPollerSuccess(srv.DB, "github"); err != nil {
		t.Fatal(err)
	}
	if err := watcherdb.RecordPollerError(srv.DB, "jira", "401 unauthorized"); err != nil {
		t.Fatal(err)
	}

	out := getWatchers(t, ts)
	gh := byName(t, out, "github")
	if gh.LastSuccess == "" {
		t.Fatal("github should carry its last success time")
	}
	if gh.HasError {
		t.Fatalf("github succeeded; should not report an error: %+v", gh)
	}
	jira := byName(t, out, "jira")
	if !jira.HasError || jira.ErrorMessage != "401 unauthorized" {
		t.Fatalf("jira should report its failure: %+v", jira)
	}
}

// TestWatchersErrorClearsOnLaterSuccess is the case a naive "has it ever
// errored?" check gets wrong: a watcher that failed and then recovered is
// healthy, and a red X that never clears teaches the user to ignore it.
func TestWatchersErrorClearsOnLaterSuccess(t *testing.T) {
	srv, ts := watchersTestServer(t)
	if err := watcherdb.RecordPollerError(srv.DB, "slack", "token expired"); err != nil {
		t.Fatal(err)
	}
	if got := byName(t, getWatchers(t, ts), "slack"); !got.HasError {
		t.Fatalf("slack should report the failure: %+v", got)
	}

	// The status table stores whole seconds, so a same-second success would be
	// indistinguishable from the error it follows.
	time.Sleep(1100 * time.Millisecond)
	if err := watcherdb.RecordPollerSuccess(srv.DB, "slack"); err != nil {
		t.Fatal(err)
	}
	got := byName(t, getWatchers(t, ts), "slack")
	if got.HasError {
		t.Fatalf("a recovered watcher must stop reporting an error: %+v", got)
	}
	if got.ErrorMessage != "" {
		t.Fatalf("a recovered watcher must not carry a stale message: %+v", got)
	}
}

func TestWatchersReportsPollingFlag(t *testing.T) {
	srv, ts := watchersTestServer(t)
	if getWatchers(t, ts).Polling {
		t.Fatal("nothing is polling; flag should be false")
	}
	srv.pollInFlight.Store(true)
	defer srv.pollInFlight.Store(false)
	if !getWatchers(t, ts).Polling {
		t.Fatal("a poll in flight must be reported, so the UI can spin")
	}
}

// TestWatchersPollReturnsImmediately pins the contract the spinner depends on:
// the endpoint starts a poll and gets out of the way. If it blocked for the
// length of a real poll, the button would sit there for seconds and the
// spinner would be driven by the request rather than by actual watcher state.
func TestWatchersPollReturnsImmediately(t *testing.T) {
	_, ts := watchersTestServer(t)
	done := make(chan int, 1)
	go func() {
		resp, err := http.Post(ts.URL+"/api/watchers/poll", "", nil)
		if err != nil {
			done <- 0
			return
		}
		resp.Body.Close()
		done <- resp.StatusCode
	}()
	select {
	case code := <-done:
		if code != http.StatusAccepted {
			t.Fatalf("status = %d, want 202", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("POST /api/watchers/poll blocked; it must return without waiting for the poll")
	}
}
