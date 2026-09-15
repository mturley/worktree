package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/config"
)

// TestBuildPlanJiraCredsAlwaysTested verifies Jira credentials are tested
// (and repaired if needed) via the shared credsetup flow every run, exactly
// like GitHub and Slack — see testAndRepairSharedCreds.
func TestBuildPlanJiraCredsAlwaysTested(t *testing.T) {
	for _, projects := range [][]string{nil, {"RHOAIENG"}} {
		cfg := config.DefaultConfig()
		cfg.Jira.Projects = projects
		plan := BuildPlan(cfg)
		if !plan.TestJiraCreds {
			t.Fatalf("TestJiraCreds should always be true (projects=%v)", projects)
		}
	}
}

// TestBuildPlanConfigureJiraProjects verifies ConfigureJiraProjects is only
// set when no project prefixes are configured yet — it is independent of
// Jira credential state (Projects has no watcher/credsetup equivalent).
func TestBuildPlanConfigureJiraProjects(t *testing.T) {
	cfg := config.DefaultConfig()
	plan := BuildPlan(cfg)
	if !plan.ConfigureJiraProjects {
		t.Fatal("expected ConfigureJiraProjects=true when Projects is empty")
	}

	cfg.Jira.Projects = []string{"RHOAIENG"}
	plan = BuildPlan(cfg)
	if plan.ConfigureJiraProjects {
		t.Fatal("expected ConfigureJiraProjects=false when Projects is already configured")
	}
}

// TestWriteConfigOnlyWritesJiraProjects verifies writeConfig never persists
// Jira credentials to worktree's own config.yaml — only Projects. Jira
// host/email/token are the shared watcher auth.yaml's responsibility
// (wcfg.Services.Jira via credsetup), so worktree's config.yaml must not
// duplicate them.
func TestWriteConfigOnlyWritesJiraProjects(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")

	cfg := config.DefaultConfig()
	cfg.Jira.Projects = []string{"RHOAIENG", "ODH"}

	if err := writeConfig(path, cfg); err != nil {
		t.Fatalf("writeConfig: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading written config: %v", err)
	}
	written := string(data)

	if strings.Contains(written, "host:") || strings.Contains(written, "email:") || strings.Contains(written, "token:") {
		t.Fatalf("written config must not contain Jira credentials, got:\n%s", written)
	}
	if !strings.Contains(written, "RHOAIENG") || !strings.Contains(written, "ODH") {
		t.Fatalf("written config must contain configured Jira projects, got:\n%s", written)
	}
}

func TestWriteConfigPreservesUISection(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	path := config.ConfigPath()

	cfg := config.DefaultConfig()
	cfg.UI.Password = "s3cret"
	cfg.UI.AllowedHosts = []string{"mturley-mac.local", "192.168.86.21"}
	cfg.UI.HTTPSPort = 9443
	cfg.UI.TLS = config.UITLSConfig{
		CertFile: filepath.Join(dir, "ui-cert.pem"),
		KeyFile:  filepath.Join(dir, "ui-key.pem"),
	}
	if err := writeConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	got, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.UI.Password != "s3cret" || got.UI.HTTPSPort != 9443 ||
		strings.Join(got.UI.AllowedHosts, ",") != "mturley-mac.local,192.168.86.21" ||
		got.UI.TLS != cfg.UI.TLS {
		t.Fatalf("round-tripped UI = %+v, want %+v", got.UI, cfg.UI)
	}
}

func TestWriteConfigOmitsEmptyUISection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := writeConfig(path, config.DefaultConfig()); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "ui:") {
		t.Fatalf("default config should not write a ui section, got:\n%s", data)
	}
}

func TestWriteConfigIsOwnerOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	// An existing, looser file: os.WriteFile alone would keep its mode.
	if err := os.WriteFile(path, []byte("worktrees_base: /x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := config.DefaultConfig()
	cfg.UI.Password = "s3cret"
	if err := writeConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config mode = %v, want 0600", perm)
	}
}
