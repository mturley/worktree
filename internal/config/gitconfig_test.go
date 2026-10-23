package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGitConfigDefaults(t *testing.T) {
	var g GitConfig
	if !g.FetchEnabled() || g.Interval() != 3*time.Minute {
		t.Fatalf("defaults: enabled=%v interval=%v", g.FetchEnabled(), g.Interval())
	}
	off := false
	if (GitConfig{BackgroundFetch: &off}).FetchEnabled() {
		t.Fatal("explicit false should disable")
	}
	if got := (GitConfig{FetchInterval: "nonsense"}).Interval(); got != 3*time.Minute {
		t.Fatalf("invalid interval: %v", got)
	}
	if got := (GitConfig{FetchInterval: "10m"}).Interval(); got != 10*time.Minute {
		t.Fatalf("10m: %v", got)
	}
}

func TestGitConfigIntervalFloor(t *testing.T) {
	if got := (GitConfig{FetchInterval: "30s"}).Interval(); got != time.Minute {
		t.Fatalf("30s should floor to 1m, got %v", got)
	}
}

func TestEditableGitRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(sample), 0o600); err != nil {
		t.Fatal(err)
	}
	e, _, err := ReadEditable(p)
	if err != nil {
		t.Fatal(err)
	}
	if !e.BackgroundFetch || e.FetchInterval != "3m" {
		t.Fatalf("defaults read as %v %q", e.BackgroundFetch, e.FetchInterval)
	}
	e.BackgroundFetch, e.FetchInterval = false, "10m"
	if changed, err := WriteEditable(p, e); err != nil || !changed {
		t.Fatalf("write: %v %v", changed, err)
	}
	got, _, _ := ReadEditable(p)
	if got.BackgroundFetch || got.FetchInterval != "10m" {
		t.Fatalf("round trip: %+v", got)
	}
	// Back to defaults: the whole section goes.
	e.BackgroundFetch, e.FetchInterval = true, "3m"
	if _, err := WriteEditable(p, e); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(p)
	if strings.Contains(string(raw), "git:") || strings.Contains(string(raw), "fetch") {
		t.Fatalf("section left behind:\n%s", raw)
	}
}
