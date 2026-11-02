package cmd

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	watcherdb "github.com/mturley/watcher/db"
	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
	"github.com/mturley/worktree/internal/resources"
	"github.com/mturley/worktree/internal/testgit"
)

func TestStaleReason(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) string { return now.Add(-d).Format(time.RFC3339) }
	tests := []struct {
		name    string
		last    string
		errMsg  string
		enabled bool
		active  bool
		want    string
	}{
		{"disabled", "", "", false, true, ""},
		{"disabled with old success", ago(time.Hour), "", false, true, ""},
		{"disabled with error", ago(time.Hour), "boom", false, true, ""},
		{"no resources, never polled", "", "", true, false, ""},
		{"no resources, frozen success", ago(time.Hour), "", true, false, ""},
		{"no resources, old error", ago(time.Hour), "boom", true, false, ""},
		{"active, never polled", "", "", true, true, staleNoSuccessYet},
		{"active, 14m ago", ago(14 * time.Minute), "", true, true, ""},
		{"active, 16m ago", ago(16 * time.Minute), "", true, true, stalePollOld},
		{"active, unparseable", "yesterday-ish", "", true, true, stalePollOld},
		{"active, never polled, failing", "", "boom", true, true, stalePollFailing},
		{"active, old success, failing", ago(time.Hour), "boom", true, true, stalePollFailing},
		// A recent success is fresh data, even with a later error.
		{"active, recent success, failing", ago(time.Minute), "boom", true, true, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := staleReason(now, tt.last, tt.errMsg, tt.enabled, tt.active); got != tt.want {
				t.Errorf("staleReason = %q, want %q", got, tt.want)
			}
		})
	}
}

func stubUIProbe(t *testing.T, running bool) {
	t.Helper()
	old := uiProbe
	uiProbe = func(int) bool { return running }
	t.Cleanup(func() { uiProbe = old })
}

func TestStatusJSONDisabledService(t *testing.T) {
	stubUIProbe(t, true)
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	cfg := config.DefaultConfig()
	cfg.Watchers.SetEnabled(config.ServiceSlack, false)

	rep, err := buildStatus(conn, cfg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := printJSON(&out, rep.fields()); err != nil {
		t.Fatal(err)
	}
	var got statusReport
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v\n%s", err, out.String())
	}
	var env map[string]any
	if err := json.Unmarshal(out.Bytes(), &env); err != nil || env["schema_version"] != float64(1) {
		t.Fatalf("schema_version missing: %v\n%s", err, out.String())
	}
	if !got.UIRunning || got.UIURL != "http://127.0.0.1:8475" {
		t.Errorf("ui = %v %q", got.UIRunning, got.UIURL)
	}
	var slackSeen bool
	for _, s := range got.Services {
		if s.Name == "slack" {
			slackSeen = true
			if s.Enabled || s.Stale {
				t.Errorf("slack = %+v, want disabled and not stale", s)
			}
		} else if !s.Enabled || s.Stale {
			t.Errorf("%s = %+v, want enabled and not stale (nothing to poll)", s.Name, s)
		}
	}
	if !slackSeen || got.Stale {
		t.Errorf("slackSeen=%v stale=%v", slackSeen, got.Stale)
	}
}

func TestStatusStaleWhenUINotRunning(t *testing.T) {
	stubUIProbe(t, false)
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	cfg := config.DefaultConfig()
	for _, svc := range config.Services {
		cfg.Watchers.SetEnabled(svc, false)
	}
	rep, err := buildStatus(conn, cfg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if rep.UIRunning || !rep.Stale {
		t.Errorf("running=%v stale=%v, want not running and stale", rep.UIRunning, rep.Stale)
	}
	if !reflect.DeepEqual(rep.StaleReason, []string{staleUINotRunning}) {
		t.Errorf("stale_reason = %v", rep.StaleReason)
	}
}

// statusFixture is a DB following one PR in a real worktree.
func statusFixture(t *testing.T) (*sql.DB, config.Config) {
	t.Helper()
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if err := resources.Add(conn, testgit.Worktree(t), resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	return conn, config.DefaultConfig()
}

func TestStatusUIUpNoResourcesNotStale(t *testing.T) {
	stubUIProbe(t, true)
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	rep, err := buildStatus(conn, config.DefaultConfig(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if rep.Stale || len(rep.StaleReason) != 0 {
		t.Errorf("stale=%v reasons=%v, want fresh", rep.Stale, rep.StaleReason)
	}
	if hints := statusHints(rep); len(hints) != 0 {
		t.Errorf("hints = %q, want none", hints)
	}
}

// The last Slack thread going away freezes last_success; 15 minutes later that
// must not read as out of date.
func TestStatusFrozenSuccessWithNoResourcesNotStale(t *testing.T) {
	stubUIProbe(t, true)
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := watcherdb.RecordPollerSuccess(conn, "slack"); err != nil {
		t.Fatal(err)
	}
	rep, err := buildStatus(conn, config.DefaultConfig(), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if rep.Stale {
		t.Errorf("rep = %+v, want not stale", rep)
	}
}

func TestStatusActiveResourceNeverPolled(t *testing.T) {
	stubUIProbe(t, true)
	conn, cfg := statusFixture(t)
	rep, err := buildStatus(conn, cfg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !rep.Stale || !reflect.DeepEqual(rep.StaleReason, []string{staleNoSuccessYet}) {
		t.Fatalf("stale=%v reasons=%v", rep.Stale, rep.StaleReason)
	}
	for _, s := range rep.Services {
		if s.Name == "github" && s.Reason != staleNoSuccessYet {
			t.Errorf("github reason = %q", s.Reason)
		}
		if s.Name != "github" && (s.Stale || s.Reason != "") {
			t.Errorf("%s = %+v, want fresh", s.Name, s)
		}
	}
	hints := strings.Join(statusHints(rep), "\n")
	if strings.Contains(hints, "worktree ui") {
		t.Errorf("UI is running but the hint says to start it: %q", hints)
	}
	if !strings.Contains(hints, "github") || !strings.Contains(hints, "worktree setup") {
		t.Errorf("hint should name the service and setup: %q", hints)
	}
}

func TestStatusPollFailingHintPointsAtTheError(t *testing.T) {
	stubUIProbe(t, true)
	conn, cfg := statusFixture(t)
	if err := watcherdb.RecordPollerError(conn, "github", "401 bad credentials"); err != nil {
		t.Fatal(err)
	}
	rep, err := buildStatus(conn, cfg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rep.StaleReason, []string{stalePollFailing}) {
		t.Fatalf("reasons = %v", rep.StaleReason)
	}
	hints := strings.Join(statusHints(rep), "\n")
	if !strings.Contains(hints, "401 bad credentials") || !strings.Contains(hints, "worktree setup") {
		t.Errorf("hints = %q", hints)
	}
	if strings.Contains(hints, "worktree ui") {
		t.Errorf("UI is running but the hint says to start it: %q", hints)
	}
}

func TestStatusPollOld(t *testing.T) {
	stubUIProbe(t, true)
	conn, cfg := statusFixture(t)
	if err := watcherdb.RecordPollerSuccess(conn, "github"); err != nil {
		t.Fatal(err)
	}
	rep, err := buildStatus(conn, cfg, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rep.StaleReason, []string{stalePollOld}) {
		t.Fatalf("reasons = %v", rep.StaleReason)
	}
	if hints := strings.Join(statusHints(rep), "\n"); strings.Contains(hints, "worktree ui") || !strings.Contains(hints, "github") {
		t.Errorf("hints = %q", hints)
	}
}

// With the UI down the only advice is to start it, whatever services report.
func TestStatusUINotRunningHint(t *testing.T) {
	stubUIProbe(t, false)
	conn, cfg := statusFixture(t)
	rep, err := buildStatus(conn, cfg, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rep.StaleReason, []string{staleUINotRunning, staleNoSuccessYet}) {
		t.Errorf("reasons = %v", rep.StaleReason)
	}
	if hints := statusHints(rep); !reflect.DeepEqual(hints, []string{staleHint}) {
		t.Errorf("hints = %q", hints)
	}
}

func TestStatusStaleReasonIsAnArrayWhenFresh(t *testing.T) {
	stubUIProbe(t, true)
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	rep, err := buildStatus(conn, config.DefaultConfig(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := rep.fields()["stale_reason"].([]any); !ok || len(got) != 0 {
		t.Errorf("stale_reason = %#v, want an empty array", rep.fields()["stale_reason"])
	}
}

// Not parallel: t.Setenv.
func TestStatusText(t *testing.T) {
	stubUIProbe(t, true)
	t.Setenv("WORKTREE_DB", filepath.Join(t.TempDir(), "w.db"))
	conn, err := wdb.Open()
	if err != nil {
		t.Fatal(err)
	}
	wt := testgit.Worktree(t)
	if err := resources.Add(conn, wt, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u"}); err != nil {
		t.Fatal(err)
	}
	if err := watcherdb.RecordPollerError(conn, "github", "401 bad credentials"); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	out, err := runCLI(t, "status")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"UI: running at http://127.0.0.1:8475\n",
		"github: never polled\n",
		"  error: 401 bad credentials\n",
		"jira: nothing to poll\n",
		"slack: nothing to poll\n",
		"worktree setup",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, staleHint) {
		t.Errorf("UI is running but the output says to start it:\n%s", out)
	}
}
