package setup

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/macapp"
	"github.com/mturley/worktree/internal/ui"
)

// MacAppAction is what the menu bar app step does this run.
type MacAppAction int

const (
	MacAppNone           MacAppAction = iota // not macOS, or installed and current
	MacAppNoSwiftc                           // macOS, swiftc missing: preview a hint only
	MacAppOfferInstall                       // interactive, not installed
	MacAppSkipUnattended                     // non-interactive, not installed
	MacAppRebuild                            // installed, hash differs
)

type macAppState struct {
	GOOS                       string
	HaveSwiftc, NonInteractive bool
	Installed                  bool
	InstalledHash, SourceHash  string
}

func decideMacApp(s macAppState) MacAppAction {
	if s.GOOS != "darwin" {
		return MacAppNone
	}
	if !s.HaveSwiftc {
		return MacAppNoSwiftc
	}
	if !s.Installed {
		if s.NonInteractive {
			return MacAppSkipUnattended
		}
		return MacAppOfferInstall
	}
	if s.InstalledHash != s.SourceHash {
		return MacAppRebuild
	}
	return MacAppNone
}

// detectMacApp gathers the real machine state for decideMacApp.
func detectMacApp() MacAppAction {
	s := macAppState{GOOS: runtime.GOOS, NonInteractive: ui.NonInteractive()}
	if s.GOOS != "darwin" {
		return MacAppNone
	}
	_, err := exec.LookPath("swiftc")
	s.HaveSwiftc = err == nil
	home, err := os.UserHomeDir()
	if err != nil {
		return MacAppNone
	}
	s.InstalledHash, s.Installed = macapp.InstalledHash(macapp.DefaultPaths(home).App)
	if s.SourceHash, err = macapp.SourceHash(macapp.Source); err != nil {
		return MacAppNone
	}
	return decideMacApp(s)
}

type macAppDeps struct {
	Paths    macapp.Paths
	LookPath func(string) (string, error)
	Run      macapp.Runner
	Confirm  func(string, bool) bool
	// Sleep is used while waiting for the app to quit; nil means time.Sleep.
	Sleep func(time.Duration)
}

func defaultMacAppDeps() macAppDeps {
	home, _ := os.UserHomeDir()
	return macAppDeps{
		Paths:    macapp.DefaultPaths(home),
		LookPath: exec.LookPath,
		Run: func(name string, args ...string) ([]byte, error) {
			return exec.Command(name, args...).CombinedOutput()
		},
		Confirm: confirmDefault,
	}
}

func runMacAppStep(a MacAppAction, d macAppDeps) error {
	if a != MacAppOfferInstall && a != MacAppRebuild {
		return nil
	}
	app := filepath.Clean(d.Paths.App)
	agent := filepath.Clean(d.Paths.LaunchAgent)

	if a == MacAppOfferInstall {
		if !d.Confirm("Install the worktree menu bar app?", true) {
			return nil
		}
		if err := buildMacApp(app, d); err != nil {
			return err
		}
		if d.Confirm("Start it at login?", true) {
			if err := writeLaunchAgent(app, agent); err != nil {
				return err
			}
			fmt.Printf("  %s Will start at login\n", ui.Green("✓"))
		}
		if out, err := d.Run("open", app); err != nil {
			return fmt.Errorf("starting the app: %w: %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	}

	// Rebuild: remember whether it is running before the bundle is swapped.
	running := macAppRunning(d)
	if err := buildMacApp(app, d); err != nil {
		return err
	}
	// Keep the login choice: only refresh a plist that already exists.
	if cur, err := os.ReadFile(agent); err == nil {
		if want := macapp.LaunchAgentPlist(app); !bytes.Equal(cur, want) {
			if err := writeLaunchAgent(app, agent); err != nil {
				return err
			}
		}
	}
	if running {
		quitMacApp(d)
		if out, err := d.Run("open", app); err != nil {
			return fmt.Errorf("restarting the app: %w: %s", err, strings.TrimSpace(string(out)))
		}
		fmt.Printf("  %s Restarted the menu bar app\n", ui.Green("✓"))
	}
	return nil
}

func buildMacApp(app string, d macAppDeps) error {
	if err := macapp.Build(macapp.Source, app, d.Run); err != nil {
		return fmt.Errorf("building the app: %w", err)
	}
	fmt.Printf("  %s Built %s\n", ui.Green("✓"), ui.ShortPath(app))
	return nil
}

func writeLaunchAgent(app, agent string) error {
	if err := os.MkdirAll(filepath.Dir(agent), 0o755); err != nil {
		return err
	}
	return os.WriteFile(agent, macapp.LaunchAgentPlist(app), 0o644)
}

// macAppRunning reports whether pgrep finds the app's process.
func macAppRunning(d macAppDeps) bool {
	out, err := d.Run("pgrep", "-x", macapp.ExecName)
	return err == nil && len(bytes.TrimSpace(out)) > 0
}

// quitMacApp asks the app to quit and waits briefly for it to go.
func quitMacApp(d macAppDeps) {
	_, _ = d.Run("osascript", "-e", `quit app id "`+macapp.BundleID+`"`)
	sleep := d.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	for i := 0; i < 15 && macAppRunning(d); i++ {
		sleep(200 * time.Millisecond)
	}
}

func pathExists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// PreviewMacAppUninstall prints what UninstallMacApp would remove and reports
// whether there is anything.
func PreviewMacAppUninstall(p macapp.Paths) (any bool) {
	if pathExists(p.App) {
		fmt.Printf("  • Remove the menu bar app: %s\n", ui.ShortPath(p.App))
		any = true
	}
	if pathExists(p.LaunchAgent) {
		fmt.Printf("  • Remove its login item: %s\n", ui.ShortPath(p.LaunchAgent))
		any = true
	}
	return any
}

// UninstallMacApp quits the app and removes it, its login item and its web
// view data. Missing pieces are not errors.
func UninstallMacApp(d macAppDeps) error {
	app, agent := filepath.Clean(d.Paths.App), filepath.Clean(d.Paths.LaunchAgent)
	if pathExists(app) || pathExists(agent) {
		if macAppRunning(d) {
			quitMacApp(d)
		}
		// The agent is usually not loaded, so a failure here is expected.
		_, _ = d.Run("launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), macapp.BundleID))
	}
	for _, p := range []string{agent, app, filepath.Clean(d.Paths.WebKitData)} {
		if !pathExists(p) {
			continue
		}
		if err := os.RemoveAll(p); err != nil {
			return fmt.Errorf("removing %s: %w", p, err)
		}
		fmt.Printf("  %s Removed %s\n", ui.Green("✓"), ui.ShortPath(p))
	}
	return nil
}

// MacAppUninstallPreview previews the real machine's menu bar app removal,
// under its own heading. False on non-macOS or when nothing is installed.
func MacAppUninstallPreview() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	p := defaultMacAppDeps().Paths
	if !pathExists(p.App) && !pathExists(p.LaunchAgent) {
		return false
	}
	fmt.Println(ui.Bold("worktree setup --uninstall-mac-app will:"))
	return PreviewMacAppUninstall(p)
}

// MacAppUninstall removes the real machine's menu bar app.
func MacAppUninstall() error { return UninstallMacApp(defaultMacAppDeps()) }
