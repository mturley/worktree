package setup

import (
	"fmt"
	"path"
	"strings"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/ui"
)

// GettingStarted is the tips `worktree setup` prints at the end of an
// interactive run: start the web UI (and reach it from a phone), create a
// worktree, look worktrees up. configPath is shown as given, so callers pass
// it through ui.ShortPath; the CA certificate is named beside it, where setup
// writes it.
func GettingStarted(configPath string, uiCfg config.UIConfig) string {
	cmd := func(s string) string { return ui.Cyan(s) }
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n\n", ui.Bold("Getting started"))
	fmt.Fprintf(&b, "  1. Start the web UI in a terminal:\n")
	fmt.Fprintf(&b, "       %s\n", cmd("worktree ui"))
	fmt.Fprintf(&b, "     It opens your browser at http://127.0.0.1:%d (open it yourself if\n", config.DefaultHTTPPort)
	fmt.Fprintf(&b, "     not). Log in with your web UI password: it's ui.password in\n")
	fmt.Fprintf(&b, "     %s. Start it in a cmux terminal to enable\n", configPath)
	fmt.Fprintf(&b, "     cmux features.\n")
	if url := uiCfg.RemoteURL(); uiCfg.RemoteEnabled() && !uiCfg.RemoteAccessDisabled && url != "" {
		fmt.Fprintf(&b, "     On your phone or another device on the same network, open\n")
		fmt.Fprintf(&b, "       %s\n", cmd(url))
		fmt.Fprintf(&b, "     after installing %s on it once.\n\n", path.Join(path.Dir(configPath), "ui-ca.pem"))
	} else {
		fmt.Fprintf(&b, "     To open it on your phone or another device on the same network\n")
		fmt.Fprintf(&b, "     (over HTTPS, on port %d), run %s again and turn on\n", config.DefaultHTTPSPort, cmd("worktree setup"))
		fmt.Fprintf(&b, "     remote access.\n\n")
	}
	fmt.Fprintf(&b, "  2. Create a worktree:\n")
	fmt.Fprintf(&b, "       %s                      a branch, new or existing\n", cmd("worktree add my-feature"))
	fmt.Fprintf(&b, "       %s                            a PR, by number or URL\n", cmd("worktree add 1234"))
	fmt.Fprintf(&b, "       %s      a Jira issue\n", cmd("worktree add https://…/browse/PROJ-5678"))
	fmt.Fprintf(&b, "     Each one gets its own directory under ~/.worktrees/<repo>/, its own\n")
	fmt.Fprintf(&b, "     port range and kubeconfig, and shows up in the web UI.\n\n")
	fmt.Fprintf(&b, "  3. See what you have:\n")
	fmt.Fprintf(&b, "       %s           every worktree\n", cmd("worktree list"))
	fmt.Fprintf(&b, "       %s    a worktree's branch, ports, PR and Jira issue\n", cmd("worktree info [path]"))
	fmt.Fprintf(&b, "                               (the current one when you leave out the path)\n\n")
	fmt.Fprintf(&b, "  %s is short for %s, so %s works too.\n", cmd("wt"), cmd("worktree"), cmd("wt add my-feature"))
	return b.String()
}
