package cmd

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/uisession"
	"github.com/mturley/worktree/internal/uitls"
)

func writeTestCert(t *testing.T, hosts []string) uitls.Paths {
	t.Helper()
	b, err := uitls.Generate(hosts, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	p := uitls.DefaultPaths(t.TempDir())
	if err := uitls.Write(p, b); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestBuildSecurityRequiresAPassword(t *testing.T) {
	for _, localOnly := range []bool{false, true} {
		_, err := buildSecurity(config.UIConfig{}, &uisession.Store{}, localOnly)
		if err == nil || !strings.Contains(err.Error(), "ui.password") || !strings.Contains(err.Error(), "worktree setup") {
			t.Errorf("localOnly=%v: err = %v, want an instructional error naming ui.password and worktree setup", localOnly, err)
		}
	}
}

func TestBuildSecurityWithoutTLSIsLoopbackOnly(t *testing.T) {
	sec, err := buildSecurity(config.UIConfig{Password: "pw", HTTPSPort: 8476}, &uisession.Store{}, false)
	if err != nil {
		t.Fatal(err)
	}
	if sec.Remote() {
		t.Fatal("Remote() = true without a certificate")
	}
}

func TestBuildSecurityEnablesRemoteWhenBothFilesExist(t *testing.T) {
	p := writeTestCert(t, []string{"mturley-mac.local"})
	ui := config.UIConfig{
		Password: "pw", HTTPSPort: 8476, AllowedHosts: []string{"mturley-mac.local"},
		TLS: config.UITLSConfig{CertFile: p.Cert, KeyFile: p.Key},
	}
	sec, err := buildSecurity(ui, &uisession.Store{}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !sec.Remote() || sec.HTTPSPort != 8476 || sec.AllowedHosts[0] != "mturley-mac.local" {
		t.Fatalf("Security = %+v", sec)
	}

	sec, err = buildSecurity(ui, &uisession.Store{}, true)
	if err != nil {
		t.Fatal(err)
	}
	if sec.Remote() {
		t.Fatal("--local-only still enabled the HTTPS listener")
	}
}

func TestBuildSecurityRejectsHalfATLSConfig(t *testing.T) {
	for _, tlsCfg := range []config.UITLSConfig{{CertFile: "c.pem"}, {KeyFile: "k.pem"}} {
		_, err := buildSecurity(config.UIConfig{Password: "pw", TLS: tlsCfg}, &uisession.Store{}, true)
		if err == nil || !strings.Contains(err.Error(), "both cert_file and key_file") {
			t.Errorf("%+v: err = %v", tlsCfg, err)
		}
	}
}

func TestBuildSecurityRejectsAMissingCertificateFile(t *testing.T) {
	dir := t.TempDir()
	ui := config.UIConfig{Password: "pw", TLS: config.UITLSConfig{
		CertFile: filepath.Join(dir, "nope-cert.pem"), KeyFile: filepath.Join(dir, "nope-key.pem"),
	}}
	if _, err := buildSecurity(ui, &uisession.Store{}, false); err == nil || !strings.Contains(err.Error(), "nope-cert.pem") {
		t.Fatalf("err = %v, want it to name the missing file", err)
	}
}

func TestRemovedFlagsFailWithAPointer(t *testing.T) {
	for _, name := range []string{"bind", "yes"} {
		f := uiCmd.Flags().Lookup(name)
		if f == nil {
			t.Fatalf("--%s is not registered; it must stay registered to fail helpfully", name)
		}
		if !f.Hidden {
			t.Errorf("--%s is not hidden", name)
		}
		value := "0.0.0.0"
		if name == "yes" {
			value = "true"
		}
		if err := uiCmd.Flags().Set(name, value); err != nil {
			t.Fatal(err)
		}
		err := checkRemovedFlags(uiCmd)
		f.Changed = false
		if err == nil || !strings.Contains(err.Error(), "worktree setup") {
			t.Errorf("--%s: err = %v, want a pointer to worktree setup", name, err)
		}
	}
	if err := checkRemovedFlags(uiCmd); err != nil {
		t.Fatalf("no removed flags passed: err = %v", err)
	}
}

func TestWarnConfigPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	warnConfigPermissions(path, &out)
	if out.Len() != 0 {
		t.Fatalf("warned about a 0600 file: %q", out.String())
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	warnConfigPermissions(path, &out)
	if !strings.Contains(out.String(), "chmod 600") {
		t.Fatalf("output %q, want a chmod 600 hint", out.String())
	}
}

func TestCertCoverageWarning(t *testing.T) {
	p := writeTestCert(t, []string{"mturley-mac.local", "192.168.86.21"})
	for _, tc := range []struct {
		candidates []string
		warn       bool
	}{
		{nil, false},
		{[]string{"mturley-mac.local", "192.168.86.21"}, false},
		{[]string{"mturley-mac.local", "192.168.1.50"}, false}, // the name still works
		{[]string{"other-mac.local", "192.168.1.50"}, true},
	} {
		msg, err := certCoverageWarning(p.Cert, tc.candidates)
		if err != nil {
			t.Fatal(err)
		}
		if (msg != "") != tc.warn {
			t.Errorf("candidates %v: warning %q, want warn=%v", tc.candidates, msg, tc.warn)
		}
		if tc.warn && !strings.Contains(msg, "192.168.1.50") {
			t.Errorf("warning %q does not name the uncovered address", msg)
		}
	}
}
