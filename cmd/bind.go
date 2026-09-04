package cmd

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
)

// bindIsLoopback reports whether host reaches only this machine.
//
// Anything it cannot prove is loopback — including the empty string, which
// means "all interfaces" to net.Listen, and any hostname other than
// "localhost" — is treated as remotely reachable, so the warning errs toward
// being shown rather than skipped.
func bindIsLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// errBindDeclined is returned when the user answers no to the bind warning.
var errBindDeclined = errors.New("aborted: not binding to a non-loopback address")

// confirmBind warns about, and gates, a bind address that exposes the UI
// beyond this machine. Loopback binds pass silently.
//
// The warning is printed whenever the bind is non-loopback, even under
// assumeYes — skipping the prompt should not mean losing the notice in the
// scrollback. When stdin is not a terminal there is nobody to answer, so the
// bind is refused rather than silently allowed.
func confirmBind(host string, assumeYes, interactive bool, in io.Reader, out io.Writer) error {
	if bindIsLoopback(host) {
		return nil
	}

	fmt.Fprintf(out, `
  WARNING: --bind %s exposes the worktree UI beyond this machine.

  The UI has NO authentication and is not read-only. Anyone who can reach
  port %d can create and delete worktrees, run cmux commands, and read your
  Slack threads through the server's proxy — it holds your Slack session
  credentials and will use them for any caller.

  Only do this on a network you trust. For access from outside the LAN,
  prefer a VPN such as Tailscale over opening this port.

`, host, uiPort)

	if assumeYes {
		return nil
	}
	if !interactive {
		return fmt.Errorf("refusing to bind to %s without confirmation: stdin is not a terminal, pass --yes to proceed", host)
	}

	fmt.Fprint(out, "  Continue? [y/N] ")
	line, err := bufio.NewReader(in).ReadString('\n')
	if err != nil && line == "" {
		return errBindDeclined
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		fmt.Fprintln(out)
		return nil
	}
	return errBindDeclined
}
