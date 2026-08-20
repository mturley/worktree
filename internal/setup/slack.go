// internal/setup/slack.go
package setup

import (
	"fmt"

	wconfig "github.com/mturley/watcher/config"
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

// writeSlackCreds mutates cfg so that token, cookie, and domain land under
// Services.Slack, creating the block if it doesn't already exist. It is a
// pure, unit-tested helper kept around for direct manipulation of a
// wconfig.Config; the interactive acquisition flow itself now goes through
// credsetup.TestAndRepair (see Prompter.PromptSlack), which validates
// credentials, resolves the workspace domain, and saves the result itself.
func writeSlackCreds(cfg *wconfig.Config, token, cookie, domain string) {
	if cfg.Services.Slack == nil {
		cfg.Services.Slack = &wconfig.SlackConfig{}
	}
	cfg.Services.Slack.Token = token
	cfg.Services.Slack.Cookie = cookie
	cfg.Services.Slack.WorkspaceDomain = domain
}

// acquireSlackCreds acquires Slack credentials (token + cookie), either
// automatically via a headed-browser extraction (when interactive and
// node/npx are available) or via manual devtools instructions + prompts. It
// performs no validation of the credentials and saves nothing — that is the
// responsibility of the caller (credsetup.TestAndRepair, via
// Prompter.PromptSlack, which validates and persists on success). Returning
// ("", "", nil) means the user chose to skip Slack configuration. Ported
// from slack-mini's internal/cli/setup.go credential-acquisition step.
func acquireSlackCreds() (token, cookie string, err error) {
	fmt.Println()
	fmt.Println(ui.Bold("Slack integration (optional — press Enter to skip):"))

	if autoExtractAvailable() {
		if ui.ConfirmDefault("  Set up automatically by opening a browser to log into Slack? First run downloads Playwright + Chromium (~150MB, cached).", true) {
			t, c, extractErr := autoExtractor()
			if extractErr != nil {
				fmt.Printf("  Automatic setup didn't complete (%v); falling back to manual.\n", extractErr)
			} else {
				return t, c, nil
			}
		}
	} else {
		fmt.Println("  Automatic setup needs Node.js (node + npx) installed; falling back to manual.")
	}

	fmt.Println()
	fmt.Println(tokenInstructions)
	fmt.Println()

	token = ui.PromptLine("  Slack token (xoxc-...)")
	if token == "" {
		fmt.Printf("  %s Skipped Slack configuration\n", ui.Dim("—"))
		return "", "", nil
	}
	cookie = ui.PromptSecret("  Slack cookie (d value, xoxd-...)")
	if cookie == "" {
		fmt.Printf("  %s Skipped Slack configuration\n", ui.Dim("—"))
		return "", "", nil
	}
	return token, cookie, nil
}
