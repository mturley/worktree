package setup

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mturley/worktree/internal/macapp"
)

func TestDecideMacApp(t *testing.T) {
	t.Parallel()
	base := macAppState{GOOS: "darwin", HaveSwiftc: true, SourceHash: "new"}
	with := func(f func(*macAppState)) macAppState { s := base; f(&s); return s }
	cases := []struct {
		name string
		s    macAppState
		want MacAppAction
	}{
		{"linux", with(func(s *macAppState) { s.GOOS = "linux" }), MacAppNone},
		{"no swiftc", with(func(s *macAppState) { s.HaveSwiftc = false }), MacAppNoSwiftc},
		{"not installed, interactive", base, MacAppOfferInstall},
		{"not installed, non-interactive", with(func(s *macAppState) { s.NonInteractive = true }), MacAppSkipUnattended},
		{"missing bundle is not installed", with(func(s *macAppState) { s.Installed = false; s.InstalledHash = "new" }), MacAppOfferInstall},
		{"installed, current", with(func(s *macAppState) { s.Installed = true; s.InstalledHash = "new" }), MacAppNone},
		{"installed, stale", with(func(s *macAppState) { s.Installed = true; s.InstalledHash = "old" }), MacAppRebuild},
		{"installed, stale, non-interactive", with(func(s *macAppState) { s.Installed = true; s.InstalledHash = "old"; s.NonInteractive = true }), MacAppRebuild},
	}
	for _, c := range cases {
		if got := decideMacApp(c.s); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

type macFake struct {
	mu       sync.Mutex
	calls    [][]string
	running  bool // answers pgrep until osascript quits it
	answers  []bool
	prompts  []string
	buildErr error
}

func (f *macFake) run(name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, append([]string{name}, args...))
	switch name {
	case "swiftc":
		if f.buildErr != nil {
			return []byte("boom"), f.buildErr
		}
		for i, a := range args {
			if a == "-o" && i+1 < len(args) {
				return nil, os.WriteFile(args[i+1], []byte("binary"), 0o755)
			}
		}
		return nil, errors.New("no -o")
	case "pgrep":
		if f.running {
			return []byte("123\n"), nil
		}
		return nil, errors.New("exit 1")
	case "osascript":
		f.running = false
	}
	return nil, nil
}

func (f *macFake) confirm(p string, def bool) bool {
	f.prompts = append(f.prompts, p)
	a := f.answers[0]
	f.answers = f.answers[1:]
	return a
}

func (f *macFake) ran(name string) [][]string {
	var out [][]string
	for _, c := range f.calls {
		if c[0] == name {
			out = append(out, c)
		}
	}
	return out
}

func newMacDeps(t *testing.T, f *macFake) (macAppDeps, macapp.Paths) {
	t.Helper()
	home := t.TempDir()
	p := macapp.DefaultPaths(home)
	return macAppDeps{Paths: p, Run: f.run, Confirm: f.confirm, Sleep: func(time.Duration) {}}, p
}

func TestRunMacAppInstallAsksLogin(t *testing.T) {
	t.Parallel()
	t.Run("yes yes", func(t *testing.T) {
		f := &macFake{answers: []bool{true, true}}
		d, p := newMacDeps(t, f)
		if err := runMacAppStep(MacAppOfferInstall, d); err != nil {
			t.Fatal(err)
		}
		if got, want := f.prompts, []string{"Install the worktree menu bar app?", "Start it at login?"}; strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("prompts = %v", got)
		}
		if len(f.ran("swiftc")) != 1 {
			t.Error("did not build")
		}
		data, err := os.ReadFile(p.LaunchAgent)
		if err != nil || !bytes.Equal(data, macapp.LaunchAgentPlist(filepath.Clean(p.App))) {
			t.Errorf("plist = %q, %v", data, err)
		}
		if o := f.ran("open"); len(o) != 1 || o[0][1] != p.App {
			t.Errorf("open calls = %v", o)
		}
	})
	t.Run("yes no", func(t *testing.T) {
		f := &macFake{answers: []bool{true, false}}
		d, p := newMacDeps(t, f)
		if err := runMacAppStep(MacAppOfferInstall, d); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(p.LaunchAgent); err == nil {
			t.Error("plist written")
		}
		if len(f.ran("open")) != 1 {
			t.Error("app not opened")
		}
	})
	t.Run("no", func(t *testing.T) {
		f := &macFake{answers: []bool{false}}
		d, p := newMacDeps(t, f)
		if err := runMacAppStep(MacAppOfferInstall, d); err != nil {
			t.Fatal(err)
		}
		if len(f.calls) != 0 {
			t.Errorf("calls = %v", f.calls)
		}
		if _, err := os.Stat(p.App); err == nil {
			t.Error("app built")
		}
	})
	t.Run("build error is returned, nothing opened", func(t *testing.T) {
		f := &macFake{answers: []bool{true}, buildErr: errors.New("fail")}
		d, _ := newMacDeps(t, f)
		if err := runMacAppStep(MacAppOfferInstall, d); err == nil {
			t.Error("want error")
		}
		if len(f.ran("open")) != 0 {
			t.Error("opened after failed build")
		}
	})
}

func TestRunMacAppRebuildKeepsLoginChoice(t *testing.T) {
	t.Parallel()
	t.Run("no plist stays absent", func(t *testing.T) {
		f := &macFake{}
		d, p := newMacDeps(t, f)
		if err := runMacAppStep(MacAppRebuild, d); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(p.LaunchAgent); err == nil {
			t.Error("plist created")
		}
		if len(f.ran("swiftc")) != 1 || len(f.ran("open")) != 0 || len(f.prompts) != 0 {
			t.Errorf("calls = %v prompts = %v", f.calls, f.prompts)
		}
	})
	t.Run("stale plist rewritten", func(t *testing.T) {
		f := &macFake{}
		d, p := newMacDeps(t, f)
		os.MkdirAll(filepath.Dir(p.LaunchAgent), 0o755)
		os.WriteFile(p.LaunchAgent, []byte("stale"), 0o644)
		if err := runMacAppStep(MacAppRebuild, d); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(p.LaunchAgent)
		if !bytes.Equal(data, macapp.LaunchAgentPlist(filepath.Clean(p.App))) {
			t.Errorf("plist = %q", data)
		}
	})
	t.Run("current plist unchanged", func(t *testing.T) {
		f := &macFake{}
		d, p := newMacDeps(t, f)
		os.MkdirAll(filepath.Dir(p.LaunchAgent), 0o755)
		os.WriteFile(p.LaunchAgent, macapp.LaunchAgentPlist(filepath.Clean(p.App)), 0o444)
		before, _ := os.Stat(p.LaunchAgent)
		if err := runMacAppStep(MacAppRebuild, d); err != nil {
			t.Fatal(err)
		}
		after, _ := os.Stat(p.LaunchAgent)
		if !after.ModTime().Equal(before.ModTime()) || after.Mode() != before.Mode() {
			t.Error("current plist was rewritten")
		}
	})
	t.Run("running app is quit and reopened", func(t *testing.T) {
		f := &macFake{running: true}
		d, p := newMacDeps(t, f)
		if err := runMacAppStep(MacAppRebuild, d); err != nil {
			t.Fatal(err)
		}
		q := f.ran("osascript")
		if len(q) != 1 || strings.Join(q[0][1:], " ") != `-e quit app id "me.turley.worktree.menubar"` {
			t.Errorf("osascript = %v", q)
		}
		if g := f.ran("pgrep"); len(g) == 0 || strings.Join(g[0][1:], " ") != "-x WorktreeMenuBar" {
			t.Errorf("pgrep = %v", g)
		}
		if o := f.ran("open"); len(o) != 1 || o[0][1] != p.App {
			t.Errorf("open = %v", o)
		}
	})
	t.Run("not running is not opened", func(t *testing.T) {
		f := &macFake{}
		d, _ := newMacDeps(t, f)
		if err := runMacAppStep(MacAppRebuild, d); err != nil {
			t.Fatal(err)
		}
		if len(f.ran("open")) != 0 || len(f.ran("osascript")) != 0 {
			t.Errorf("calls = %v", f.calls)
		}
	})
}
