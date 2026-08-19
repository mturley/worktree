// internal/setup/slack.go
package setup

import (
	"context"
	"errors"
	"fmt"
	"time"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/slackapi"
	"github.com/mturley/worktree/internal/ui"
)

// tokenInstructions describes, step by step, how to extract a Slack browser
// session token (xoxc-...) and its matching cookie (the "d" cookie, xoxd-...)
// from a logged-in Slack web session using browser dev tools. Ported from
// slack-mini's internal/cli/setup.go.
const tokenInstructions = `To use Slack features you need two values from a browser where you are
logged into Slack: an API token (starts with "xoxc-") and a session cookie
(the "d" cookie, which starts with "xoxd-").

  1. Open Slack in your browser at https://app.slack.com and log in.
  2. Open your browser's developer tools:
       - Chrome:  Cmd+Option+I (macOS) / Ctrl+Shift+I or F12 (Windows/Linux),
                  or menu ⋮ → More Tools → Developer Tools.
       - Firefox: Cmd+Option+I (macOS) / Ctrl+Shift+I or F12 (Windows/Linux),
                  or menu ≡ → More Tools → Web Developer Tools.
       - Safari:  first enable the Develop menu via Settings → Advanced →
                  "Show features for web developers", then press
                  Cmd+Option+I (or Develop menu → Show Web Inspector).

  To get the TOKEN (xoxc-...):
  3. Go to the Console tab and run:

       JSON.parse(localStorage.localConfig_v2).teams[
         Object.keys(JSON.parse(localStorage.localConfig_v2).teams)[0]
       ].token

     Copy the returned string (it begins with "xoxc-"). If you belong to
     multiple workspaces, make sure the tab is on the workspace you want.

  To get the COOKIE (xoxd-...):
  4. Open the cookie storage view:
       - Chrome:  Application tab → Storage → Cookies.
       - Firefox: Storage tab → Cookies.
       - Safari:  Storage tab → Cookies.
  5. Under Cookies, select https://app.slack.com.
  6. Find the cookie named "d" and copy its Value (it begins with "xoxd-").

Your workspace domain is detected automatically once you paste these — you
don't need to find it yourself.

These are session credentials tied to your browser login and typically expire
after a week or two. When requests start failing with an auth error, just run
"worktree setup" again to store fresh values.`

// domainDeriver validates the token/cookie AND resolves the workspace's web
// host (for building "Open in Slack" permalinks) via team.info. It is a
// package var so tests can substitute a fake. It returns a wrapped
// slackapi.ErrAuth if the credentials are rejected, or another error on
// transport failure.
var domainDeriver = func(token, cookie string) (domain string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return slackapi.New(token, cookie).TeamInfo(ctx)
}

// writeSlackCreds mutates cfg so that token, cookie, and domain land under
// Services.Slack, creating the block if it doesn't already exist. It is the
// pure, unit-tested core of the Slack credential-acquisition flow; the
// interactive parts (extraction, prompts, validation) live in
// promptAndSaveSlack.
func writeSlackCreds(cfg *wconfig.Config, token, cookie, domain string) {
	if cfg.Services.Slack == nil {
		cfg.Services.Slack = &wconfig.SlackConfig{}
	}
	cfg.Services.Slack.Token = token
	cfg.Services.Slack.Cookie = cookie
	cfg.Services.Slack.WorkspaceDomain = domain
}

// promptAndSaveSlack acquires Slack credentials (token + cookie), either
// automatically via a headed-browser extraction (when interactive and
// node/npx are available) or via manual devtools instructions + prompts,
// then validates them and resolves the workspace domain via team.info, and
// finally writes them into the shared watcher auth.yaml. Ported from
// slack-mini's internal/cli/setup.go credential flow, adapted to write to
// watcher's config instead of slack-mini's own.
func promptAndSaveSlack() error {
	fmt.Println()
	fmt.Println(ui.Bold("Slack integration (optional — press Enter to skip):"))

	var token, cookie string
	gotAutoCreds := false

	if autoExtractAvailable() {
		if ui.ConfirmDefault("  Set up automatically by opening a browser to log into Slack? First run downloads Playwright + Chromium (~150MB, cached).", true) {
			t, c, err := autoExtractor()
			if err != nil {
				fmt.Printf("  Automatic setup didn't complete (%v); falling back to manual.\n", err)
			} else {
				token, cookie = t, c
				gotAutoCreds = true
			}
		}
	} else {
		fmt.Println("  Automatic setup needs Node.js (node + npx) installed; falling back to manual.")
	}

	if !gotAutoCreds {
		fmt.Println()
		fmt.Println(tokenInstructions)
		fmt.Println()

		token = ui.PromptLine("  Slack token (xoxc-...)")
		if token == "" {
			fmt.Printf("  %s Skipped Slack configuration\n", ui.Dim("—"))
			return nil
		}
		cookie = ui.PromptSecret("  Slack cookie (d value, xoxd-...)")
		if cookie == "" {
			fmt.Printf("  %s Skipped Slack configuration\n", ui.Dim("—"))
			return nil
		}
	}

	// Derive the workspace domain automatically from the credentials (via
	// team.info) rather than asking the user: the workspace-specific host is
	// not visible in the Slack web UI (which shows app.slack.com for
	// everyone). This call also validates the token.
	fmt.Print("  Verifying credentials and detecting your workspace... ")
	domain, err := domainDeriver(token, cookie)
	if err != nil {
		fmt.Printf("%s\n", ui.Red("failed"))
		if errors.Is(err, slackapi.ErrAuth) {
			fmt.Printf("    Slack rejected these credentials (check the token and cookie and try again): %v\n", err)
		} else {
			fmt.Printf("    could not verify credentials with Slack: %v\n", err)
		}
		return nil
	}
	fmt.Printf("%s (%s)\n", ui.Green("ok"), domain)

	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return fmt.Errorf("loading watcher config: %w", err)
	}
	writeSlackCreds(cfg, token, cookie, domain)
	if err := cfg.Save(wconfig.DefaultPath()); err != nil {
		return fmt.Errorf("saving watcher config: %w", err)
	}

	fmt.Printf("  %s Configured Slack: %s\n", ui.Green("✓"), domain)
	fmt.Printf("  %s Updated %s\n", ui.Green("✓"), ui.ShortPath(wconfig.DefaultPath()))
	return nil
}
