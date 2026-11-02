package cmd

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/config"
	wdb "github.com/mturley/worktree/internal/db"
)

func TestStaleness(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) string { return now.Add(-d).Format(time.RFC3339) }
	tests := []struct {
		name    string
		last    string
		enabled bool
		want    bool
	}{
		{"disabled", "", false, false},
		{"disabled with old success", ago(time.Hour), false, false},
		{"empty", "", true, true},
		{"14m ago", ago(14 * time.Minute), true, false},
		{"16m ago", ago(16 * time.Minute), true, true},
		{"unparseable", "yesterday-ish", true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := staleness(now, tt.last, tt.enabled); got != tt.want {
				t.Errorf("staleness = %v, want %v", got, tt.want)
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
		} else if !s.Enabled || !s.Stale {
			t.Errorf("%s = %+v, want enabled and stale (never polled)", s.Name, s)
		}
	}
	if !slackSeen || !got.Stale {
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
}
