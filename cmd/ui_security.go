package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/uisession"
	"github.com/mturley/worktree/internal/uitls"
	"github.com/mturley/worktree/internal/webui"
	"github.com/spf13/cobra"
)

// buildSecurity turns the ui config into the server's security settings and
// refuses any configuration the web UI does not allow. With localOnly, no
// HTTPS listener is configured even when a certificate is.
func buildSecurity(ui config.UIConfig, sessions *uisession.Store, localOnly bool) (*webui.Security, error) {
	if ui.Password == "" {
		return nil, fmt.Errorf(`the web UI requires a password, and none is configured.

  Run "worktree setup" to generate one, or set ui.password yourself in
  %s

  The password is required on every listener, including 127.0.0.1`, config.ConfigPath())
	}
	sec := &webui.Security{
		Password:     ui.Password,
		Sessions:     sessions,
		AllowedHosts: ui.AllowedHosts,
		HTTPSPort:    ui.HTTPSPort,
	}
	cert, key := ui.TLS.CertFile, ui.TLS.KeyFile
	if (cert == "") != (key == "") {
		return nil, errors.New(`ui.tls needs both cert_file and key_file, and only one is set. Run "worktree setup" to reissue them`)
	}
	if cert == "" || localOnly {
		return sec, nil
	}
	for _, f := range []string{cert, key} {
		if _, err := os.Stat(f); err != nil {
			return nil, fmt.Errorf(`ui.tls file %s: %w. Run "worktree setup" to reissue it`, f, err)
		}
	}
	sec.CertFile, sec.KeyFile = cert, key
	return sec, nil
}

// checkRemovedFlags fails on --bind and --yes. Both are kept registered, and
// hidden, only so that an old launch command gets this pointer rather than
// "unknown flag".
func checkRemovedFlags(cmd *cobra.Command) error {
	if cmd.Flags().Changed("bind") || cmd.Flags().Changed("yes") {
		return errors.New(`--bind and --yes have been removed. The web UI now serves plain HTTP on 127.0.0.1 only; other devices connect over HTTPS once remote access is configured. Run "worktree setup" to configure it, and drop these flags from the launch command`)
	}
	return nil
}

// warnConfigPermissions warns when the config file, which holds the web UI
// password, is readable by anyone but its owner.
func warnConfigPermissions(path string, w io.Writer) {
	open, err := config.PermissionsTooOpen(path)
	if err != nil || !open {
		return
	}
	fmt.Fprintf(w, "warning: %s holds the web UI password and is readable by other users. Run: chmod 600 %s\n", path, path)
}

// certCoverageWarning returns a warning when the certificate covers none of
// this machine's currently detected addresses, or "" when it covers any of
// them (or nothing was detected).
func certCoverageWarning(certFile string, candidates []string) (string, error) {
	if len(candidates) == 0 {
		return "", nil
	}
	cert, err := uitls.ReadCert(certFile)
	if err != nil {
		return "", err
	}
	uncovered := uitls.Uncovered(cert, candidates)
	if len(uncovered) < len(candidates) {
		return "", nil
	}
	return fmt.Sprintf(`the HTTPS certificate does not cover this machine's current address (%s), so other devices will get a certificate error. Run "worktree setup" and change the remote access addresses`,
		strings.Join(uncovered, ", ")), nil
}
