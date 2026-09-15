package setup

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/netdetect"
	"github.com/mturley/worktree/internal/ui"
	"github.com/mturley/worktree/internal/uitls"
)

// renewWindow is how close to expiry setup offers to renew the certificate.
const renewWindow = 30 * 24 * time.Hour

// uiIO is the terminal interaction the web UI steps need, so tests can
// script the answers.
type uiIO interface {
	ConfirmDefault(prompt string, defaultYes bool) bool
	PromptLine(prompt string) string
	Printf(format string, args ...any)
}

type terminalIO struct{}

func (terminalIO) ConfirmDefault(p string, d bool) bool { return ui.ConfirmDefault(p, d) }
func (terminalIO) PromptLine(p string) string           { return ui.PromptLine(p) }
func (terminalIO) Printf(f string, a ...any)            { fmt.Printf(f, a...) }

type uiAccessDeps struct {
	io     uiIO
	detect func() []string
	paths  uitls.Paths
	now    func() time.Time
	random io.Reader
}

func defaultUIAccessDeps(configPath string) uiAccessDeps {
	return uiAccessDeps{
		io:     terminalIO{},
		detect: netdetect.Candidates,
		paths:  uitls.DefaultPaths(filepath.Dir(configPath)),
		now:    time.Now,
		random: rand.Reader,
	}
}

// configureUI runs the web UI steps and saves the config if either changed
// it. It reloads the config first: earlier steps in this run may have
// written it, and saving a stale copy would undo them.
func configureUI(configPath string, d uiAccessDeps) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	d.io.Printf("\n%s\n", ui.Bold("Web UI:"))
	pw, err := ensurePassword(&cfg, d)
	if err != nil {
		return err
	}
	remote, err := configureRemoteAccess(&cfg, d)
	if err != nil {
		return err
	}
	if !pw && !remote {
		return writeConfigIfLoose(configPath, cfg)
	}
	if err := writeConfig(configPath, cfg); err != nil {
		return err
	}
	d.io.Printf("  %s Updated %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	return nil
}

// writeConfigIfLoose rewrites an existing config only to tighten its mode:
// it may hold a password from before setup wrote configs owner-only.
func writeConfigIfLoose(configPath string, cfg config.Config) error {
	open, err := config.PermissionsTooOpen(configPath)
	if err != nil || !open || cfg.UI.Password == "" {
		return err
	}
	return writeConfig(configPath, cfg)
}

// ensurePassword generates a password when none is configured, and prints it
// once, because the user needs it to log in from another device.
func ensurePassword(cfg *config.Config, d uiAccessDeps) (bool, error) {
	if cfg.UI.Password != "" {
		return false, nil
	}
	b := make([]byte, 18)
	if _, err := io.ReadFull(d.random, b); err != nil {
		return false, fmt.Errorf("generating a password: %w", err)
	}
	cfg.UI.Password = base64.RawURLEncoding.EncodeToString(b)
	d.io.Printf("  %s Generated a web UI password: %s\n", ui.Green("✓"), cfg.UI.Password)
	d.io.Printf("    It is saved as ui.password in the worktree config.\n")
	return true, nil
}

// configureRemoteAccess sets up, renews or changes the HTTPS listener's
// certificate and addresses. It reports whether it changed cfg.
func configureRemoteAccess(cfg *config.Config, d uiAccessDeps) (bool, error) {
	if !cfg.UI.RemoteEnabled() {
		if !d.io.ConfirmDefault("  Enable HTTPS access to the web UI from other devices (e.g. your phone)?", false) {
			return false, nil
		}
		hosts := chooseRemoteHosts(d)
		if hosts == nil {
			d.io.Printf("  %s Skipped remote access\n", ui.Dim("—"))
			return false, nil
		}
		return true, issueCertificate(cfg, hosts, d)
	}

	d.io.Printf("  Remote access: %s\n", describeRemote(cfg.UI))
	cert, err := uitls.ReadCert(cfg.UI.TLS.CertFile)
	switch {
	case err != nil:
		d.io.Printf("  %s Could not read the certificate: %v\n", ui.Yellow("!"), err)
		if d.io.ConfirmDefault("  Re-issue it?", false) {
			return true, reissue(cfg, cfg.UI.AllowedHosts, d)
		}
	case cert.NotAfter.Sub(d.now()) < renewWindow:
		d.io.Printf("  %s Certificate expires %s\n", ui.Yellow("!"), cert.NotAfter.Format("2006-01-02"))
		if d.io.ConfirmDefault("  Renew it now?", false) {
			return true, reissue(cfg, cfg.UI.AllowedHosts, d)
		}
	default:
		d.io.Printf("  Certificate expires %s\n", cert.NotAfter.Format("2006-01-02"))
	}

	if !d.io.ConfirmDefault("  Change remote access addresses?", false) {
		return false, nil
	}
	hosts := chooseRemoteHosts(d)
	if hosts == nil {
		d.io.Printf("  %s Kept the existing addresses\n", ui.Dim("—"))
		return false, nil
	}
	return true, reissue(cfg, hosts, d)
}

// chooseRemoteHosts offers the detected addresses, then falls back to asking
// for an IP. nil means the user skipped.
func chooseRemoteHosts(d uiAccessDeps) []string {
	if candidates := d.detect(); len(candidates) > 0 {
		d.io.Printf("\n  Detected:\n")
		for _, c := range candidates {
			d.io.Printf("    %s\n", c)
		}
		if d.io.ConfirmDefault("  Use these addresses?", true) {
			return candidates
		}
	}
	for {
		answer := strings.TrimSpace(d.io.PromptLine("  Which IP address should other devices use? (Enter to skip)"))
		if answer == "" {
			return nil
		}
		if net.ParseIP(answer) != nil {
			return []string{answer}
		}
		d.io.Printf("  %s %q is not an IP address\n", ui.Yellow("!"), answer)
	}
}

// reissue replaces an existing certificate. The old CA's key no longer
// exists, so the phone needs the new CA.
func reissue(cfg *config.Config, hosts []string, d uiAccessDeps) error {
	d.io.Printf("  %s This creates a new CA. On your phone, remove the old %q certificate and install the new one.\n",
		ui.Yellow("!"), uitls.CACommonName)
	return issueCertificate(cfg, hosts, d)
}

func issueCertificate(cfg *config.Config, hosts []string, d uiAccessDeps) error {
	bundle, err := uitls.Generate(hosts, d.now())
	if err != nil {
		return fmt.Errorf("generating the certificate: %w", err)
	}
	if err := uitls.Write(d.paths, bundle); err != nil {
		return err
	}
	cfg.UI.AllowedHosts = hosts
	cfg.UI.TLS = config.UITLSConfig{CertFile: d.paths.Cert, KeyFile: d.paths.Key}
	if cfg.UI.HTTPSPort == 0 {
		cfg.UI.HTTPSPort = config.DefaultHTTPSPort
	}
	d.io.Printf("  %s Issued an HTTPS certificate for %s, valid until %s\n",
		ui.Green("✓"), strings.Join(hosts, ", "), bundle.NotAfter.Format("2006-01-02"))
	d.io.Printf(`
    To use it from your phone:
      1. Copy %s to the phone (for example by email or USB).
      2. Android: Settings → Security → Encryption & credentials → Install a
         certificate → CA certificate. Menu names vary by Android version.
      3. Open %s

    While this CA is installed, Android shows a persistent
    "network may be monitored" notice. That is expected for any
    user-installed CA and does not mean anything is wrong.

    Renewal: run "worktree setup" again before %s.
`, d.paths.CA, cfg.UI.RemoteURL(), bundle.NotAfter.Format("2006-01-02"))
	return nil
}

func describeRemote(u config.UIConfig) string {
	s := u.RemoteURL()
	if len(u.AllowedHosts) > 1 {
		s += " (also " + strings.Join(u.AllowedHosts[1:], ", ") + ")"
	}
	return s
}

// removeRemoteAccess deletes the certificate files and clears ui.tls and
// ui.allowed_hosts, keeping the password. It writes the config only if it
// had something to clear.
func removeRemoteAccess(configPath string, d uiAccessDeps) error {
	removed, err := uitls.Remove(d.paths)
	for _, f := range removed {
		d.io.Printf("  %s Removed %s\n", ui.Green("✓"), f)
	}
	if err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	cleared := cfg.UI.TLS != (config.UITLSConfig{}) || len(cfg.UI.AllowedHosts) > 0
	if cleared {
		cfg.UI.TLS = config.UITLSConfig{}
		cfg.UI.AllowedHosts = nil
		if err := writeConfig(configPath, cfg); err != nil {
			return err
		}
		d.io.Printf("  %s Cleared remote access from %s\n", ui.Green("✓"), ui.ShortPath(configPath))
	}
	if len(removed) > 0 || cleared {
		d.io.Printf(`
    Also remove the CA from your phone. Android: Settings → Security →
    Encryption & credentials → Trusted credentials → User → %q → Remove.
`, uitls.CACommonName)
	}
	return nil
}
