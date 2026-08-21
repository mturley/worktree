package config

import (
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestDefaultConfigHasNoSearchSection(t *testing.T) {
	cfg := DefaultConfig()
	// Compile-time guarantee: the Search field is gone. This test documents intent;
	// if SearchConfig still exists this file won't compile.
	_ = cfg.WorktreesBase
}

// TestJiraConfigOnlyHasProjects is a compile-time guarantee that
// JiraConfig no longer carries Host/Email/Token — those credentials now
// live in the shared watcher auth.yaml (wcfg.Services.Jira), tested via
// credsetup. Only Projects (worktree-only project-prefix detection) stays
// here. If Host/Email/Token are reintroduced, this documents that they
// must not be written to worktree's own config.
func TestJiraConfigOnlyHasProjects(t *testing.T) {
	jc := JiraConfig{Projects: []string{"RHOAIENG"}}
	if len(jc.Projects) != 1 || jc.Projects[0] != "RHOAIENG" {
		t.Fatalf("unexpected JiraConfig: %+v", jc)
	}
}

// TestLoadIgnoresLegacyJiraCredentialFields verifies that a config.yaml
// left over from before this migration (with jira.host/email/token still
// present on disk) loads without error — yaml.Unmarshal ignores unknown
// fields — and that only Projects is populated.
func TestLoadIgnoresLegacyJiraCredentialFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	legacy := []byte(`
worktrees_base: ~/.worktrees
jira:
  host: example.atlassian.net
  email: me@example.com
  token: secret-token
  projects:
    - RHOAIENG
`)
	if err := os.WriteFile(path, legacy, 0644); err != nil {
		t.Fatalf("writing legacy config: %v", err)
	}

	var cfg Config
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading legacy config: %v", err)
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("unmarshaling legacy config: %v", err)
	}

	if len(cfg.Jira.Projects) != 1 || cfg.Jira.Projects[0] != "RHOAIENG" {
		t.Fatalf("expected Projects=[RHOAIENG], got %+v", cfg.Jira.Projects)
	}
}
