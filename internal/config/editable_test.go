package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const sample = `# my worktree config
worktrees_base: ~/.worktrees # where they go
custom_key: keep-me
jira:
    projects:
        - ABC
ui:
    password: secret
    allowed_hosts:
        - host.local
    tls:
        cert_file: ~/c.pem
        key_file: ~/k.pem
`

func writeSample(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(sample), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadEditableKeepsTildeAndIgnoresEnv(t *testing.T) {
	t.Setenv("WORKTREES_BASE", "/elsewhere")
	p := writeSample(t)
	got, pwSet, err := ReadEditable(p)
	if err != nil {
		t.Fatal(err)
	}
	want := Editable{
		WorktreesBase: "~/.worktrees",
		JiraProjects:  []string{"ABC"},
		HTTPSPort:     DefaultHTTPSPort,
		AllowedHosts:  []string{"host.local"},
		TLSCertFile:   "~/c.pem",
		TLSKeyFile:    "~/k.pem",
		// Every watcher on: present but empty, so callers can index it.
		WatchersDisabled: map[string]bool{},
	}
	if !reflect.DeepEqual(got, want) || !pwSet {
		t.Fatalf("got %+v pwSet=%v", got, pwSet)
	}
}

func TestReadEditableMissingFile(t *testing.T) {
	got, pwSet, err := ReadEditable(filepath.Join(t.TempDir(), "nope.yaml"))
	if err != nil || pwSet || got.HTTPSPort != DefaultHTTPSPort {
		t.Fatalf("got %+v pwSet=%v err=%v", got, pwSet, err)
	}
}

func TestWriteEditablePreservesCommentsAndUnknownKeys(t *testing.T) {
	p := writeSample(t)
	cur, _, _ := ReadEditable(p)
	cur.Editor = "zed"
	cur.JiraProjects = []string{"ABC", "DEF"}
	changed, err := WriteEditable(p, cur)
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	data, _ := os.ReadFile(p)
	s := string(data)
	for _, want := range []string{"# my worktree config", "# where they go", "custom_key: keep-me", "password: secret", "editor: zed", "- DEF", "worktrees_base: ~/.worktrees"} {
		if !strings.Contains(s, want) {
			t.Errorf("file lost %q:\n%s", want, s)
		}
	}
	if info, _ := os.Stat(p); info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o", info.Mode().Perm())
	}
}

func TestWriteEditableNoChangeDoesNotRewrite(t *testing.T) {
	p := writeSample(t)
	cur, _, _ := ReadEditable(p)
	changed, err := WriteEditable(p, cur)
	if err != nil || changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	data, _ := os.ReadFile(p)
	if string(data) != sample {
		t.Fatalf("file rewritten:\n%s", data)
	}
}

func TestWriteEditableDefaultsDeleteKeys(t *testing.T) {
	p := writeSample(t)
	cur, _, _ := ReadEditable(p)
	cur.JiraProjects = nil
	cur.AllowedHosts = nil
	cur.HTTPSPort = DefaultHTTPSPort
	cur.CmuxFeaturesDisabled = true
	if _, err := WriteEditable(p, cur); err != nil {
		t.Fatal(err)
	}
	cur.CmuxFeaturesDisabled = false
	if _, err := WriteEditable(p, cur); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	s := string(data)
	for _, gone := range []string{"projects", "allowed_hosts", "https_port", "cmux_features_disabled"} {
		if strings.Contains(s, gone) {
			t.Errorf("%s should be removed:\n%s", gone, s)
		}
	}
	for _, keep := range []string{"password: secret", "custom_key: keep-me"} {
		if !strings.Contains(s, keep) {
			t.Errorf("file lost %q:\n%s", keep, s)
		}
	}
	if strings.Contains(s, "jira:") {
		t.Errorf("an emptied jira mapping should be removed:\n%s", s)
	}
}

// A watcher is written only as `false` when turned off, and re-enabling
// deletes the key (and the emptied watchers mapping).
func TestWriteEditableWatchers(t *testing.T) {
	p := writeSample(t)
	cur, _, _ := ReadEditable(p)
	for _, svc := range Services {
		if !cur.WatcherEnabled(svc) {
			t.Fatalf("%s should default to enabled", svc)
		}
	}
	cur.WatchersDisabled = map[string]bool{ServiceJira: true, ServiceSlack: true}
	if _, err := WriteEditable(p, cur); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	if s := string(data); !strings.Contains(s, "watchers:\n    jira: false\n    slack: false\n") || strings.Contains(s, "github:") {
		t.Fatalf("unexpected watchers block:\n%s", s)
	}
	got, _, _ := ReadEditable(p)
	if got.WatcherEnabled(ServiceJira) || got.WatcherEnabled(ServiceSlack) || !got.WatcherEnabled(ServiceGitHub) {
		t.Fatalf("read back %+v", got.WatchersDisabled)
	}
	got.WatchersDisabled = map[string]bool{}
	if _, err := WriteEditable(p, got); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(p)
	if strings.Contains(string(data), "watchers") {
		t.Fatalf("re-enabling should remove the watchers mapping:\n%s", data)
	}
}

func TestWatchersConfigEnabled(t *testing.T) {
	var w WatchersConfig
	w.SetEnabled(ServiceGitHub, false)
	if w.Enabled(ServiceGitHub) || !w.Enabled(ServiceJira) {
		t.Fatalf("%+v", w)
	}
	w.SetEnabled(ServiceGitHub, true)
	if w.GitHub != nil {
		t.Fatal("enabling should clear the key, not write true")
	}
}

func TestWriteEditableCreatesFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "d", "config.yaml")
	if _, err := WriteEditable(p, Editable{Editor: "vim", HTTPSPort: 9000}); err != nil {
		t.Fatal(err)
	}
	got, _, _ := ReadEditable(p)
	if got.Editor != "vim" || got.HTTPSPort != 9000 {
		t.Fatalf("got %+v", got)
	}
}

func TestWriteEditableIsAtomicAndOwnerOnly(t *testing.T) {
	p := writeSample(t)
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	cur, _, _ := ReadEditable(p)
	cur.Editor = "zed"
	if _, err := WriteEditable(p, cur); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(p); info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(filepath.Dir(p))
	if len(entries) != 1 {
		t.Errorf("leftover files: %v", entries)
	}
}

func TestSetPassword(t *testing.T) {
	p := writeSample(t)
	if err := SetPassword(p, "new-pw"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	if !strings.Contains(string(data), "password: new-pw") || !strings.Contains(string(data), "# my worktree config") {
		t.Fatalf("got:\n%s", data)
	}
}
