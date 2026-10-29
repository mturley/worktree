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
	running  bool // answers pgrep until kill stops it
	stuck    bool // kill does not stop it
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
	case "kill":
		if !f.stuck {
			f.running = false
		}
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

func callIndex(f *macFake, name string) int {
	for i, c := range f.calls {
		if c[0] == name {
			return i
		}
	}
	return -1
}

// captureStdout swaps os.Stdout, so its callers must stay serial.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	defer func() { os.Stdout = old }()
	done := make(chan string)
	go func() {
		var b bytes.Buffer
		_, _ = b.ReadFrom(r)
		done <- b.String()
	}()
	fn()
	w.Close()
	return <-done
}

// Serial: captureStdout swaps os.Stdout.
func TestRunMacAppRebuildRestartMessage(t *testing.T) {
	for _, c := range []struct {
		name  string
		stuck bool
		want  string
		not   string
	}{
		{"quit", false, "Restarted the menu bar app", "still running"},
		{"stuck", true, "old build of the menu bar app is still running", "Restarted"},
	} {
		f := &macFake{running: true, stuck: c.stuck}
		d, _ := newMacDeps(t, f)
		var err error
		out := captureStdout(t, func() { err = runMacAppStep(MacAppRebuild, d) })
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !strings.Contains(out, c.want) || strings.Contains(out, c.not) {
			t.Errorf("%s: output = %q", c.name, out)
		}
	}
}

func TestSwiftToolchainUsable(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		out  string
		err  error
		want bool
	}{
		{"developer dir set", "/Library/Developer/CommandLineTools\n", nil, true},
		{"no developer dir", "xcode-select: error: unable to get active developer directory", errors.New("exit 2"), false},
		{"empty output", "", nil, false},
	}
	for _, c := range cases {
		var calls [][]string
		run := func(name string, args ...string) ([]byte, error) {
			calls = append(calls, append([]string{name}, args...))
			return []byte(c.out), c.err
		}
		if got := swiftToolchainUsable(run); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
		if len(calls) != 1 || strings.Join(calls[0], " ") != "xcode-select -p" {
			t.Errorf("%s: calls = %v", c.name, calls)
		}
	}
}

func TestQuitMacAppSkipsNonPIDs(t *testing.T) {
	t.Parallel()
	var calls [][]string
	run := func(name string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string{name}, args...))
		if name == "pgrep" {
			return []byte("12 -9 abc\n34\n"), nil
		}
		return nil, nil
	}
	quitMacApp(macAppDeps{Run: run, Sleep: func(time.Duration) {}})
	if len(calls) < 2 || strings.Join(calls[1], " ") != "kill -TERM 12 34" {
		t.Errorf("calls = %v", calls)
	}
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
		if len(f.ran("osascript")) != 0 {
			t.Errorf("sent an Apple Event: %v", f.ran("osascript"))
		}
		k := f.ran("kill")
		if len(k) != 1 || strings.Join(k[0][1:], " ") != "-TERM 123" {
			t.Errorf("kill = %v", k)
		}
		if g := f.ran("pgrep"); len(g) == 0 || strings.Join(g[0][1:], " ") != "-x WorktreeMenuBar" {
			t.Errorf("pgrep = %v", g)
		}
		if o := f.ran("open"); len(o) != 1 || o[0][1] != p.App {
			t.Errorf("open = %v", o)
		}
		if ki, oi := callIndex(f, "kill"), callIndex(f, "open"); ki < 0 || oi < ki {
			t.Errorf("kill (#%d) must come before open (#%d): %v", ki, oi, f.calls)
		}
	})
	t.Run("app that will not quit is reported, not called restarted", func(t *testing.T) {
		f := &macFake{running: true, stuck: true}
		d, _ := newMacDeps(t, f)
		if err := runMacAppStep(MacAppRebuild, d); err != nil {
			t.Fatal(err)
		}
		if len(f.ran("kill")) != 1 {
			t.Errorf("kill = %v", f.ran("kill"))
		}
		if got := quitMacApp(d); got {
			t.Error("quitMacApp reported a stuck app as gone")
		}
	})
	t.Run("not running is not opened", func(t *testing.T) {
		f := &macFake{}
		d, _ := newMacDeps(t, f)
		if err := runMacAppStep(MacAppRebuild, d); err != nil {
			t.Fatal(err)
		}
		if len(f.ran("open")) != 0 || len(f.ran("kill")) != 0 {
			t.Errorf("calls = %v", f.calls)
		}
	})
}

func writeInstalled(t *testing.T, p macapp.Paths, app, agent, webkit bool) {
	t.Helper()
	mk := func(on bool, path string, dir bool) {
		if !on {
			return
		}
		if dir {
			if err := os.MkdirAll(path, 0o755); err != nil {
				t.Fatal(err)
			}
			return
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk(app, p.App, true)
	mk(agent, p.LaunchAgent, false)
	mk(webkit, p.WebKitData, true)
}

func TestUninstallMacAppRemovesBoth(t *testing.T) {
	t.Parallel()
	f := &macFake{running: true}
	d, p := newMacDeps(t, f)
	writeInstalled(t, p, true, true, true)
	if !PreviewMacAppUninstall(p) {
		t.Error("preview found nothing")
	}
	if err := UninstallMacApp(d); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{p.App, p.LaunchAgent, p.WebKitData} {
		if _, err := os.Stat(path); err == nil {
			t.Errorf("%s still exists", path)
		}
	}
	if k := f.ran("kill"); len(k) != 1 || strings.Join(k[0][1:], " ") != "-TERM 123" {
		t.Errorf("kill calls = %v", k)
	}
	if len(f.ran("osascript")) != 0 {
		t.Errorf("sent an Apple Event: %v", f.ran("osascript"))
	}
	lc := f.ran("launchctl")
	if len(lc) != 1 || lc[0][1] != "bootout" || !strings.HasSuffix(lc[0][2], "/"+macapp.BundleID) {
		t.Errorf("launchctl calls = %v", lc)
	}
}

func TestUninstallMacAppRemovesStrayPlist(t *testing.T) {
	t.Parallel()
	f := &macFake{}
	d, p := newMacDeps(t, f)
	writeInstalled(t, p, false, true, false)
	if !PreviewMacAppUninstall(p) {
		t.Error("preview found nothing")
	}
	if err := UninstallMacApp(d); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.LaunchAgent); err == nil {
		t.Error("plist still exists")
	}
	if len(f.ran("kill")) != 0 {
		t.Error("quit an app that was not running")
	}
}

func TestUninstallMacAppNothingInstalled(t *testing.T) {
	t.Parallel()
	f := &macFake{}
	d, p := newMacDeps(t, f)
	if PreviewMacAppUninstall(p) {
		t.Error("preview found something")
	}
	if err := UninstallMacApp(d); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 0 {
		t.Errorf("Run called: %v", f.calls)
	}
}
