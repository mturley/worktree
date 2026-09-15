package setup

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/uitls"
)

// scriptedIO answers prompts from queues and fails the test on any prompt it
// was not scripted for.
type scriptedIO struct {
	t        *testing.T
	confirms []bool
	lines    []string
	prompts  []string
	out      strings.Builder
}

func (s *scriptedIO) ConfirmDefault(prompt string, _ bool) bool {
	s.prompts = append(s.prompts, prompt)
	if len(s.confirms) == 0 {
		s.t.Fatalf("unscripted confirm: %q", prompt)
	}
	v := s.confirms[0]
	s.confirms = s.confirms[1:]
	return v
}

func (s *scriptedIO) PromptLine(prompt string) string {
	s.prompts = append(s.prompts, prompt)
	if len(s.lines) == 0 {
		s.t.Fatalf("unscripted prompt: %q", prompt)
	}
	v := s.lines[0]
	s.lines = s.lines[1:]
	return v
}

func (s *scriptedIO) Printf(format string, args ...any) { fmt.Fprintf(&s.out, format, args...) }

func (s *scriptedIO) done() {
	s.t.Helper()
	if len(s.confirms) != 0 || len(s.lines) != 0 {
		s.t.Fatalf("unused answers: confirms %v, lines %v", s.confirms, s.lines)
	}
}

func (s *scriptedIO) asked(substr string) bool {
	return slices.ContainsFunc(s.prompts, func(p string) bool { return strings.Contains(p, substr) })
}

var setupNow = time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)

func testDeps(t *testing.T, io *scriptedIO, detected ...string) uiAccessDeps {
	return uiAccessDeps{
		io:     io,
		detect: func() []string { return detected },
		paths:  uitls.DefaultPaths(t.TempDir()),
		now:    func() time.Time { return setupNow },
		random: bytes.NewReader(bytes.Repeat([]byte{7}, 64)),
	}
}

func TestEnsurePasswordGeneratesAndPrintsOnce(t *testing.T) {
	io := &scriptedIO{t: t}
	cfg := config.DefaultConfig()
	changed, err := ensurePassword(&cfg, testDeps(t, io))
	if err != nil || !changed {
		t.Fatalf("ensurePassword = %v, %v", changed, err)
	}
	if len(cfg.UI.Password) != 24 {
		t.Fatalf("password %q: want 24 characters", cfg.UI.Password)
	}
	if !strings.Contains(io.out.String(), cfg.UI.Password) {
		t.Fatal("the generated password was not shown; the user needs it to log in")
	}
}

func TestEnsurePasswordKeepsAnExistingOne(t *testing.T) {
	io := &scriptedIO{t: t}
	cfg := config.DefaultConfig()
	cfg.UI.Password = "mine"
	changed, err := ensurePassword(&cfg, testDeps(t, io))
	if err != nil || changed || cfg.UI.Password != "mine" {
		t.Fatalf("ensurePassword = %v, %v; password %q", changed, err, cfg.UI.Password)
	}
	if strings.Contains(io.out.String(), "mine") {
		t.Fatal("an existing password was printed")
	}
}

func TestRemoteAccessIsOffByDefault(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{false}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || changed || cfg.UI.RemoteEnabled() {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if _, err := os.Stat(d.paths.CA); err == nil {
		t.Fatal("a certificate was written after declining")
	}
}

func TestRemoteAccessAcceptsDetectedAddresses(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, true}}
	d := testDeps(t, io, "mturley-mac.local", "192.168.86.21")
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if strings.Join(cfg.UI.AllowedHosts, ",") != "mturley-mac.local,192.168.86.21" {
		t.Fatalf("AllowedHosts = %v", cfg.UI.AllowedHosts)
	}
	if cfg.UI.TLS.CertFile != d.paths.Cert || cfg.UI.TLS.KeyFile != d.paths.Key {
		t.Fatalf("TLS = %+v, want %+v", cfg.UI.TLS, d.paths)
	}
	cert, err := uitls.ReadCert(d.paths.Cert)
	if err != nil {
		t.Fatal(err)
	}
	if got := uitls.Uncovered(cert, cfg.UI.AllowedHosts); len(got) != 0 {
		t.Fatalf("certificate does not cover %v", got)
	}
	out := io.out.String()
	for _, want := range []string{d.paths.CA, "https://mturley-mac.local:8476", "network may be monitored"} {
		if !strings.Contains(out, want) {
			t.Errorf("output does not mention %q:\n%s", want, out)
		}
	}
}

func TestRemoteAccessDeclinedDetectionAsksForAnIP(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, false}, lines: []string{"not-an-ip", "192.168.1.50"}}
	d := testDeps(t, io, "mturley-mac.local", "192.168.86.21")
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if strings.Join(cfg.UI.AllowedHosts, ",") != "192.168.1.50" {
		t.Fatalf("AllowedHosts = %v, want only the typed IP", cfg.UI.AllowedHosts)
	}
	if !strings.Contains(io.out.String(), "not an IP address") {
		t.Error("an invalid answer was not explained")
	}
}

func TestRemoteAccessEmptyAnswerSkips(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, false}, lines: []string{""}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || changed || cfg.UI.RemoteEnabled() {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(d.paths.CA)); len(entries) != 0 {
		t.Fatalf("files written after skipping: %v", entries)
	}
}

func TestRemoteAccessWithNothingDetectedGoesStraightToThePrompt(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true}, lines: []string{"10.0.0.7"}}
	cfg := config.DefaultConfig()
	changed, err := configureRemoteAccess(&cfg, testDeps(t, io))
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	if io.asked("Use these addresses") {
		t.Fatal("offered detected addresses when none were detected")
	}
}

// configured returns a config whose remote access was set up by the real flow.
func configured(t *testing.T, d uiAccessDeps) config.Config {
	t.Helper()
	cfg := config.DefaultConfig()
	setupIO := d.io
	d.io = &scriptedIO{t: t, confirms: []bool{true, true}}
	if _, err := configureRemoteAccess(&cfg, d); err != nil {
		t.Fatal(err)
	}
	d.io = setupIO
	return cfg
}

func TestConfiguredDecliningChangeTouchesNothing(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{false}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	before, _ := os.ReadFile(d.paths.Cert)
	beforeKey, _ := os.ReadFile(d.paths.Key)
	beforeCfg := cfg

	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	after, _ := os.ReadFile(d.paths.Cert)
	afterKey, _ := os.ReadFile(d.paths.Key)
	if !bytes.Equal(before, after) || !bytes.Equal(beforeKey, afterKey) {
		t.Fatal("certificate or key rewritten after declining to change")
	}
	if !slices.Equal(beforeCfg.UI.AllowedHosts, cfg.UI.AllowedHosts) || beforeCfg.UI.TLS != cfg.UI.TLS {
		t.Fatal("config changed after declining to change")
	}
	if !strings.Contains(io.out.String(), "https://mturley-mac.local:8476") {
		t.Errorf("current addresses not shown:\n%s", io.out.String())
	}
}

func TestConfiguredAcceptingChangeReissues(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, false}, lines: []string{"192.168.1.50"}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	before, _ := os.ReadFile(d.paths.CA)

	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	after, _ := os.ReadFile(d.paths.CA)
	if bytes.Equal(before, after) {
		t.Fatal("CA not reissued")
	}
	if strings.Join(cfg.UI.AllowedHosts, ",") != "192.168.1.50" {
		t.Fatalf("AllowedHosts = %v", cfg.UI.AllowedHosts)
	}
	if !strings.Contains(io.out.String(), "remove the old") {
		t.Errorf("no reinstall warning:\n%s", io.out.String())
	}
}

func TestConfiguredEmptyAnswerKeepsExistingAddresses(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true, false}, lines: []string{""}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || changed || strings.Join(cfg.UI.AllowedHosts, ",") != "mturley-mac.local" {
		t.Fatalf("configureRemoteAccess = %v, %v; hosts %v", changed, err, cfg.UI.AllowedHosts)
	}
}

func TestConfiguredOffersRenewalNearExpiry(t *testing.T) {
	io := &scriptedIO{t: t, confirms: []bool{true}}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	old, _ := uitls.ReadCert(d.paths.Cert)

	later := setupNow.Add(uitls.LeafValidity - 10*24*time.Hour)
	d.now = func() time.Time { return later }
	changed, err := configureRemoteAccess(&cfg, d)
	io.done()
	if err != nil || !changed {
		t.Fatalf("configureRemoteAccess = %v, %v", changed, err)
	}
	renewed, _ := uitls.ReadCert(d.paths.Cert)
	if !renewed.NotAfter.After(old.NotAfter) {
		t.Fatalf("NotAfter %v not later than %v", renewed.NotAfter, old.NotAfter)
	}
	if !io.asked("Renew") || io.asked("Change remote access") {
		t.Fatalf("prompts = %v, want renewal and no change prompt", io.prompts)
	}
}

func TestConfigureUIWritesAnOwnerOnlyConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	io := &scriptedIO{t: t, confirms: []bool{false}}
	d := testDeps(t, io)
	if err := configureUI(config.ConfigPath(), d); err != nil {
		t.Fatal(err)
	}
	io.done()
	info, err := os.Stat(config.ConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode %v, want 0600", info.Mode().Perm())
	}
	cfg, _ := config.Load()
	if cfg.UI.Password == "" {
		t.Fatal("password not saved")
	}
}

func TestRemoveRemoteAccess(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	io := &scriptedIO{t: t}
	d := testDeps(t, io, "mturley-mac.local")
	cfg := configured(t, d)
	cfg.UI.Password = "keep-me"
	if err := writeConfig(config.ConfigPath(), cfg); err != nil {
		t.Fatal(err)
	}

	if err := removeRemoteAccess(config.ConfigPath(), d); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{d.paths.CA, d.paths.Cert, d.paths.Key} {
		if _, err := os.Stat(f); err == nil {
			t.Errorf("%s still exists", f)
		}
	}
	got, _ := config.Load()
	if got.UI.RemoteEnabled() || len(got.UI.AllowedHosts) != 0 || got.UI.Password != "keep-me" {
		t.Fatalf("UI after uninstall = %+v; want TLS and hosts cleared, password kept", got.UI)
	}
	if !strings.Contains(io.out.String(), "Trusted credentials") {
		t.Errorf("no phone removal steps:\n%s", io.out.String())
	}
}

func TestRemoveRemoteAccessWithNothingConfiguredWritesNothing(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	io := &scriptedIO{t: t}
	if err := removeRemoteAccess(config.ConfigPath(), testDeps(t, io)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(config.ConfigPath()); err == nil {
		t.Fatal("uninstall created a config file")
	}
}
