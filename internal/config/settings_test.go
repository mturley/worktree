package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestSetCmuxFeaturesDisabledPreservesOtherKeysAndComments(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	orig := "# my worktree config\nworktrees_base: ~/.worktrees # where they live\nui:\n  password: secret\n  https_port: 9000\n"
	if err := os.WriteFile(path, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := SetCmuxFeaturesDisabled(path, true); err != nil {
		t.Fatalf("SetCmuxFeaturesDisabled: %v", err)
	}
	data, _ := os.ReadFile(path)
	got := string(data)
	for _, want := range []string{"# my worktree config", "# where they live", "password: secret", "https_port: 9000", "cmux_features_disabled: true"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}

	// Turning it back on removes the key rather than writing false: absent
	// is the default.
	if err := SetCmuxFeaturesDisabled(path, false); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(path)
	if strings.Contains(string(data), "cmux_features_disabled") {
		t.Errorf("key still present after re-enabling:\n%s", data)
	}
	if !strings.Contains(string(data), "password: secret") {
		t.Errorf("lost ui.password:\n%s", data)
	}
}

func TestSetCmuxFeaturesDisabledKeepsSetupFormatting(t *testing.T) {
	// The layout setup's writeConfig (yaml.Marshal) produces.
	path := filepath.Join(t.TempDir(), "config.yaml")
	orig := "worktrees_base: ~/.worktrees\njira:\n    projects:\n        - ABC\nui:\n    password: pw\n"
	if err := os.WriteFile(path, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SetCmuxFeaturesDisabled(path, true); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if want := orig + "    cmux_features_disabled: true\n"; string(data) != want {
		t.Fatalf("got:\n%s\nwant:\n%s", data, want)
	}
	if err := SetCmuxFeaturesDisabled(path, false); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); string(data) != orig {
		t.Fatalf("round trip changed the file:\n%s", data)
	}
}

func TestSetCmuxFeaturesDisabledCreatesUIBlockAndFile(t *testing.T) {
	dir := t.TempDir()

	// No ui: block yet.
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("worktrees_base: /x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SetCmuxFeaturesDisabled(path, true); err != nil {
		t.Fatal(err)
	}
	cfg := loadFrom(t, path)
	if !cfg.UI.CmuxFeaturesDisabled || cfg.WorktreesBase != "/x" {
		t.Errorf("got %+v", cfg)
	}

	// No file at all.
	missing := filepath.Join(dir, "sub", "config.yaml")
	if err := SetCmuxFeaturesDisabled(missing, true); err != nil {
		t.Fatal(err)
	}
	if !loadFrom(t, missing).UI.CmuxFeaturesDisabled {
		t.Error("not disabled after writing a fresh file")
	}
}

func loadFrom(t *testing.T, path string) Config {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg
}
