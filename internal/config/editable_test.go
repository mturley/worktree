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
	if strings.Contains(s, "jira:") {
		t.Errorf("an emptied jira mapping should be removed:\n%s", s)
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
