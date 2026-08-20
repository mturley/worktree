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
