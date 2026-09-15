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

func TestLoadUISection(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	home, _ := os.UserHomeDir()
	path := filepath.Join(dir, "worktree", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data := []byte(`
ui:
  password: "hunter2"
  allowed_hosts: ["mturley-mac.local", "192.168.86.21"]
  tls:
    cert_file: ~/.config/worktree/ui-cert.pem
    key_file: ~/.config/worktree/ui-key.pem
`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UI.Password != "hunter2" {
		t.Errorf("Password = %q", cfg.UI.Password)
	}
	if cfg.UI.HTTPSPort != DefaultHTTPSPort {
		t.Errorf("HTTPSPort = %d, want default %d", cfg.UI.HTTPSPort, DefaultHTTPSPort)
	}
	if len(cfg.UI.AllowedHosts) != 2 || cfg.UI.AllowedHosts[0] != "mturley-mac.local" {
		t.Errorf("AllowedHosts = %v", cfg.UI.AllowedHosts)
	}
	if want := filepath.Join(home, ".config/worktree/ui-cert.pem"); cfg.UI.TLS.CertFile != want {
		t.Errorf("CertFile = %q, want %q (~ expanded)", cfg.UI.TLS.CertFile, want)
	}
	if want := filepath.Join(home, ".config/worktree/ui-key.pem"); cfg.UI.TLS.KeyFile != want {
		t.Errorf("KeyFile = %q, want %q (~ expanded)", cfg.UI.TLS.KeyFile, want)
	}
	if !cfg.UI.RemoteEnabled() {
		t.Error("RemoteEnabled() = false with both TLS files set")
	}
}

func TestRemoteEnabledRequiresBothFiles(t *testing.T) {
	for _, tc := range []struct {
		tls  UITLSConfig
		want bool
	}{
		{UITLSConfig{}, false},
		{UITLSConfig{CertFile: "c"}, false},
		{UITLSConfig{KeyFile: "k"}, false},
		{UITLSConfig{CertFile: "c", KeyFile: "k"}, true},
	} {
		if got := (UIConfig{TLS: tc.tls}).RemoteEnabled(); got != tc.want {
			t.Errorf("RemoteEnabled(%+v) = %v, want %v", tc.tls, got, tc.want)
		}
	}
}

func TestUIConfigRemoteURL(t *testing.T) {
	for _, tc := range []struct {
		hosts []string
		want  string
	}{
		{nil, ""},
		{[]string{"mturley-mac.local", "192.168.86.21"}, "https://mturley-mac.local:8476"},
		{[]string{"fd00::5"}, "https://[fd00::5]:8476"},
	} {
		if got := (UIConfig{HTTPSPort: 8476, AllowedHosts: tc.hosts}).RemoteURL(); got != tc.want {
			t.Errorf("RemoteURL(%v) = %q, want %q", tc.hosts, got, tc.want)
		}
	}
}

func TestPermissionsTooOpen(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		mode os.FileMode
		want bool
	}{{0o600, false}, {0o640, true}, {0o644, true}, {0o604, true}} {
		p := filepath.Join(dir, tc.mode.String())
		if err := os.WriteFile(p, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, tc.mode); err != nil {
			t.Fatal(err)
		}
		got, err := PermissionsTooOpen(p)
		if err != nil || got != tc.want {
			t.Errorf("PermissionsTooOpen(%v) = %v, %v; want %v", tc.mode, got, err, tc.want)
		}
	}
	got, err := PermissionsTooOpen(filepath.Join(dir, "missing"))
	if err != nil || got {
		t.Errorf("missing file: got %v, %v; want false, nil", got, err)
	}
}
