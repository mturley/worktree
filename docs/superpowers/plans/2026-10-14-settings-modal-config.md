# Settings Modal Config Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web UI Settings modal can view and edit every user-facing key in worktree's
`config.yaml`, watcher's `auth.yaml` and watcher's `config.yaml`. Secrets are write-only
and testable. A new `worktree setup slack` subcommand reruns the Slack capture.

**Architecture:** A single `GET /api/settings` returns every file's editable values
plus booleans for which secrets are set. There is one `PUT` per file, and separate
endpoints that validate-then-write each credential or test it. worktree's
`config.yaml` is edited through a YAML node tree so comments survive. The watcher
files go through the watcher library's `Load`/`Save` (plus a new `SaveConfig`). The
frontend modal keeps a draft of each file with a modal-wide Save/Discard footer.
Secrets use a `SecretField` that is replaced immediately rather than staged in the
footer.

**Tech Stack:** Go 1.26 (net/http ServeMux patterns, yaml.v3), watcher library
(`~/git/watcher`, cross-repo release), React + Mantine 7 + TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-settings-modal-config-design.md`

## Global Constraints

- No secret value (tokens, cookie, `ui.password`) ever appears in any HTTP response body.
- A credential Replace writes nothing unless validation succeeds. Auth rejections and network failures are both refused.
- auth.yaml `consumers` and `jira_custom_fields` are never shown or edited in the UI.
- No mention of agent-handler anywhere in the UI.
- Each config tab's first line: "These settings are persisted to `<home-relative path>`".
- Slack section help text, verbatim: "To automatically capture the Slack token and cookie from a browser session, run `worktree setup slack`."
- Restart badge text, verbatim: "Applies after restarting worktree ui". It goes on the Remote access section, and covers only `ui.https_port`, `ui.allowed_hosts` and `ui.tls.*`.
- worktree `config.yaml` writes keep comments and unknown keys, use the 4-space indent, and keep mode 0600. A save with no changes does not rewrite the file.
- All commits use `git commit --signoff` and end with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never push without asking Mike first. That includes the watcher tag in Task 1, which is a hard stop.
- Never `git add -A` / `git add .`. Add files by name.
- The worktree checkout is `/Users/mturley/git/worktree/.claude/worktrees/settings-modal-config`. The watcher library is `/Users/mturley/git/watcher`. Use `git -C <path>` for the watcher repo, because the session sandbox refuses `cd` + git into another repo.

## Review Focus

1. **Hand-edited config with comments and unknown keys.** A user saves one field. The
   file keeps every comment, key order and unrelated key. *Pinned in Task 3
   (`TestWriteEditablePreservesCommentsAndUnknownKeys`).*
2. **`~` paths and `$WORKTREES_BASE`.** Saving an unrelated field must not rewrite
   `worktrees_base: ~/.worktrees` to an absolute path, or to the env var's value.
   *Pinned in Task 3 (`TestReadEditableKeepsTildeAndIgnoresEnv`).*
3. **Missing files.** No watcher `config.yaml` and no `auth.yaml` on a fresh machine. GET
   returns empty sections, not an error, and a PUT creates the file (auth.yaml
   with 0600). *Pinned in Task 5 (`TestWatcherSettingsMissingFiles`).*
4. **Slack replace of one half.** Pasting only a new cookie is validated together with
   the stored token, and the stored token is kept. *Pinned in Task 6
   (`TestReplaceSlackCookieOnlyUsesStoredToken`).*
5. **Modal closed with unsaved edits, or reopened after Discard.** The user is asked
   before losing changes. After Discard, the drafts equal the server values again.
   *Pinned in Task 9 (`asks before closing with unsaved changes`).*

---

## File Structure

**watcher library (`/Users/mturley/git/watcher`)**
- Modify `config/config.go`: add `SaveConfig`.
- Modify `config/config_test.go` (create if absent): `SaveConfig` round-trip.
- Modify `credsetup/credsetup.go`: add `Replace`, and factor out the prompt → validate → apply tails.
- Modify `credsetup/credsetup_test.go`: `Replace` tests.

**worktree Go**
- Create `internal/config/yamledit.go`: node-tree helpers (read/write doc, set/delete path, node builders).
- Create `internal/config/editable.go`: `Editable` (non-secret, unexpanded values), `ReadEditable`, `WriteEditable`, `SetPassword`.
- Modify `internal/config/settings.go`: reimplement `SetCmuxFeaturesDisabled` on `yamledit`, and delete `editUIKey`/`mappingValue`/`removeMappingKey`.
- Create `internal/config/editable_test.go`.
- Create `internal/setup/slack_setup.go`: `RunSlackSetup`. Modify `internal/setup/slack.go`: text change only.
- Create `internal/setup/slack_setup_test.go`.
- Modify `cmd/setup.go`: add the `setup slack` subcommand.
- Rewrite `internal/webui/settings.go`: DTO, GET, `PUT /api/settings/worktree`, cmux gate helpers.
- Create `internal/webui/settings_watcher.go`: watcher-auth/watcher-config GET sections and PUTs.
- Create `internal/webui/settings_creds.go`: credential test/replace, password replace, validator seam.
- Modify `internal/webui/security.go`: runtime-swappable password.
- Modify `internal/webui/auth.go`: read the password via the accessor.
- Modify `internal/webui/server.go`: new fields and routes.
- Rewrite `internal/webui/settings_test.go`. Create `settings_watcher_test.go`, `settings_creds_test.go` and `settings_keys_test.go`.

**worktree frontend (`ui/src`)**
- Modify `api/types.ts`: settings types.
- Modify `api/client.ts`: settings API functions.
- Create `components/settings/useSettingsDraft.ts` (+ `.test.ts`).
- Create `components/settings/SecretField.tsx` (+ `.test.tsx`).
- Create `components/settings/parts.tsx`: `PersistedTo`, `SettingsSection`, `KeyPath`, `homeRelative`.
- Create `components/settings/KeyValueTable.tsx`.
- Create `components/settings/GeneralPanel.tsx`, `WatcherAuthPanel.tsx` and `WatcherConfigPanel.tsx`.
- Rewrite `components/SettingsModal.tsx` (+ `.test.tsx`).

**Docs**
- Modify `CLAUDE.md`, `docs/web-ui-architecture.md` ("Settings toggle" → "Settings modal") and `docs/features.md` if it lists settings (check with `grep -n -i settings docs/*.md`).

---

### Task 1: Watcher library — `SaveConfig` and `credsetup.Replace` (release v0.14.0)

**Files:**
- Modify: `/Users/mturley/git/watcher/config/config.go`
- Test: `/Users/mturley/git/watcher/config/config_test.go` (append; create with `package config` if missing)
- Modify: `/Users/mturley/git/watcher/credsetup/credsetup.go`
- Test: `/Users/mturley/git/watcher/credsetup/credsetup_test.go` (append)

**Interfaces:**
- Produces: `config.SaveConfig(path string, c *config.ConfigFile) error` and
  `credsetup.Replace(cfg *config.Config, svc credsetup.Service, p credsetup.Prompter) (bool, error)`.
  `Replace` returns `changed=true` only when new credentials validated and were applied
  to `cfg`. It never saves.

- [ ] **Step 1: Write the failing tests**

Append to `config/config_test.go`:

```go
func TestSaveConfigRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "config.yaml")
	in := &ConfigFile{Jira: &JiraBehavior{
		BotUsernames: []string{"bot-a"},
		CustomFields: map[string]string{"epic_key": "customfield_10014"},
	}}
	if err := SaveConfig(path, in); err != nil {
		t.Fatal(err)
	}
	got, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, in) {
		t.Fatalf("got %+v, want %+v", got, in)
	}
}
```

(Add `path/filepath` and `reflect` to the imports as needed.)

Append to `credsetup/credsetup_test.go`:

```go
func TestReplace_GitHub_SkipsTestOfStoredToken(t *testing.T) {
	var validated []string
	withGitHubSeam(t, func(token string, apiURL ...string) error {
		validated = append(validated, token)
		return nil
	})
	cfg := &config.Config{Services: config.Services{GitHub: &config.GitHubConfig{Token: "old"}}}
	p := &fakePrompter{tokenResults: []string{"new"}}
	changed, err := Replace(cfg, GitHub, p)
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	if cfg.Services.GitHub.Token != "new" {
		t.Fatalf("token = %q", cfg.Services.GitHub.Token)
	}
	if len(validated) != 1 || validated[0] != "new" {
		t.Fatalf("validated %v, want only the new token", validated)
	}
	if len(p.confirmCalls) != 0 {
		t.Fatalf("Replace must not ask for confirmation, got %v", p.confirmCalls)
	}
}

func TestReplace_Slack_InvalidLeavesConfig(t *testing.T) {
	withSlackSeam(t,
		func(token, cookie string) error { return wslack.ErrAuth },
		func(token, cookie string) string { return "x" },
	)
	orig := &config.SlackConfig{Token: "t", Cookie: "c", WorkspaceDomain: "d"}
	cfg := &config.Config{Services: config.Services{Slack: orig}}
	p := &fakePrompter{slackTokenResult: "t2", slackCookieResult: "c2"}
	changed, err := Replace(cfg, Slack, p)
	if err != nil || changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	if *cfg.Services.Slack != (config.SlackConfig{Token: "t", Cookie: "c", WorkspaceDomain: "d"}) {
		t.Fatalf("config changed: %+v", cfg.Services.Slack)
	}
}

func TestReplace_Jira_ReusesHostEmail(t *testing.T) {
	withJiraSeam(t, func(host, email, token string) error { return nil })
	cfg := &config.Config{Services: config.Services{Jira: &config.JiraConfig{Host: "h", Email: "e", Token: "old"}}}
	p := &fakePrompter{tokenResults: []string{"new"}}
	changed, err := Replace(cfg, Jira, p)
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	if *cfg.Services.Jira != (config.JiraConfig{Host: "h", Email: "e", Token: "new"}) {
		t.Fatalf("got %+v", cfg.Services.Jira)
	}
	if p.jiraCalls != 0 {
		t.Fatal("configured host/email must not be re-prompted")
	}
}
```

(Import `wslack "github.com/mturley/watcher/slack"` in the test file if not already imported.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `go -C /Users/mturley/git/watcher test ./config/ ./credsetup/`
Expected: FAIL. The build reports undefined `SaveConfig` and `Replace`.

- [ ] **Step 3: Implement**

In `config/config.go`, after `LoadConfig`:

```go
// SaveConfig writes c to path as YAML, creating the parent directory (0700)
// if needed. config.yaml holds no credentials, so the file is 0644.
func SaveConfig(path string, c *ConfigFile) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("failed to create config dir %s: %w", dir, err)
	}
	data, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("failed to write config %s: %w", path, err)
	}
	return nil
}
```

In `credsetup/credsetup.go`:
- Factor each `repairX` function's tail, from the `p.PromptToken` / `p.PromptSlack` call to `return true, nil`, into `promptGitHub(cfg, p)`, `promptJira(cfg, p, host, email)` and `promptSlack(cfg, p)`.
- Have `repairX` call them.
- Add `Replace`:

```go
// Replace prompts for new credentials for svc, validates them and applies
// them to cfg, without first testing what is stored — for an operator who
// wants fresh credentials even though the current ones work. Like
// TestAndRepair it never saves; changed reports whether cfg was modified.
// For Jira, a configured host/email is reused; otherwise they are prompted
// for as in greenfield setup.
func Replace(cfg *config.Config, svc Service, p Prompter) (bool, error) {
	switch svc {
	case GitHub:
		return promptGitHub(cfg, p)
	case Jira:
		host, email := "", ""
		if j := cfg.Services.Jira; j != nil {
			host, email = j.Host, j.Email
		}
		if host == "" || email == "" {
			host, email = p.PromptJira("Enter your Jira site URL (e.g. https://yourorg.atlassian.net) and the account email")
			host = strings.TrimRight(host, "/")
			if host == "" || email == "" {
				p.Info("Jira: skipped")
				return false, nil
			}
		}
		return promptJira(cfg, p, host, email)
	case Slack:
		return promptSlack(cfg, p)
	default:
		return false, fmt.Errorf("unknown service %q", svc)
	}
}
```

The factored tails, which are the existing code moved unchanged:

```go
func promptGitHub(cfg *config.Config, p Prompter) (bool, error) {
	tok := p.PromptToken(GitHub, "Create a token at https://github.com/settings/tokens (needs repo/read scopes)")
	if tok == "" {
		return false, nil
	}
	if err := validateGitHub(tok); err != nil {
		p.Info("GitHub: new token invalid (" + err.Error() + ")")
		return false, nil // one attempt, then give up
	}
	if cfg.Services.GitHub == nil {
		cfg.Services.GitHub = &config.GitHubConfig{}
	}
	cfg.Services.GitHub.Token = tok
	p.Info("GitHub: ok")
	return true, nil
}

func promptJira(cfg *config.Config, p Prompter, host, email string) (bool, error) {
	tok := p.PromptToken(Jira, "Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens")
	if tok == "" {
		return false, nil
	}
	if err := validateJira(host, email, tok); err != nil {
		p.Info("Jira: new token invalid (" + err.Error() + ")")
		return false, nil // one attempt, then give up
	}
	if cfg.Services.Jira == nil {
		cfg.Services.Jira = &config.JiraConfig{}
	}
	cfg.Services.Jira.Host = host
	cfg.Services.Jira.Email = email
	cfg.Services.Jira.Token = tok
	p.Info("Jira: ok")
	return true, nil
}

func promptSlack(cfg *config.Config, p Prompter) (bool, error) {
	tok, cookie := p.PromptSlack("Extract your Slack session token (xoxc-...) and d= cookie (xoxd-...) from a logged-in browser session")
	if tok == "" || cookie == "" {
		return false, nil
	}
	if err := validateSlack(tok, cookie); err != nil {
		p.Info("Slack: new credentials invalid (" + err.Error() + ")")
		return false, nil // one attempt, then give up
	}
	cfg.Services.Slack = &config.SlackConfig{
		Token:           tok,
		Cookie:          cookie,
		WorkspaceDomain: slackDomain(tok, cookie),
	}
	p.Info("Slack: ok")
	return true, nil
}
```

- [ ] **Step 4: Run all library tests**

Run: `go -C /Users/mturley/git/watcher test ./...`
Expected: PASS. The existing TestAndRepair tests still pass, since the refactor changes no behavior.

- [ ] **Step 5: Commit and tag locally**

```bash
git -C /Users/mturley/git/watcher add config/config.go config/config_test.go credsetup/credsetup.go credsetup/credsetup_test.go
git -C /Users/mturley/git/watcher commit --signoff -m "feat: add config.SaveConfig and credsetup.Replace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git -C /Users/mturley/git/watcher tag v0.14.0
```

- [ ] **Step 6: STOP — ask Mike to approve pushing**

Pushes are never covered by plan approval. Ask:
"May I push watcher `main` and tag `v0.14.0` to origin?"

On a yes:

```bash
git -C /Users/mturley/git/watcher push origin main
git -C /Users/mturley/git/watcher push origin v0.14.0
```

---

### Task 2: Re-pin watcher, and `worktree setup slack`

**Files:**
- Modify: `go.mod`, `go.sum`
- Create: `internal/setup/slack_setup.go`
- Test: `internal/setup/slack_setup_test.go`
- Modify: `internal/setup/slack.go` (instructions text)
- Modify: `cmd/setup.go`

**Interfaces:**
- Consumes: `credsetup.Replace`, `credsetup.TestAndRepair` (Task 1).
- Produces: `setup.RunSlackSetup(force bool) error`.

- [ ] **Step 1: Re-pin**

```bash
go get github.com/mturley/watcher@v0.14.0 && go mod tidy && go build ./...
```

Expected: builds cleanly.

- [ ] **Step 2: Write the failing test**

`internal/setup/slack_setup_test.go`:

```go
package setup

import (
	"testing"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/watcher/credsetup"
)

type slackFlowCalls struct{ tested, replaced, asked bool }

// stubSlackFlow swaps the three decision points of runSlackSetup.
func stubSlackFlow(t *testing.T, testChanged bool, testErr error, confirm bool, calls *slackFlowCalls) {
	t.Helper()
	origTest, origReplace, origConfirm := slackTestAndRepair, slackReplace, slackConfirmRecapture
	t.Cleanup(func() { slackTestAndRepair, slackReplace, slackConfirmRecapture = origTest, origReplace, origConfirm })
	slackTestAndRepair = func(*wconfig.Config, credsetup.Service, credsetup.Prompter) (bool, error) {
		calls.tested = true
		return testChanged, testErr
	}
	slackReplace = func(*wconfig.Config, credsetup.Service, credsetup.Prompter) (bool, error) {
		calls.replaced = true
		return true, nil
	}
	slackConfirmRecapture = func() bool { calls.asked = true; return confirm }
}

func TestSlackSetupForceSkipsTest(t *testing.T) {
	var c slackFlowCalls
	stubSlackFlow(t, false, nil, false, &c)
	changed, err := runSlackSetup(&wconfig.Config{}, true)
	if err != nil || !changed || c.tested || c.asked || !c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}

func TestSlackSetupRepairedByTestDoesNotAsk(t *testing.T) {
	var c slackFlowCalls
	stubSlackFlow(t, true, nil, false, &c)
	changed, err := runSlackSetup(&wconfig.Config{}, false)
	if err != nil || !changed || c.asked || c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}

func TestSlackSetupValidAsksAndHonoursNo(t *testing.T) {
	var c slackFlowCalls
	stubSlackFlow(t, false, nil, false, &c)
	cfg := &wconfig.Config{Services: wconfig.Services{Slack: &wconfig.SlackConfig{Token: "t", Cookie: "c"}}}
	changed, err := runSlackSetup(cfg, false)
	if err != nil || changed || !c.asked || c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}

func TestSlackSetupValidAsksAndRecaptures(t *testing.T) {
	var c slackFlowCalls
	stubSlackFlow(t, false, nil, true, &c)
	cfg := &wconfig.Config{Services: wconfig.Services{Slack: &wconfig.SlackConfig{Token: "t", Cookie: "c"}}}
	changed, err := runSlackSetup(cfg, false)
	if err != nil || !changed || !c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}

func TestSlackSetupUnconfiguredDeclinedDoesNotAsk(t *testing.T) {
	// TestAndRepair already asked "Configure Slack?" and the user said no;
	// asking "capture anyway?" on top would be a second prompt for one answer.
	var c slackFlowCalls
	stubSlackFlow(t, false, nil, true, &c)
	changed, err := runSlackSetup(&wconfig.Config{}, false)
	if err != nil || changed || c.asked || c.replaced {
		t.Fatalf("changed=%v err=%v calls=%+v", changed, err, c)
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `go test ./internal/setup/ -run TestSlackSetup`
Expected: FAIL. The build reports undefined `runSlackSetup`.

- [ ] **Step 4: Implement**

`internal/setup/slack_setup.go`:

```go
package setup

import (
	"fmt"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/watcher/credsetup"
	"github.com/mturley/worktree/internal/ui"
)

// Seams for tests.
var (
	slackTestAndRepair    = credsetup.TestAndRepair
	slackReplace          = credsetup.Replace
	slackConfirmRecapture = func() bool {
		return ui.ConfirmDefault("  Slack credentials are valid. Capture new credentials anyway?", false)
	}
)

// RunSlackSetup is `worktree setup slack`: only setup's Slack step, plus a
// way to recapture credentials that still work. It loads and, if anything
// changed, saves the watcher auth.yaml.
func RunSlackSetup(force bool) error {
	path := wconfig.DefaultPath()
	cfg, err := wconfig.Load(path)
	if err != nil {
		return fmt.Errorf("loading watcher config: %w", err)
	}
	changed, err := runSlackSetup(cfg, force)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	if err := cfg.Save(path); err != nil {
		return fmt.Errorf("saving watcher config: %w", err)
	}
	fmt.Printf("  %s Updated %s\n", ui.Green("✓"), ui.ShortPath(path))
	return nil
}

// runSlackSetup decides between testing, repairing and recapturing:
//   - force: capture straight away.
//   - otherwise TestAndRepair: missing creds offer setup, rejected creds
//     offer replacement. Either way that is the whole run.
//   - creds that were configured and are still valid: ask whether to
//     capture new ones anyway.
func runSlackSetup(cfg *wconfig.Config, force bool) (bool, error) {
	var p Prompter
	if force {
		return slackReplace(cfg, credsetup.Slack, p)
	}
	_, cfgErr := cfg.Slack()
	wasConfigured := cfgErr == nil
	changed, err := slackTestAndRepair(cfg, credsetup.Slack, p)
	if err != nil || changed || !wasConfigured {
		return changed, err
	}
	// Configured and unchanged: TestAndRepair found them valid, or found
	// them rejected and the user declined to replace them. Both answers
	// mean "keep what is there" except in the valid case, where the user
	// ran this command precisely to get fresh ones.
	if !slackConfirmRecapture() {
		return false, nil
	}
	return slackReplace(cfg, credsetup.Slack, p)
}
```

Note on the rejected-and-declined case: it also reaches the recapture question. That
is acceptable, since the user can say no again. Do not add state tracking to tell the
two cases apart.

In `internal/setup/slack.go`, change the last line of `tokenInstructions`:

```
"worktree setup" again to store fresh values.`
```

to:

```
"worktree setup slack" to store fresh values.`
```

In `cmd/setup.go`, add:

```go
var setupSlackForce bool

var setupSlackCmd = &cobra.Command{
	Use:   "slack",
	Short: "Capture Slack credentials from a browser session",
	Long: "Tests the stored Slack credentials, and captures new ones from a browser\n" +
		"session (Playwright) when they are missing, rejected, or you ask for fresh ones.",
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return setup.RunSlackSetup(setupSlackForce)
	},
}
```

In `init()`, after `rootCmd.AddCommand(setupCmd)`:

```go
	setupSlackCmd.Flags().BoolVar(&setupSlackForce, "force", false,
		"Skip testing the stored credentials and always capture new ones")
	setupCmd.AddCommand(setupSlackCmd)
```

- [ ] **Step 5: Run the tests and verify the command wiring**

Run: `go test ./internal/setup/ ./cmd/ && go run . setup slack --help`
Expected: PASS. The help shows `--force`.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/setup/slack_setup.go internal/setup/slack_setup_test.go internal/setup/slack.go cmd/setup.go
git commit --signoff -m "feat(setup): add 'worktree setup slack' and pin watcher v0.14.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: YAML node editor and `config.Editable`

**Files:**
- Create: `internal/config/yamledit.go`
- Create: `internal/config/editable.go`
- Modify: `internal/config/settings.go`
- Test: `internal/config/editable_test.go`; the existing `internal/config/settings_test.go` must keep passing

**Interfaces:**
- Produces:

```go
type Editable struct {
	WorktreesBase        string
	Editor               string
	JiraProjects         []string
	JiraAliasHosts       []string
	HTTPSPort            int // 0 in the file → DefaultHTTPSPort
	AllowedHosts         []string
	TLSCertFile          string
	TLSKeyFile           string
	CmuxFeaturesDisabled bool
}
func ReadEditable(path string) (Editable, bool /*passwordSet*/, error)
func WriteEditable(path string, next Editable) (changed bool, err error)
func SetPassword(path, password string) error
```

- [ ] **Step 1: Write the failing tests**

`internal/config/editable_test.go`:

```go
package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const sample = `# my worktree config
worktrees_base: ~/.worktrees # where they go
custom_key: keep-me
jira:
    projects:
        - ABC
ui:
    password: secret
    allowed_hosts:
        - host.local
    tls:
        cert_file: ~/c.pem
        key_file: ~/k.pem
`

func writeSample(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(sample), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadEditableKeepsTildeAndIgnoresEnv(t *testing.T) {
	t.Setenv("WORKTREES_BASE", "/elsewhere")
	p := writeSample(t)
	got, pwSet, err := ReadEditable(p)
	if err != nil {
		t.Fatal(err)
	}
	want := Editable{
		WorktreesBase: "~/.worktrees",
		JiraProjects:  []string{"ABC"},
		HTTPSPort:     DefaultHTTPSPort,
		AllowedHosts:  []string{"host.local"},
		TLSCertFile:   "~/c.pem",
		TLSKeyFile:    "~/k.pem",
	}
	if !reflect.DeepEqual(got, want) || !pwSet {
		t.Fatalf("got %+v pwSet=%v", got, pwSet)
	}
}

func TestReadEditableMissingFile(t *testing.T) {
	got, pwSet, err := ReadEditable(filepath.Join(t.TempDir(), "nope.yaml"))
	if err != nil || pwSet || got.HTTPSPort != DefaultHTTPSPort {
		t.Fatalf("got %+v pwSet=%v err=%v", got, pwSet, err)
	}
}

func TestWriteEditablePreservesCommentsAndUnknownKeys(t *testing.T) {
	p := writeSample(t)
	cur, _, _ := ReadEditable(p)
	cur.Editor = "zed"
	cur.JiraProjects = []string{"ABC", "DEF"}
	changed, err := WriteEditable(p, cur)
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	data, _ := os.ReadFile(p)
	s := string(data)
	for _, want := range []string{"# my worktree config", "# where they go", "custom_key: keep-me", "password: secret", "editor: zed", "- DEF", "worktrees_base: ~/.worktrees"} {
		if !strings.Contains(s, want) {
			t.Errorf("file lost %q:\n%s", want, s)
		}
	}
	if info, _ := os.Stat(p); info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o", info.Mode().Perm())
	}
}

func TestWriteEditableNoChangeDoesNotRewrite(t *testing.T) {
	p := writeSample(t)
	cur, _, _ := ReadEditable(p)
	changed, err := WriteEditable(p, cur)
	if err != nil || changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	data, _ := os.ReadFile(p)
	if string(data) != sample {
		t.Fatalf("file rewritten:\n%s", data)
	}
}

func TestWriteEditableDefaultsDeleteKeys(t *testing.T) {
	p := writeSample(t)
	cur, _, _ := ReadEditable(p)
	cur.JiraProjects = nil
	cur.AllowedHosts = nil
	cur.HTTPSPort = DefaultHTTPSPort
	cur.CmuxFeaturesDisabled = true
	if _, err := WriteEditable(p, cur); err != nil {
		t.Fatal(err)
	}
	cur.CmuxFeaturesDisabled = false
	if _, err := WriteEditable(p, cur); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	s := string(data)
	for _, gone := range []string{"projects", "allowed_hosts", "https_port", "cmux_features_disabled"} {
		if strings.Contains(s, gone) {
			t.Errorf("%s should be removed:\n%s", gone, s)
		}
	}
	if strings.Contains(s, "jira:") {
		t.Errorf("an emptied jira mapping should be removed:\n%s", s)
	}
}

func TestWriteEditableCreatesFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "d", "config.yaml")
	if _, err := WriteEditable(p, Editable{Editor: "vim", HTTPSPort: 9000}); err != nil {
		t.Fatal(err)
	}
	got, _, _ := ReadEditable(p)
	if got.Editor != "vim" || got.HTTPSPort != 9000 {
		t.Fatalf("got %+v", got)
	}
}

func TestSetPassword(t *testing.T) {
	p := writeSample(t)
	if err := SetPassword(p, "new-pw"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(p)
	if !strings.Contains(string(data), "password: new-pw") || !strings.Contains(string(data), "# my worktree config") {
		t.Fatalf("got:\n%s", data)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./internal/config/`
Expected: FAIL. The build reports undefined `ReadEditable`, `WriteEditable` and `SetPassword`.

- [ ] **Step 3: Implement `yamledit.go`**

```go
package config

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"gopkg.in/yaml.v3"
)

// Node-tree editing for worktree's config.yaml. Edits go through the parsed
// yaml.Node tree rather than a round-tripped Config, so comments, key order
// and keys this version doesn't know about all survive a save from the UI.

// readDoc parses path into a document node. A missing or empty file yields
// an empty mapping document.
func readDoc(path string) (*yaml.Node, error) {
	var doc yaml.Node
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := yaml.Unmarshal(data, &doc); err != nil {
			return nil, fmt.Errorf("parsing config: %w", err)
		}
	case os.IsNotExist(err):
	default:
		return nil, err
	}
	if doc.Kind == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	if doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("config: top level is not a mapping")
	}
	return &doc, nil
}

// writeDoc encodes doc with yaml.v3's default 4-space indent (what setup's
// writeConfig produces) and writes it owner-only: the file holds the UI
// password.
func writeDoc(path string, doc *yaml.Node) error {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	if err := enc.Encode(doc); err != nil {
		return err
	}
	if err := enc.Close(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// lookup returns the value node at keys, or nil.
func lookup(root *yaml.Node, keys ...string) *yaml.Node {
	n := root
	for _, k := range keys {
		if n == nil || n.Kind != yaml.MappingNode {
			return nil
		}
		n = mappingValue(n, k)
	}
	return n
}

// setPath sets the value at keys, creating intermediate mappings. A scalar
// replacing a scalar is updated in place so its comments stay attached.
func setPath(root *yaml.Node, val *yaml.Node, keys ...string) error {
	m := root
	for _, k := range keys[:len(keys)-1] {
		next := mappingValue(m, k)
		if next == nil {
			next = &yaml.Node{Kind: yaml.MappingNode}
			m.Content = append(m.Content, scalar(k), next)
		}
		if next.Kind != yaml.MappingNode {
			return fmt.Errorf("config: %s is not a mapping", k)
		}
		m = next
	}
	last := keys[len(keys)-1]
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value != last {
			continue
		}
		old := m.Content[i+1]
		if old.Kind == yaml.ScalarNode && val.Kind == yaml.ScalarNode {
			old.Value, old.Tag, old.Style = val.Value, val.Tag, val.Style
			return nil
		}
		val.LineComment = old.LineComment
		m.Content[i+1] = val
		return nil
	}
	m.Content = append(m.Content, scalar(last), val)
	return nil
}

// deletePath removes the key at keys, then any mapping left empty by it.
func deletePath(root *yaml.Node, keys ...string) {
	if len(keys) == 0 {
		return
	}
	parent := lookup(root, keys[:len(keys)-1]...)
	if len(keys) == 1 {
		parent = root
	}
	if parent == nil || parent.Kind != yaml.MappingNode {
		return
	}
	removeMappingKey(parent, keys[len(keys)-1])
	if len(keys) > 1 && len(parent.Content) == 0 {
		deletePath(root, keys[:len(keys)-1]...)
	}
}

func scalar(s string) *yaml.Node { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s} }
func intNode(i int) *yaml.Node   { return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(i)} }
func boolNode(b bool) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(b)}
}
func seqNode(items []string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.SequenceNode}
	for _, s := range items {
		n.Content = append(n.Content, scalar(s))
	}
	return n
}

func mappingValue(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

func removeMappingKey(m *yaml.Node, key string) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return
		}
	}
}
```

Note: `scalar()` uses Tag `!!str`. For values that would re-parse as non-strings (e.g. a
project key `"123"` or `yes`), the encoder quotes them because of the explicit tag.
That is the desired behavior.

- [ ] **Step 4: Implement `editable.go`**

```go
package config

import "slices"

// Editable is every non-secret key of config.yaml as written in the file:
// no ~ expansion and no environment overrides, so saving it back never
// rewrites a value the user didn't touch. The UI's settings modal edits it.
//
// When a key is added to Config, add it here (or to ui.password-style
// secret handling) and to the settings modal — settings_keys_test.go fails
// until you do.
type Editable struct {
	WorktreesBase        string
	Editor               string
	JiraProjects         []string
	JiraAliasHosts       []string
	HTTPSPort            int
	AllowedHosts         []string
	TLSCertFile          string
	TLSKeyFile           string
	CmuxFeaturesDisabled bool
}

// ReadEditable reads path's editable values, and whether ui.password is set.
// A missing file yields defaults. HTTPSPort is DefaultHTTPSPort when unset.
func ReadEditable(path string) (Editable, bool, error) {
	doc, err := readDoc(path)
	if err != nil {
		return Editable{}, false, err
	}
	var raw Config
	if err := doc.Decode(&raw); err != nil {
		return Editable{}, false, err
	}
	e := Editable{
		WorktreesBase:        raw.WorktreesBase,
		Editor:               raw.Editor,
		JiraProjects:         raw.Jira.Projects,
		JiraAliasHosts:       raw.Jira.AliasHosts,
		HTTPSPort:            raw.UI.HTTPSPort,
		AllowedHosts:         raw.UI.AllowedHosts,
		TLSCertFile:          raw.UI.TLS.CertFile,
		TLSKeyFile:           raw.UI.TLS.KeyFile,
		CmuxFeaturesDisabled: raw.UI.CmuxFeaturesDisabled,
	}
	if e.HTTPSPort == 0 {
		e.HTTPSPort = DefaultHTTPSPort
	}
	return e, raw.UI.Password != "", nil
}

// WriteEditable writes the fields of next that differ from the file, and
// nothing else. Zero/default values delete their key (and any mapping left
// empty). changed is false, and the file untouched, when nothing differs.
func WriteEditable(path string, next Editable) (bool, error) {
	cur, _, err := ReadEditable(path)
	if err != nil {
		return false, err
	}
	doc, err := readDoc(path)
	if err != nil {
		return false, err
	}
	root := doc.Content[0]
	changed := false
	str := func(old, val string, keys ...string) error {
		if old == val {
			return nil
		}
		changed = true
		if val == "" {
			deletePath(root, keys...)
			return nil
		}
		return setPath(root, scalar(val), keys...)
	}
	list := func(old, val []string, keys ...string) error {
		if slices.Equal(old, val) {
			return nil
		}
		changed = true
		if len(val) == 0 {
			deletePath(root, keys...)
			return nil
		}
		return setPath(root, seqNode(val), keys...)
	}
	steps := []func() error{
		func() error { return str(cur.WorktreesBase, next.WorktreesBase, "worktrees_base") },
		func() error { return str(cur.Editor, next.Editor, "editor") },
		func() error { return list(cur.JiraProjects, next.JiraProjects, "jira", "projects") },
		func() error { return list(cur.JiraAliasHosts, next.JiraAliasHosts, "jira", "alias_hosts") },
		func() error { return list(cur.AllowedHosts, next.AllowedHosts, "ui", "allowed_hosts") },
		func() error { return str(cur.TLSCertFile, next.TLSCertFile, "ui", "tls", "cert_file") },
		func() error { return str(cur.TLSKeyFile, next.TLSKeyFile, "ui", "tls", "key_file") },
		func() error {
			if cur.HTTPSPort == next.HTTPSPort {
				return nil
			}
			changed = true
			if next.HTTPSPort == 0 || next.HTTPSPort == DefaultHTTPSPort {
				deletePath(root, "ui", "https_port")
				return nil
			}
			return setPath(root, intNode(next.HTTPSPort), "ui", "https_port")
		},
		func() error {
			if cur.CmuxFeaturesDisabled == next.CmuxFeaturesDisabled {
				return nil
			}
			changed = true
			if !next.CmuxFeaturesDisabled {
				deletePath(root, "ui", "cmux_features_disabled")
				return nil
			}
			return setPath(root, boolNode(true), "ui", "cmux_features_disabled")
		},
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return false, err
		}
	}
	if !changed {
		return false, nil
	}
	return true, writeDoc(path, doc)
}

// SetPassword writes ui.password. The password is never readable through
// Editable.
func SetPassword(path, password string) error {
	doc, err := readDoc(path)
	if err != nil {
		return err
	}
	if err := setPath(doc.Content[0], scalar(password), "ui", "password"); err != nil {
		return err
	}
	return writeDoc(path, doc)
}
```

- [ ] **Step 5: Reimplement `settings.go` on the new helpers**

Replace `internal/config/settings.go` with:

```go
package config

// SetCmuxFeaturesDisabled writes ui.cmux_features_disabled to the config file
// at path, removing the key when disabled is false (absent is the default).
// Every other key, and the user's comments, survive.
func SetCmuxFeaturesDisabled(path string, disabled bool) error {
	cur, _, err := ReadEditable(path)
	if err != nil {
		return err
	}
	cur.CmuxFeaturesDisabled = disabled
	_, err = WriteEditable(path, cur)
	return err
}
```

(`mappingValue` and `removeMappingKey` moved to `yamledit.go`. `editUIKey` is gone.)

- [ ] **Step 6: Run the tests**

Run: `go test ./internal/config/ && go vet ./internal/config/`
Expected: PASS. That includes the pre-existing `settings_test.go`. If a pre-existing
test asserted that disabling on a missing file writes nothing, it still passes,
because `WriteEditable` reports no change.

- [ ] **Step 7: Commit**

```bash
git add internal/config/yamledit.go internal/config/editable.go internal/config/editable_test.go internal/config/settings.go
git commit --signoff -m "feat(config): node-tree editor for every editable config key

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Settings DTO, GET, and `PUT /api/settings/worktree`

**Files:**
- Rewrite: `internal/webui/settings.go`
- Modify: `internal/webui/server.go` (fields + routes)
- Rewrite: `internal/webui/settings_test.go`

**Interfaces:**
- Consumes: `config.ReadEditable`, `config.WriteEditable` (Task 3); `uitls.ReadCert`; `jira.SetAliasHosts`.
- Produces: the JSON shape below (Tasks 5, 6 and 8 rely on it). Also
  `(*Server).settings() (settingsDTO, error)`, `(*Server).configPath() string` and
  `(*Server).settingsMu sync.Mutex`.

The DTO is laid out so that each editable section is exactly its PUT body. This is a
deliberate refinement of the spec's illustrative JSON: secrets and paths move into
their own objects.

```jsonc
{
  "environment": { "in_cmux": true, "worktrees_base_env": false, "cert_names": ["a.local","1.2.3.4"] | null },
  "paths": { "worktree": "~/.config/worktree/config.yaml", "watcher_auth": "~/.config/watcher/auth.yaml", "watcher_config": "~/.config/watcher/config.yaml" },
  "secrets": { "ui_password": true, "github_token": true, "jira_token": true, "slack_token": true, "slack_cookie": true },
  "worktree": { "worktrees_base": "", "editor": "", "cmux_features_enabled": true,
                "jira": { "projects": [], "alias_hosts": [] },
                "ui": { "https_port": 8476, "allowed_hosts": [], "tls": { "cert_file": "", "key_file": "" } } },
  "watcher_auth": { "jira": { "host": "", "email": "" }, "slack": { "workspace_domain": "" } },
  "watcher_config": { "jira": { "bot_usernames": [], "custom_fields": {} } }
}
```

Lists are always `[]`, never `null`, and maps are always `{}`.

- [ ] **Step 1: Server fields and routes**

In `server.go`, replace the comment and field block:

```go
	// cmuxDisabled is the Settings toggle (ui.cmux_features_disabled); see
	// settings.go. ConfigPath is where it persists; "" means the default.
	cmuxDisabled atomic.Bool
	ConfigPath   string
```

with:

```go
	// cmuxDisabled is the Settings toggle (ui.cmux_features_disabled); see
	// settings.go. ConfigPath, WatcherAuthPath and WatcherConfigPath are the
	// files the Settings modal edits; "" means each one's default.
	cmuxDisabled      atomic.Bool
	ConfigPath        string
	WatcherAuthPath   string
	WatcherConfigPath string
	// settingsMu serializes every settings write, so two saves can't
	// interleave a load and a save of the same file.
	settingsMu sync.Mutex
	// credCheck is a test seam for credential validation; nil uses the
	// watcher library's validators. See settings_creds.go.
	credCheck *credValidators
```

Replace the two settings routes with the full set. The handlers from Tasks 5 and 6 are
added in those tasks. Until then, add only the routes whose handlers exist:

```go
		{"GET /api/settings", s.handleSettings},
		{"PUT /api/settings/worktree", s.handleSettingsWorktree},
```

To make this task compile on its own, also add a stub file
`internal/webui/settings_creds.go` containing only:

```go
package webui

// credValidators is filled in by the credentials task.
type credValidators struct{}
```

(Task 6 replaces it.)

- [ ] **Step 2: Write the failing tests**

Rewrite `internal/webui/settings_test.go`. Keep `unreadTestDB` and any other helpers
it uses from other test files, which are untouched. Replace the cmux tests with:

```go
package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mturley/worktree/internal/cmux"
)

func settingsServer(t *testing.T, worktreeYAML string) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if worktreeYAML != "" {
		if err := os.WriteFile(path, []byte(worktreeYAML), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return &Server{
		cmuxAvailable:     func() bool { return true },
		ConfigPath:        path,
		WatcherAuthPath:   filepath.Join(dir, "auth.yaml"),
		WatcherConfigPath: filepath.Join(dir, "wconfig.yaml"),
	}, path
}

func doReq(s *Server, method, url, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func decodeSettings(t *testing.T, rec *httptest.ResponseRecorder) settingsDTO {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	var got settingsDTO
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestSettingsGetWorktreeSection(t *testing.T) {
	s, _ := settingsServer(t, "worktrees_base: ~/wt\neditor: zed\njira:\n    projects: [ABC]\nui:\n    password: hunter2\n")
	got := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	if got.Worktree.WorktreesBase != "~/wt" || got.Worktree.Editor != "zed" || got.Worktree.Jira.Projects[0] != "ABC" {
		t.Fatalf("worktree = %+v", got.Worktree)
	}
	if got.Worktree.UI.HTTPSPort != 8476 || !got.Worktree.CmuxFeaturesEnabled || !got.Secrets.UIPassword {
		t.Fatalf("got %+v", got)
	}
	if got.Worktree.Jira.AliasHosts == nil || got.Worktree.UI.AllowedHosts == nil {
		t.Fatal("lists must be [] not null")
	}
	if !got.Environment.InCmux {
		t.Fatal("in_cmux")
	}
}

func TestSettingsGetReportsEnvOverride(t *testing.T) {
	t.Setenv("WORKTREES_BASE", "/x")
	s, _ := settingsServer(t, "")
	if !decodeSettings(t, doReq(s, "GET", "/api/settings", "")).Environment.WorktreesBaseEnv {
		t.Fatal("worktrees_base_env should be true")
	}
}

func TestSettingsWorktreePutWritesAndValidates(t *testing.T) {
	s, path := settingsServer(t, "# keep\nui:\n    password: pw\n")
	body := `{"worktrees_base":"~/wt","editor":"zed","cmux_features_enabled":true,
	  "jira":{"projects":[" ABC ","ABC",""],"alias_hosts":[]},
	  "ui":{"https_port":9443,"allowed_hosts":["h.local"],"tls":{"cert_file":"","key_file":""}}}`
	got := decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", body))
	if len(got.Worktree.Jira.Projects) != 1 || got.Worktree.Jira.Projects[0] != "ABC" {
		t.Fatalf("projects not trimmed/deduped: %v", got.Worktree.Jira.Projects)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "# keep") || !strings.Contains(string(data), "https_port: 9443") {
		t.Fatalf("file:\n%s", data)
	}
	bad := strings.Replace(body, "9443", "70000", 1)
	if rec := doReq(s, "PUT", "/api/settings/worktree", bad); rec.Code != http.StatusBadRequest {
		t.Fatalf("port 70000: status %d", rec.Code)
	}
}

func TestSettingsWorktreePutCmuxGate(t *testing.T) {
	s, path := settingsServer(t, "ui:\n    password: pw\n")
	s.DB = unreadTestDB(t)
	s.cmuxList = func() ([]cmux.Workspace, error) { return nil, nil }
	cur := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	cur.Worktree.CmuxFeaturesEnabled = false
	b, _ := json.Marshal(cur.Worktree)
	got := decodeSettings(t, doReq(s, "PUT", "/api/settings/worktree", string(b)))
	if got.Worktree.CmuxFeaturesEnabled || s.cmuxEnabled() {
		t.Fatal("gate should be shut")
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "cmux_features_disabled: true") {
		t.Fatalf("file:\n%s", data)
	}
}

func TestSettingsWorktreePutCmuxRefusedOutsideCmux(t *testing.T) {
	s, path := settingsServer(t, "ui:\n    password: pw\n")
	s.cmuxAvailable = func() bool { return false }
	cur := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	cur.Worktree.CmuxFeaturesEnabled = false
	b, _ := json.Marshal(cur.Worktree)
	if rec := doReq(s, "PUT", "/api/settings/worktree", string(b)); rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "cmux") {
		t.Fatal("a refused save must write nothing")
	}
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `go test ./internal/webui/ -run 'TestSettings'`
Expected: FAIL to compile (`settingsDTO` fields and `handleSettingsWorktree` are undefined).

- [ ] **Step 4: Implement `settings.go`**

```go
package webui

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/uitls"
)

// The Settings modal edits three files — worktree's config.yaml and the
// watcher library's auth.yaml and config.yaml — through one GET and one PUT
// per file. Secrets are never returned, only whether each is set; they are
// replaced through settings_creds.go. See docs/web-ui-architecture.md
// "Settings modal". A new config key must be added here AND to
// settingsKeyPaths (settings_keys_test.go enforces it).

// cmuxReachable reports whether this server can drive cmux at all
// (IsAvailable, not InPane: the server drives cmux from wherever it runs).
// s.cmuxAvailable is the test seam.
func (s *Server) cmuxReachable() bool {
	if s.cmuxAvailable != nil {
		return s.cmuxAvailable()
	}
	return cmux.IsAvailable()
}

// cmuxEnabled is the gate for every cmux feature: reachable, and not turned
// off in Settings. With it false the server behaves as if cmux were not
// running — every cmux endpoint reports unavailable, so the UI hides its
// cmux controls through the checks it already makes.
func (s *Server) cmuxEnabled() bool {
	return s.cmuxReachable() && !s.cmuxDisabled.Load()
}

// SetCmuxFeaturesDisabled sets the gate's initial state from config, before
// the server starts.
func (s *Server) SetCmuxFeaturesDisabled(disabled bool) {
	s.cmuxDisabled.Store(disabled)
}

func (s *Server) configPath() string {
	if s.ConfigPath != "" {
		return s.ConfigPath
	}
	return config.ConfigPath()
}

func (s *Server) watcherAuthPath() string {
	if s.WatcherAuthPath != "" {
		return s.WatcherAuthPath
	}
	return wconfig.DefaultPath()
}

func (s *Server) watcherConfigPath() string {
	if s.WatcherConfigPath != "" {
		return s.WatcherConfigPath
	}
	return wconfig.ConfigDefaultPath()
}

type settingsEnvironment struct {
	// InCmux is whether the server can reach cmux, regardless of the toggle.
	InCmux bool `json:"in_cmux"`
	// WorktreesBaseEnv: $WORKTREES_BASE is set and overrides worktrees_base.
	WorktreesBaseEnv bool `json:"worktrees_base_env"`
	// CertNames are the names the current HTTPS certificate covers (DNS
	// names and IPs), or nil when there is no readable certificate.
	CertNames []string `json:"cert_names"`
}

type settingsPaths struct {
	Worktree      string `json:"worktree"`
	WatcherAuth   string `json:"watcher_auth"`
	WatcherConfig string `json:"watcher_config"`
}

type settingsSecrets struct {
	UIPassword  bool `json:"ui_password"`
	GitHubToken bool `json:"github_token"`
	JiraToken   bool `json:"jira_token"`
	SlackToken  bool `json:"slack_token"`
	SlackCookie bool `json:"slack_cookie"`
}

type worktreeSettings struct {
	WorktreesBase       string `json:"worktrees_base"`
	Editor              string `json:"editor"`
	CmuxFeaturesEnabled bool   `json:"cmux_features_enabled"`
	Jira                struct {
		Projects   []string `json:"projects"`
		AliasHosts []string `json:"alias_hosts"`
	} `json:"jira"`
	UI struct {
		HTTPSPort    int      `json:"https_port"`
		AllowedHosts []string `json:"allowed_hosts"`
		TLS          struct {
			CertFile string `json:"cert_file"`
			KeyFile  string `json:"key_file"`
		} `json:"tls"`
	} `json:"ui"`
}

type settingsDTO struct {
	Environment   settingsEnvironment   `json:"environment"`
	Paths         settingsPaths         `json:"paths"`
	Secrets       settingsSecrets       `json:"secrets"`
	Worktree      worktreeSettings      `json:"worktree"`
	WatcherAuth   watcherAuthSettings   `json:"watcher_auth"`
	WatcherConfig watcherConfigSettings `json:"watcher_config"`
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func toWorktreeSettings(e config.Editable) worktreeSettings {
	var w worktreeSettings
	w.WorktreesBase = e.WorktreesBase
	w.Editor = e.Editor
	w.CmuxFeaturesEnabled = !e.CmuxFeaturesDisabled
	w.Jira.Projects = nonNil(e.JiraProjects)
	w.Jira.AliasHosts = nonNil(e.JiraAliasHosts)
	w.UI.HTTPSPort = e.HTTPSPort
	w.UI.AllowedHosts = nonNil(e.AllowedHosts)
	w.UI.TLS.CertFile = e.TLSCertFile
	w.UI.TLS.KeyFile = e.TLSKeyFile
	return w
}

// cleanList trims entries, drops empties and duplicates, keeping order.
func cleanList(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func certNames(certFile string) []string {
	if certFile == "" {
		return nil
	}
	cert, err := uitls.ReadCert(config.ExpandHome(certFile))
	if err != nil {
		return nil
	}
	names := append([]string{}, cert.DNSNames...)
	for _, ip := range cert.IPAddresses {
		names = append(names, ip.String())
	}
	return names
}

// homeRelative shortens a path under $HOME to ~/..., for display.
func homeRelative(p string) string {
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(p, home+"/") {
		return "~/" + strings.TrimPrefix(p, home+"/")
	}
	return p
}

// settings assembles the full DTO from disk.
func (s *Server) settings() (settingsDTO, error) {
	e, pwSet, err := config.ReadEditable(s.configPath())
	if err != nil {
		return settingsDTO{}, err
	}
	auth, authSecrets, err := s.readWatcherAuth()
	if err != nil {
		return settingsDTO{}, err
	}
	wcfg, err := s.readWatcherConfig()
	if err != nil {
		return settingsDTO{}, err
	}
	dto := settingsDTO{
		Environment: settingsEnvironment{
			InCmux:           s.cmuxReachable(),
			WorktreesBaseEnv: os.Getenv("WORKTREES_BASE") != "",
			CertNames:        certNames(e.TLSCertFile),
		},
		Paths: settingsPaths{
			Worktree:      homeRelative(s.configPath()),
			WatcherAuth:   homeRelative(s.watcherAuthPath()),
			WatcherConfig: homeRelative(s.watcherConfigPath()),
		},
		Secrets:       authSecrets,
		Worktree:      toWorktreeSettings(e),
		WatcherAuth:   auth,
		WatcherConfig: wcfg,
	}
	dto.Secrets.UIPassword = pwSet
	// The live gate, not the file, is what the server is doing right now.
	dto.Worktree.CmuxFeaturesEnabled = !s.cmuxDisabled.Load()
	return dto, nil
}

func (s *Server) writeSettings(w http.ResponseWriter) {
	dto, err := s.settings()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading settings: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, dto)
}

// handleSettings: GET /api/settings
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	s.writeSettings(w)
}

// handleSettingsWorktree: PUT /api/settings/worktree — the whole worktree
// section. Persists to the file first and only then moves live state (the
// cmux gate, Jira alias hosts), so a failed write never leaves the server
// disagreeing with what it will load on restart.
func (s *Server) handleSettingsWorktree(w http.ResponseWriter, r *http.Request) {
	var req worktreeSettings
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if p := req.UI.HTTPSPort; p < 1 || p > 65535 {
		writeError(w, http.StatusBadRequest, "HTTPS port must be between 1 and 65535")
		return
	}
	next := config.Editable{
		WorktreesBase:        strings.TrimSpace(req.WorktreesBase),
		Editor:               strings.TrimSpace(req.Editor),
		JiraProjects:         cleanList(req.Jira.Projects),
		JiraAliasHosts:       cleanList(req.Jira.AliasHosts),
		HTTPSPort:            req.UI.HTTPSPort,
		AllowedHosts:         cleanList(req.UI.AllowedHosts),
		TLSCertFile:          strings.TrimSpace(req.UI.TLS.CertFile),
		TLSKeyFile:           strings.TrimSpace(req.UI.TLS.KeyFile),
		CmuxFeaturesDisabled: !req.CmuxFeaturesEnabled,
	}
	for _, h := range next.AllowedHosts {
		if strings.ContainsAny(h, " /:") && net.ParseIP(h) == nil {
			writeError(w, http.StatusBadRequest, "allowed host "+h+" is not a host name or IP")
			return
		}
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()

	disabled := next.CmuxFeaturesDisabled
	cmuxChanging := disabled != s.cmuxDisabled.Load()
	if cmuxChanging && !s.cmuxReachable() {
		writeError(w, http.StatusConflict, "cmux is not available to this server")
		return
	}
	if _, err := config.WriteEditable(s.configPath(), next); err != nil {
		writeError(w, http.StatusInternalServerError, "saving config: "+err.Error())
		return
	}
	jira.SetAliasHosts(next.JiraAliasHosts)
	if cmuxChanging {
		s.cmuxDisabled.Store(disabled)
		if disabled {
			// The gate is already shut, so no unread pass can put the 📬
			// prefixes back after this takes them off.
			s.cmuxUnreadStrip()
		}
		s.logger().Printf("settings: cmux features %s", map[bool]string{true: "disabled", false: "enabled"}[disabled])
	}
	s.writeSettings(w)
}
```

Allowed-host validation note: IPv6 literals contain `:`, which is why
`net.ParseIP(h) == nil` lets a valid IP through.

Also add temporary stubs to `settings_creds.go` so this task compiles. Task 5 replaces
them:

```go
type watcherAuthSettings struct{}
type watcherConfigSettings struct{}

func (s *Server) readWatcherAuth() (watcherAuthSettings, settingsSecrets, error) {
	return watcherAuthSettings{}, settingsSecrets{}, nil
}
func (s *Server) readWatcherConfig() (watcherConfigSettings, error) {
	return watcherConfigSettings{}, nil
}
```

Note that `settingsDTO` embeds the watcher sections. If the old frontend still calls
`PUT /api/settings` before Task 8, it gets 405. That is fine, because Task 8 lands on
the same branch before anything ships.

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/webui/ && go vet ./internal/webui/`
Expected: PASS. The route-table auth tests in `auth_test.go` cover the new routes
automatically.

- [ ] **Step 6: Commit**

```bash
git add internal/webui/settings.go internal/webui/settings_test.go internal/webui/settings_creds.go internal/webui/server.go
git commit --signoff -m "feat(webui): settings DTO for every config.yaml key, per-file worktree save

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Watcher Auth and Watcher Config sections

**Files:**
- Create: `internal/webui/settings_watcher.go`
- Modify: `internal/webui/settings_creds.go` (remove the Task 4 stubs for these types/functions)
- Modify: `internal/webui/server.go` (routes)
- Test: `internal/webui/settings_watcher_test.go`

**Interfaces:**
- Consumes: `wconfig.Load`, `(*wconfig.Config).Save`, `wconfig.LoadConfig`, `wconfig.SaveConfig` (Task 1).
- Produces: `watcherAuthSettings`, `watcherConfigSettings`, `(*Server).readWatcherAuth()`,
  `(*Server).readWatcherConfig()`, `(*Server).loadWatcherAuth() (*wconfig.Config, error)`.
  Task 6 uses `loadWatcherAuth`.

- [ ] **Step 1: Write the failing tests**

`internal/webui/settings_watcher_test.go`:

```go
package webui

import (
	"net/http"
	"os"
	"strings"
	"testing"
)

const authYAML = `services:
    github:
        token: ghp_SECRET1
    jira:
        host: https://x.atlassian.net
        email: me@x.com
        token: JIRA_SECRET2
    slack:
        token: xoxc-SECRET3
        cookie: xoxd-SECRET4
        workspace_domain: x.slack.com
consumers:
    worktree:
        db: /tmp/w.db
`

func TestWatcherSettingsGetHidesSecrets(t *testing.T) {
	s, _ := settingsServer(t, "ui:\n    password: PW_SECRET5\n")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := doReq(s, "GET", "/api/settings", "")
	for _, secret := range []string{"ghp_SECRET1", "JIRA_SECRET2", "xoxc-SECRET3", "xoxd-SECRET4", "PW_SECRET5"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("response leaks %s: %s", secret, rec.Body)
		}
	}
	got := decodeSettings(t, rec)
	if !got.Secrets.GitHubToken || !got.Secrets.JiraToken || !got.Secrets.SlackToken || !got.Secrets.SlackCookie || !got.Secrets.UIPassword {
		t.Fatalf("secrets = %+v", got.Secrets)
	}
	if got.WatcherAuth.Jira.Host != "https://x.atlassian.net" || got.WatcherAuth.Slack.WorkspaceDomain != "x.slack.com" {
		t.Fatalf("auth = %+v", got.WatcherAuth)
	}
	if strings.Contains(rec.Body.String(), "consumers") || strings.Contains(rec.Body.String(), "/tmp/w.db") {
		t.Fatal("consumers must not be exposed")
	}
}

func TestWatcherSettingsMissingFiles(t *testing.T) {
	s, _ := settingsServer(t, "")
	got := decodeSettings(t, doReq(s, "GET", "/api/settings", ""))
	if got.WatcherConfig.Jira.BotUsernames == nil || got.WatcherConfig.Jira.CustomFields == nil {
		t.Fatal("empty watcher config must be [] / {}")
	}
	rec := doReq(s, "PUT", "/api/settings/watcher-auth", `{"jira":{"host":"https://y.atlassian.net","email":"a@b"},"slack":{"workspace_domain":""}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	info, err := os.Stat(s.WatcherAuthPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("auth.yaml: %v %v", info, err)
	}
	rec = doReq(s, "PUT", "/api/settings/watcher-config", `{"jira":{"bot_usernames":["bot"],"custom_fields":{"epic_key":"customfield_1"}}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	got = decodeSettings(t, rec)
	if got.WatcherConfig.Jira.CustomFields["epic_key"] != "customfield_1" {
		t.Fatalf("got %+v", got.WatcherConfig)
	}
}

func TestWatcherAuthPutKeepsSecretsAndConsumers(t *testing.T) {
	s, _ := settingsServer(t, "")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := doReq(s, "PUT", "/api/settings/watcher-auth", `{"jira":{"host":"https://z.atlassian.net/","email":"z@z"},"slack":{"workspace_domain":"z.slack.com"}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	data, _ := os.ReadFile(s.WatcherAuthPath)
	for _, want := range []string{"JIRA_SECRET2", "xoxd-SECRET4", "/tmp/w.db", "https://z.atlassian.net\n", "z.slack.com"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("auth.yaml lost %q:\n%s", want, data)
		}
	}
}

func TestWatcherAuthPutValidatesHost(t *testing.T) {
	s, _ := settingsServer(t, "")
	rec := doReq(s, "PUT", "/api/settings/watcher-auth", `{"jira":{"host":"not a url","email":""},"slack":{"workspace_domain":""}}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestWatcherConfigPutRejectsBlankField(t *testing.T) {
	s, _ := settingsServer(t, "")
	rec := doReq(s, "PUT", "/api/settings/watcher-config", `{"jira":{"bot_usernames":[],"custom_fields":{"epic_key":" "}}}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d", rec.Code)
	}
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./internal/webui/ -run TestWatcher`
Expected: FAIL (the struct fields are undefined).

- [ ] **Step 3: Implement**

Delete the Task 4 stubs for `watcherAuthSettings`, `watcherConfigSettings`,
`readWatcherAuth` and `readWatcherConfig` from `settings_creds.go`.

`internal/webui/settings_watcher.go`:

```go
package webui

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"

	wconfig "github.com/mturley/watcher/config"
)

// The watcher library's two files, as the Settings modal edits them.
// auth.yaml goes through the library's Load/Save (as `worktree setup`
// does), which keeps every key it knows — including consumers and the
// legacy jira_custom_fields, which the modal deliberately never shows.

type watcherAuthSettings struct {
	Jira struct {
		Host  string `json:"host"`
		Email string `json:"email"`
	} `json:"jira"`
	Slack struct {
		WorkspaceDomain string `json:"workspace_domain"`
	} `json:"slack"`
}

type watcherConfigSettings struct {
	Jira struct {
		BotUsernames []string          `json:"bot_usernames"`
		CustomFields map[string]string `json:"custom_fields"`
	} `json:"jira"`
}

func (s *Server) loadWatcherAuth() (*wconfig.Config, error) {
	return wconfig.Load(s.watcherAuthPath())
}

func (s *Server) readWatcherAuth() (watcherAuthSettings, settingsSecrets, error) {
	var out watcherAuthSettings
	var sec settingsSecrets
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		return out, sec, err
	}
	if g := cfg.Services.GitHub; g != nil {
		sec.GitHubToken = g.Token != ""
	}
	if j := cfg.Services.Jira; j != nil {
		out.Jira.Host, out.Jira.Email = j.Host, j.Email
		sec.JiraToken = j.Token != ""
	}
	if sl := cfg.Services.Slack; sl != nil {
		out.Slack.WorkspaceDomain = sl.WorkspaceDomain
		sec.SlackToken, sec.SlackCookie = sl.Token != "", sl.Cookie != ""
	}
	return out, sec, nil
}

func (s *Server) readWatcherConfig() (watcherConfigSettings, error) {
	var out watcherConfigSettings
	out.Jira.BotUsernames = []string{}
	out.Jira.CustomFields = map[string]string{}
	cfg, err := wconfig.LoadConfig(s.watcherConfigPath())
	if err != nil {
		return out, err
	}
	if cfg.Jira != nil {
		out.Jira.BotUsernames = nonNil(cfg.Jira.BotUsernames)
		if cfg.Jira.CustomFields != nil {
			out.Jira.CustomFields = cfg.Jira.CustomFields
		}
	}
	return out, nil
}

// validJiraHost accepts "" (not configured) or an http(s) URL with a host.
func validJiraHost(h string) bool {
	if h == "" {
		return true
	}
	u, err := url.Parse(h)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

// handleSettingsWatcherAuth: PUT /api/settings/watcher-auth — non-secret
// auth.yaml fields only. Tokens go through the credential endpoints.
func (s *Server) handleSettingsWatcherAuth(w http.ResponseWriter, r *http.Request) {
	var req watcherAuthSettings
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	host := strings.TrimRight(strings.TrimSpace(req.Jira.Host), "/")
	email := strings.TrimSpace(req.Jira.Email)
	domain := strings.TrimSpace(req.Slack.WorkspaceDomain)
	if !validJiraHost(host) {
		writeError(w, http.StatusBadRequest, "Jira host must be an http(s) URL, like https://yourorg.atlassian.net")
		return
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading auth.yaml: "+err.Error())
		return
	}
	changed := false
	if cfg.Services.Jira == nil && (host != "" || email != "") {
		cfg.Services.Jira = &wconfig.JiraConfig{}
	}
	if j := cfg.Services.Jira; j != nil && (j.Host != host || j.Email != email) {
		j.Host, j.Email = host, email
		changed = true
	}
	if cfg.Services.Slack == nil && domain != "" {
		cfg.Services.Slack = &wconfig.SlackConfig{}
	}
	if sl := cfg.Services.Slack; sl != nil && sl.WorkspaceDomain != domain {
		sl.WorkspaceDomain = domain
		changed = true
	}
	if changed {
		if err := cfg.Save(s.watcherAuthPath()); err != nil {
			writeError(w, http.StatusInternalServerError, "saving auth.yaml: "+err.Error())
			return
		}
	}
	s.writeSettings(w)
}

// handleSettingsWatcherConfig: PUT /api/settings/watcher-config
func (s *Server) handleSettingsWatcherConfig(w http.ResponseWriter, r *http.Request) {
	var req watcherConfigSettings
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	bots := cleanList(req.Jira.BotUsernames)
	fields := map[string]string{}
	for k, v := range req.Jira.CustomFields {
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if k == "" || v == "" {
			writeError(w, http.StatusBadRequest, "custom fields need both a name and a field ID")
			return
		}
		fields[k] = v
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	path := s.watcherConfigPath()
	cfg, err := wconfig.LoadConfig(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading watcher config.yaml: "+err.Error())
		return
	}
	// Start from what is there, so top-level keys this version doesn't
	// edit survive; only the Jira block is replaced.
	next := *cfg
	next.Jira = nil
	if len(bots) > 0 || len(fields) > 0 {
		next.Jira = &wconfig.JiraBehavior{}
		if len(bots) > 0 {
			next.Jira.BotUsernames = bots
		}
		if len(fields) > 0 {
			next.Jira.CustomFields = fields
		}
	}
	if !reflect.DeepEqual(*cfg, next) {
		if err := wconfig.SaveConfig(path, &next); err != nil {
			writeError(w, http.StatusInternalServerError, "saving watcher config.yaml: "+err.Error())
			return
		}
	}
	s.writeSettings(w)
}
```

Routes in `server.go`, after the worktree route:

```go
		{"PUT /api/settings/watcher-auth", s.handleSettingsWatcherAuth},
		{"PUT /api/settings/watcher-config", s.handleSettingsWatcherConfig},
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/webui/ && go vet ./internal/webui/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/webui/settings_watcher.go internal/webui/settings_watcher_test.go internal/webui/settings_creds.go internal/webui/server.go
git commit --signoff -m "feat(webui): edit watcher auth.yaml and config.yaml from settings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Credential test/replace endpoints and runtime password replace

**Files:**
- Rewrite: `internal/webui/settings_creds.go`
- Modify: `internal/webui/security.go`, `internal/webui/auth.go`, `internal/webui/server.go`
- Test: `internal/webui/settings_creds_test.go`

**Interfaces:**
- Consumes: `(*Server).loadWatcherAuth`, `settingsMu`, `credCheck` (Tasks 4–5);
  `wgithub.Validate`, `wjira.Validate`, `wslack.Validate`, `wslack.New(...).TeamInfo`;
  `config.SetPassword` (Task 3).
- Produces: routes and JSON:
  - `POST /api/settings/credentials/{service}/test`, body `{}`, or for jira optionally `{"host","email"}`.
  - `PUT /api/settings/credentials/{service}`: github `{"token"}`, jira `{"token","host","email"}`, slack `{"token"?,"cookie"?}`.
  - Both return `credResult{ok bool, kind "ok"|"auth"|"network"|"missing", detail string}`. Test always returns 200. A refused replace returns 422 with the same body.
  - `PUT /api/settings/password`, body `{"password"}` → 204.
  - `(*Security).password() string` and `(*Security).SetPassword(string)`.

- [ ] **Step 1: Write the failing tests**

`internal/webui/settings_creds_test.go`:

```go
package webui

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"

	wgithub "github.com/mturley/watcher/github"
	wslack "github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/uisession"
)

type credLog struct{ github, jira, slack [][]string }

func credServer(t *testing.T, githubErr, jiraErr, slackErr error) (*Server, *credLog) {
	t.Helper()
	s, _ := settingsServer(t, "ui:\n    password: old\n")
	if err := os.WriteFile(s.WatcherAuthPath, []byte(authYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	log := &credLog{}
	s.credCheck = &credValidators{
		github: func(tok string) error { log.github = append(log.github, []string{tok}); return githubErr },
		jira: func(h, e, tok string) error {
			log.jira = append(log.jira, []string{h, e, tok})
			return jiraErr
		},
		slack: func(tok, ck string) error { log.slack = append(log.slack, []string{tok, ck}); return slackErr },
		slackDomain: func(tok, ck string) string { return "new.slack.com" },
	}
	return s, log
}

func decodeCred(t *testing.T, body string) credResult {
	t.Helper()
	var r credResult
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestCredTestStored(t *testing.T) {
	s, log := credServer(t, nil, nil, nil)
	rec := doReq(s, "POST", "/api/settings/credentials/github/test", `{}`)
	if r := decodeCred(t, rec.Body.String()); !r.OK || r.Kind != "ok" || log.github[0][0] != "ghp_SECRET1" {
		t.Fatalf("rec=%s log=%v", rec.Body, log.github)
	}
}

func TestCredTestKinds(t *testing.T) {
	s, _ := credServer(t, wgithub.ErrAuth, errors.New("dial tcp: timeout"), nil)
	if r := decodeCred(t, doReq(s, "POST", "/api/settings/credentials/github/test", `{}`).Body.String()); r.Kind != "auth" {
		t.Fatalf("github kind = %q", r.Kind)
	}
	if r := decodeCred(t, doReq(s, "POST", "/api/settings/credentials/jira/test", `{}`).Body.String()); r.Kind != "network" {
		t.Fatalf("jira kind = %q", r.Kind)
	}
}

func TestCredTestJiraUsesFormHostEmail(t *testing.T) {
	s, log := credServer(t, nil, nil, nil)
	doReq(s, "POST", "/api/settings/credentials/jira/test", `{"host":"https://form.atlassian.net","email":"f@f"}`)
	if got := log.jira[0]; got[0] != "https://form.atlassian.net" || got[1] != "f@f" || got[2] != "JIRA_SECRET2" {
		t.Fatalf("got %v", got)
	}
}

func TestCredTestMissing(t *testing.T) {
	s, _ := settingsServer(t, "")
	s.credCheck = &credValidators{github: func(string) error { t.Fatal("must not validate"); return nil }}
	if r := decodeCred(t, doReq(s, "POST", "/api/settings/credentials/github/test", `{}`).Body.String()); r.Kind != "missing" {
		t.Fatalf("kind = %q", r.Kind)
	}
}

func TestReplaceRefusesInvalidAndWritesNothing(t *testing.T) {
	for _, verr := range []error{wgithub.ErrAuth, errors.New("network down")} {
		s, _ := credServer(t, verr, nil, nil)
		rec := doReq(s, "PUT", "/api/settings/credentials/github", `{"token":"ghp_NEW"}`)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d", rec.Code)
		}
		data, _ := os.ReadFile(s.WatcherAuthPath)
		if strings.Contains(string(data), "ghp_NEW") || !strings.Contains(string(data), "ghp_SECRET1") {
			t.Fatalf("auth.yaml changed:\n%s", data)
		}
	}
}

func TestReplaceGitHubWrites(t *testing.T) {
	s, _ := credServer(t, nil, nil, nil)
	rec := doReq(s, "PUT", "/api/settings/credentials/github", `{"token":" ghp_NEW "}`)
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "ghp_NEW") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body)
	}
	data, _ := os.ReadFile(s.WatcherAuthPath)
	if !strings.Contains(string(data), "token: ghp_NEW") || !strings.Contains(string(data), "/tmp/w.db") {
		t.Fatalf("auth.yaml:\n%s", data)
	}
}

func TestReplaceJiraWritesTriple(t *testing.T) {
	s, _ := credServer(t, nil, nil, nil)
	rec := doReq(s, "PUT", "/api/settings/credentials/jira", `{"token":"J2","host":"https://n.atlassian.net/","email":"n@n"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	data, _ := os.ReadFile(s.WatcherAuthPath)
	for _, want := range []string{"host: https://n.atlassian.net\n", "email: n@n", "token: J2"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("missing %q:\n%s", want, data)
		}
	}
}

func TestReplaceSlackCookieOnlyUsesStoredToken(t *testing.T) {
	s, log := credServer(t, nil, nil, nil)
	rec := doReq(s, "PUT", "/api/settings/credentials/slack", `{"cookie":"xoxd-NEW"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	if got := log.slack[0]; got[0] != "xoxc-SECRET3" || got[1] != "xoxd-NEW" {
		t.Fatalf("validated %v", got)
	}
	data, _ := os.ReadFile(s.WatcherAuthPath)
	for _, want := range []string{"token: xoxc-SECRET3", "cookie: xoxd-NEW", "workspace_domain: new.slack.com"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("missing %q:\n%s", want, data)
		}
	}
}

func TestReplaceSlackAuthError(t *testing.T) {
	s, _ := credServer(t, nil, nil, wslack.ErrAuth)
	rec := doReq(s, "PUT", "/api/settings/credentials/slack", `{"token":"xoxc-NEW"}`)
	if rec.Code != http.StatusUnprocessableEntity || decodeCred(t, rec.Body.String()).Kind != "auth" {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
}

func TestReplaceRejectsEmpty(t *testing.T) {
	s, _ := credServer(t, nil, nil, nil)
	for _, c := range []struct{ svc, body string }{{"github", `{"token":""}`}, {"slack", `{}`}, {"jira", `{"token":"t","host":"","email":""}`}, {"nope", `{"token":"t"}`}} {
		if rec := doReq(s, "PUT", "/api/settings/credentials/"+c.svc, c.body); rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d", c.svc, rec.Code)
		}
	}
}

func TestPasswordReplaceAppliesLive(t *testing.T) {
	s, path := settingsServer(t, "# c\nui:\n    password: old\n")
	s.Security = &Security{Password: "old", Sessions: &uisession.Store{}}
	if rec := doReq(s, "PUT", "/api/settings/password", `{"password":"new-pw"}`); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d %s", rec.Code, rec.Body)
	}
	if s.Security.password() != "new-pw" {
		t.Fatal("live password not swapped")
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), "password: new-pw") || !strings.Contains(string(data), "# c") {
		t.Fatalf("file:\n%s", data)
	}
	if rec := doReq(s, "PUT", "/api/settings/password", `{"password":"  "}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("blank: status %d", rec.Code)
	}
}
```

If `uisession.Store{}` can't be constructed as a zero value, use whatever
`auth_test.go` uses to build a `Security`. Check with `grep -n "Security{" internal/webui/auth_test.go`.

Note: with `s.Security` set, `Handler()` may enforce login. If it does, call
`s.handlePasswordReplace` directly through an `httptest.NewRecorder` with
`r.SetPathValue` as needed, instead of going through `Handler()`. Check how `auth_test.go`
reaches authenticated routes and follow that pattern.

- [ ] **Step 2: Run them to verify they fail**

Run: `go test ./internal/webui/ -run 'TestCred|TestReplace|TestPassword'`
Expected: FAIL to compile.

- [ ] **Step 3: Implement the runtime password**

In `security.go`, add a mutex field and accessors. Keep `Password` as the
initial-value field so existing struct literals still compile:

```go
type Security struct {
	// Password is what POST /api/login checks. Required. Set it before
	// serving; afterwards read it with password() and change it with
	// SetPassword, which the Settings modal's password replace uses.
	Password string
	pwMu     sync.RWMutex
	// ...existing fields unchanged...
}

func (sec *Security) password() string {
	sec.pwMu.RLock()
	defer sec.pwMu.RUnlock()
	return sec.Password
}

// SetPassword changes the login password for the running server. Existing
// sessions stay valid.
func (sec *Security) SetPassword(pw string) {
	sec.pwMu.Lock()
	defer sec.pwMu.Unlock()
	sec.Password = pw
}
```

Change `validate()` to use `sec.password()`, and `auth.go:134` to
`passwordMatches(req.Password, s.Security.password())`. Run
`grep -rn "Security.Password\|\.Password\b" internal/webui cmd | grep -v _test` and switch
every runtime read to `password()`.

The `sync.RWMutex` makes `Security` non-copyable, so `go vet` flags copies. Pass
`*Security` everywhere it is already passed. Verify with
`go vet ./internal/webui/ ./cmd/`.

- [ ] **Step 4: Implement `settings_creds.go`**

```go
package webui

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	wconfig "github.com/mturley/watcher/config"
	wgithub "github.com/mturley/watcher/github"
	wjira "github.com/mturley/watcher/jira"
	wslack "github.com/mturley/watcher/slack"
	"github.com/mturley/worktree/internal/config"
)

// Credential test and replace for the Settings modal's Watcher Auth tab,
// plus the write-only UI password. A replace validates first and writes
// only on success — any failure, rejection or unreachable service alike,
// leaves the stored credential in place. Secrets travel only inward: no
// response ever contains one.

type credValidators struct {
	github      func(token string) error
	jira        func(host, email, token string) error
	slack       func(token, cookie string) error
	slackDomain func(token, cookie string) string
}

func (s *Server) validators() credValidators {
	if s.credCheck != nil {
		return *s.credCheck
	}
	return credValidators{
		github: func(t string) error { return wgithub.Validate(t) },
		jira:   wjira.Validate,
		slack:  func(t, c string) error { return wslack.Validate(t, c) },
		slackDomain: func(t, c string) string {
			d, err := wslack.New(t, c).TeamInfo(context.Background())
			if err != nil {
				return ""
			}
			return d
		},
	}
}

type credResult struct {
	OK     bool   `json:"ok"`
	Kind   string `json:"kind"` // ok | auth | network | missing
	Detail string `json:"detail"`
}

func classify(err error) credResult {
	switch {
	case err == nil:
		return credResult{OK: true, Kind: "ok"}
	case errors.Is(err, wgithub.ErrAuth), errors.Is(err, wjira.ErrAuth), errors.Is(err, wslack.ErrAuth):
		return credResult{Kind: "auth", Detail: err.Error()}
	default:
		return credResult{Kind: "network", Detail: err.Error()}
	}
}

var missing = credResult{Kind: "missing", Detail: "not configured"}

type credRequest struct {
	Token  string `json:"token"`
	Cookie string `json:"cookie"`
	Host   string `json:"host"`
	Email  string `json:"email"`
}

func decodeCred(w http.ResponseWriter, r *http.Request) (credRequest, error) {
	var req credRequest
	if r.ContentLength == 0 {
		return req, nil
	}
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req)
	req.Token = strings.TrimSpace(req.Token)
	req.Cookie = strings.TrimSpace(req.Cookie)
	req.Host = strings.TrimRight(strings.TrimSpace(req.Host), "/")
	req.Email = strings.TrimSpace(req.Email)
	return req, err
}

// handleCredTest: POST /api/settings/credentials/{service}/test
func (s *Server) handleCredTest(w http.ResponseWriter, r *http.Request) {
	req, err := decodeCred(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading auth.yaml: "+err.Error())
		return
	}
	v := s.validators()
	switch svc := r.PathValue("service"); svc {
	case "github":
		g := cfg.Services.GitHub
		if g == nil || g.Token == "" {
			writeJSON(w, http.StatusOK, missing)
			return
		}
		writeJSON(w, http.StatusOK, classify(v.github(g.Token)))
	case "jira":
		j := cfg.Services.Jira
		if j == nil || j.Token == "" {
			writeJSON(w, http.StatusOK, missing)
			return
		}
		host, email := j.Host, j.Email
		if req.Host != "" {
			host = req.Host
		}
		if req.Email != "" {
			email = req.Email
		}
		writeJSON(w, http.StatusOK, classify(v.jira(host, email, j.Token)))
	case "slack":
		sl := cfg.Services.Slack
		if sl == nil || sl.Token == "" || sl.Cookie == "" {
			writeJSON(w, http.StatusOK, missing)
			return
		}
		writeJSON(w, http.StatusOK, classify(v.slack(sl.Token, sl.Cookie)))
	default:
		writeError(w, http.StatusNotFound, "unknown service "+svc)
	}
}

// handleCredReplace: PUT /api/settings/credentials/{service}
func (s *Server) handleCredReplace(w http.ResponseWriter, r *http.Request) {
	req, err := decodeCred(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	cfg, err := s.loadWatcherAuth()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reading auth.yaml: "+err.Error())
		return
	}
	v := s.validators()
	var apply func()
	var verr error
	switch svc := r.PathValue("service"); svc {
	case "github":
		if req.Token == "" {
			writeError(w, http.StatusBadRequest, "token is required")
			return
		}
		verr = v.github(req.Token)
		apply = func() { cfg.Services.GitHub = &wconfig.GitHubConfig{Token: req.Token} }
	case "jira":
		if req.Token == "" || req.Host == "" || req.Email == "" {
			writeError(w, http.StatusBadRequest, "token, host and email are required")
			return
		}
		if !validJiraHost(req.Host) {
			writeError(w, http.StatusBadRequest, "Jira host must be an http(s) URL")
			return
		}
		verr = v.jira(req.Host, req.Email, req.Token)
		apply = func() {
			cfg.Services.Jira = &wconfig.JiraConfig{Host: req.Host, Email: req.Email, Token: req.Token}
		}
	case "slack":
		if req.Token == "" && req.Cookie == "" {
			writeError(w, http.StatusBadRequest, "token or cookie is required")
			return
		}
		tok, ck := req.Token, req.Cookie
		if sl := cfg.Services.Slack; sl != nil {
			if tok == "" {
				tok = sl.Token
			}
			if ck == "" {
				ck = sl.Cookie
			}
		}
		if tok == "" || ck == "" {
			writeJSON(w, http.StatusUnprocessableEntity, credResult{Kind: "missing",
				Detail: "Slack needs both a token and a cookie; the other one isn't stored yet"})
			return
		}
		verr = v.slack(tok, ck)
		apply = func() {
			domain := v.slackDomain(tok, ck)
			if domain == "" && cfg.Services.Slack != nil {
				domain = cfg.Services.Slack.WorkspaceDomain // best-effort; keep the old one
			}
			cfg.Services.Slack = &wconfig.SlackConfig{Token: tok, Cookie: ck, WorkspaceDomain: domain}
		}
	default:
		writeError(w, http.StatusNotFound, "unknown service "+svc)
		return
	}
	if verr != nil {
		writeJSON(w, http.StatusUnprocessableEntity, classify(verr))
		return
	}
	apply()
	if err := cfg.Save(s.watcherAuthPath()); err != nil {
		writeError(w, http.StatusInternalServerError, "saving auth.yaml: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, credResult{OK: true, Kind: "ok"})
}

// handlePasswordReplace: PUT /api/settings/password. Writes the file, then
// swaps the running server's password; existing sessions stay valid.
func (s *Server) handlePasswordReplace(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	pw := strings.TrimSpace(req.Password)
	if pw == "" {
		writeError(w, http.StatusBadRequest, "password can't be empty")
		return
	}
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	if err := config.SetPassword(s.configPath(), pw); err != nil {
		writeError(w, http.StatusInternalServerError, "saving config: "+err.Error())
		return
	}
	if s.Security != nil {
		s.Security.SetPassword(pw)
	}
	s.logger().Printf("settings: UI password replaced")
	w.WriteHeader(http.StatusNoContent)
}
```

Routes in `server.go`:

```go
		{"PUT /api/settings/password", s.handlePasswordReplace},
		{"PUT /api/settings/credentials/{service}", s.handleCredReplace},
		{"POST /api/settings/credentials/{service}/test", s.handleCredTest},
```

If the auth route-table tests build requests from the pattern string, a `{service}`
wildcard may need substituting. Check `auth_test.go` for how it builds URLs from
patterns. Existing wildcard routes, if any, show the convention: run
`grep -n '{' internal/webui/server.go | head`.

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/webui/ ./cmd/ && go vet ./internal/webui/ ./cmd/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/webui/settings_creds.go internal/webui/settings_creds_test.go internal/webui/security.go internal/webui/auth.go internal/webui/server.go
git commit --signoff -m "feat(webui): validate-then-write credential replace, credential test, live password replace

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Guard test — every config key is handled by the modal

**Files:**
- Create: `internal/webui/settings_keys.go`
- Test: `internal/webui/settings_keys_test.go`

**Interfaces:**
- Produces: `settingsKeyPaths` (handled key paths per file) and
  `settingsKeyExclusions`. The CLAUDE.md guidance in Task 11 cites both by name.

- [ ] **Step 1: Write the failing test**

`internal/webui/settings_keys_test.go`:

```go
package webui

import (
	"reflect"
	"sort"
	"strings"
	"testing"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/config"
)

// yamlPaths lists every leaf key path of t's yaml tags. Structs (and
// pointers to them) recurse; anything else — scalars, slices, maps — is a
// leaf the modal edits as a whole.
func yamlPaths(t reflect.Type, prefix string) []string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	var out []string
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		name := strings.Split(f.Tag.Get("yaml"), ",")[0]
		if name == "" || name == "-" || !f.IsExported() {
			continue
		}
		path := name
		if prefix != "" {
			path = prefix + "." + name
		}
		ft := f.Type
		for ft.Kind() == reflect.Pointer {
			ft = ft.Elem()
		}
		if ft.Kind() == reflect.Struct {
			out = append(out, yamlPaths(ft, path)...)
		} else {
			out = append(out, path)
		}
	}
	return out
}

func TestSettingsModalCoversEveryConfigKey(t *testing.T) {
	files := map[string]reflect.Type{
		"worktree":       reflect.TypeOf(config.Config{}),
		"watcher_auth":   reflect.TypeOf(wconfig.Config{}),
		"watcher_config": reflect.TypeOf(wconfig.ConfigFile{}),
	}
	for file, typ := range files {
		var want []string
		for _, p := range yamlPaths(typ, "") {
			if !settingsKeyExclusions[file][p] {
				want = append(want, p)
			}
		}
		got := append([]string{}, settingsKeyPaths[file]...)
		sort.Strings(want)
		sort.Strings(got)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: the Settings modal handles %v but the config has %v.\n"+
				"A config key was added or removed: update the Settings modal (DTO, PUT handler, panel, tests) "+
				"and settingsKeyPaths — or, if it must never be shown, settingsKeyExclusions with a reason.",
				file, got, want)
		}
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/webui/ -run TestSettingsModalCoversEveryConfigKey`
Expected: FAIL (`settingsKeyPaths` is undefined).

- [ ] **Step 3: Implement `settings_keys.go`**

```go
package webui

// settingsKeyPaths lists, per file, every YAML key path the Settings modal
// reads and writes. settings_keys_test.go compares it with the config
// structs' yaml tags, so adding a key to any of the three files fails the
// build's tests until the modal handles it (see CLAUDE.md "Settings modal").
var settingsKeyPaths = map[string][]string{
	"worktree": {
		"worktrees_base",
		"editor",
		"jira.projects",
		"jira.alias_hosts",
		"ui.password", // write-only: PUT /api/settings/password
		"ui.https_port",
		"ui.allowed_hosts",
		"ui.tls.cert_file",
		"ui.tls.key_file",
		"ui.cmux_features_disabled",
	},
	"watcher_auth": {
		"services.github.token", // write-only: credentials endpoints
		"services.jira.host",
		"services.jira.email",
		"services.jira.token", // write-only
		"services.slack.token",  // write-only
		"services.slack.cookie", // write-only
		"services.slack.workspace_domain",
	},
	"watcher_config": {
		"jira.bot_usernames",
		"jira.custom_fields",
	},
}

// settingsKeyExclusions are keys the modal deliberately never shows.
var settingsKeyExclusions = map[string]map[string]bool{
	"watcher_auth": {
		"consumers":          true, // owned by `worktree setup`; a DB path is not a user setting
		"jira_custom_fields": true, // legacy; custom fields belong in watcher config.yaml
	},
}
```

- [ ] **Step 4: Run it**

Run: `go test ./internal/webui/ -run TestSettingsModalCoversEveryConfigKey`
Expected: PASS. If it fails, the error lists the real key set. Reconcile with it,
because this is precisely what the test is for.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/settings_keys.go internal/webui/settings_keys_test.go
git commit --signoff -m "test(webui): fail when a config key is not handled by the Settings modal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend types, API client, and `useSettingsDraft`

**Files:**
- Modify: `ui/src/api/types.ts` (replace `Settings`)
- Modify: `ui/src/api/client.ts` (replace `settings`/`updateSettings`)
- Create: `ui/src/components/settings/useSettingsDraft.ts`
- Create: `ui/src/components/settings/testSettings.ts` (shared test fixture)
- Test: `ui/src/components/settings/useSettingsDraft.test.ts`

**Interfaces:**
- Consumes: the Task 4 DTO shape.
- Produces:

```ts
// types.ts
export interface WorktreeSettings { worktrees_base: string; editor: string; cmux_features_enabled: boolean;
  jira: { projects: string[]; alias_hosts: string[] };
  ui: { https_port: number; allowed_hosts: string[]; tls: { cert_file: string; key_file: string } } }
export interface WatcherAuthSettings { jira: { host: string; email: string }; slack: { workspace_domain: string } }
export interface WatcherConfigSettings { jira: { bot_usernames: string[]; custom_fields: Record<string, string> } }
export interface Settings {
  environment: { in_cmux: boolean; worktrees_base_env: boolean; cert_names: string[] | null }
  paths: { worktree: string; watcher_auth: string; watcher_config: string }
  secrets: { ui_password: boolean; github_token: boolean; jira_token: boolean; slack_token: boolean; slack_cookie: boolean }
  worktree: WorktreeSettings; watcher_auth: WatcherAuthSettings; watcher_config: WatcherConfigSettings }
export type CredService = "github" | "jira" | "slack"
export interface CredResult { ok: boolean; kind: "ok" | "auth" | "network" | "missing"; detail: string }

// client.ts (api.*)
settings(): Promise<Settings>
saveWorktreeSettings(s: WorktreeSettings): Promise<Settings>
saveWatcherAuthSettings(s: WatcherAuthSettings): Promise<Settings>
saveWatcherConfigSettings(s: WatcherConfigSettings): Promise<Settings>
testCredential(svc: CredService, override?: { host?: string; email?: string }): Promise<CredResult>
replaceCredential(svc: CredService, body: { token?: string; cookie?: string; host?: string; email?: string }): Promise<CredResult>
replacePassword(password: string): Promise<void>

// useSettingsDraft.ts
export type SettingsFile = "worktree" | "watcher_auth" | "watcher_config"
export interface Drafts { worktree: WorktreeSettings; watcher_auth: WatcherAuthSettings; watcher_config: WatcherConfigSettings }
export function useSettingsDraft(server: Settings | undefined): {
  drafts: Drafts | null
  dirty: Record<SettingsFile, boolean>
  anyDirty: boolean
  restartCount: number            // changed fields among ui.https_port, ui.allowed_hosts, ui.tls.*
  update: <F extends SettingsFile>(file: F, fn: (d: Drafts[F]) => Drafts[F]) => void
  discard: () => void
  save: () => Promise<{ saved: SettingsFile[]; errors: Partial<Record<SettingsFile, string>>; settings?: Settings }>
  saving: boolean
  errors: Partial<Record<SettingsFile, string>>
  rebase: (s: Settings) => void   // after a secret replace etc.: refresh baselines, keep dirty edits
}
```

- [ ] **Step 1: Write the failing test**

`ui/src/components/settings/useSettingsDraft.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { api } from "../../api/client"
import { useSettingsDraft } from "./useSettingsDraft"
import { baseSettings } from "./testSettings"
```

`ui/src/components/settings/testSettings.ts` is the shared fixture, used by this test and by `SettingsModal.test.tsx`:

```ts
import type { Settings } from "../../api/types"

export const baseSettings = (): Settings => ({
  environment: { in_cmux: true, worktrees_base_env: false, cert_names: ["a.local"] },
  paths: { worktree: "~/.config/worktree/config.yaml", watcher_auth: "~/.config/watcher/auth.yaml", watcher_config: "~/.config/watcher/config.yaml" },
  secrets: { ui_password: true, github_token: true, jira_token: true, slack_token: true, slack_cookie: true },
  worktree: { worktrees_base: "~/.worktrees", editor: "", cmux_features_enabled: true,
    jira: { projects: ["ABC"], alias_hosts: [] },
    ui: { https_port: 8476, allowed_hosts: ["a.local"], tls: { cert_file: "~/c.pem", key_file: "~/k.pem" } } },
  watcher_auth: { jira: { host: "https://x.atlassian.net", email: "me@x" }, slack: { workspace_domain: "x.slack.com" } },
  watcher_config: { jira: { bot_usernames: [], custom_fields: { a: "customfield_1", b: "customfield_2" } } },
})
```

The rest of `useSettingsDraft.test.ts`:

```ts
afterEach(() => vi.restoreAllMocks())

describe("useSettingsDraft", () => {
  it("tracks dirty per file and counts restart fields", () => {
    const { result } = renderHook(() => useSettingsDraft(baseSettings()))
    expect(result.current.anyDirty).toBe(false)
    act(() => result.current.update("worktree", (d) => ({ ...d, editor: "zed", ui: { ...d.ui, https_port: 9000 } })))
    expect(result.current.dirty).toEqual({ worktree: true, watcher_auth: false, watcher_config: false })
    expect(result.current.restartCount).toBe(1)
  })

  it("ignores map key order when comparing", () => {
    const { result } = renderHook(() => useSettingsDraft(baseSettings()))
    act(() => result.current.update("watcher_config", (d) => ({ jira: { ...d.jira, custom_fields: { b: "customfield_2", a: "customfield_1" } } })))
    expect(result.current.dirty.watcher_config).toBe(false)
  })

  it("discard restores server values", () => {
    const { result } = renderHook(() => useSettingsDraft(baseSettings()))
    act(() => result.current.update("worktree", (d) => ({ ...d, editor: "zed" })))
    act(() => result.current.discard())
    expect(result.current.anyDirty).toBe(false)
    expect(result.current.drafts!.worktree.editor).toBe("")
  })

  it("saves only dirty files and keeps a failed file dirty", async () => {
    const saved = baseSettings()
    saved.worktree.editor = "zed"
    const w = vi.spyOn(api, "saveWorktreeSettings").mockResolvedValue(saved)
    const a = vi.spyOn(api, "saveWatcherAuthSettings").mockRejectedValue(new Error("disk full"))
    const c = vi.spyOn(api, "saveWatcherConfigSettings")
    const { result } = renderHook(() => useSettingsDraft(baseSettings()))
    act(() => {
      result.current.update("worktree", (d) => ({ ...d, editor: "zed" }))
      result.current.update("watcher_auth", (d) => ({ ...d, jira: { ...d.jira, email: "new@x" } }))
    })
    let out: Awaited<ReturnType<typeof result.current.save>>
    await act(async () => { out = await result.current.save() })
    expect(w).toHaveBeenCalledOnce()
    expect(a).toHaveBeenCalledOnce()
    expect(c).not.toHaveBeenCalled()
    expect(out!.saved).toEqual(["worktree"])
    expect(result.current.errors.watcher_auth).toBe("disk full")
    expect(result.current.dirty).toEqual({ worktree: false, watcher_auth: true, watcher_config: false })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && npx vitest run src/components/settings/useSettingsDraft.test.ts`
Expected: FAIL (the module is not found).

- [ ] **Step 3: Implement the types and client**

In `types.ts`, replace the `Settings` interface with the types in **Interfaces** above,
with one doc comment per field mirroring the Go DTO comments.

In `client.ts`, replace `settings` and `updateSettings`:

```ts
  settings: () => fetchJSON<Settings>("/api/settings"),
  saveWorktreeSettings: (s: WorktreeSettings) => putJSON<Settings>("/api/settings/worktree", s),
  saveWatcherAuthSettings: (s: WatcherAuthSettings) => putJSON<Settings>("/api/settings/watcher-auth", s),
  saveWatcherConfigSettings: (s: WatcherConfigSettings) => putJSON<Settings>("/api/settings/watcher-config", s),
  testCredential: (svc: CredService, override: { host?: string; email?: string } = {}) =>
    fetchJSON<CredResult>(`/api/settings/credentials/${svc}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(override),
    }),
  /**
   * Validate-then-write. A refused credential comes back as a 422 whose body
   * is a CredResult; it is returned (ok: false), not thrown, so the field can
   * say why.
   */
  replaceCredential: async (svc: CredService, body: { token?: string; cookie?: string; host?: string; email?: string }) => {
    const res = await fetch(`/api/settings/credentials/${svc}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    reportIfLoginRequired(res)
    const data = await res.json().catch(() => null)
    if (res.ok || res.status === 422) return data as CredResult
    throw new HttpError((data && data.error) || `HTTP ${res.status}`, res.status)
  },
  replacePassword: async (password: string) => {
    const res = await fetch("/api/settings/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
    reportIfLoginRequired(res)
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      throw new HttpError((data && data.error) || `HTTP ${res.status}`, res.status)
    }
  },
```

Add the helper next to `cmuxPost`:

```ts
function putJSON<T>(url: string, body: unknown) {
  return fetchJSON<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}
```

Update the type import line with `CredResult`, `CredService`, `WatcherAuthSettings`,
`WatcherConfigSettings` and `WorktreeSettings`.

- [ ] **Step 4: Implement `useSettingsDraft.ts`**

```ts
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../../api/client"
import type { Settings, WatcherAuthSettings, WatcherConfigSettings, WorktreeSettings } from "../../api/types"

export type SettingsFile = "worktree" | "watcher_auth" | "watcher_config"
export interface Drafts {
  worktree: WorktreeSettings
  watcher_auth: WatcherAuthSettings
  watcher_config: WatcherConfigSettings
}

const FILES: SettingsFile[] = ["worktree", "watcher_auth", "watcher_config"]

const savers: { [F in SettingsFile]: (d: Drafts[F]) => Promise<Settings> } = {
  worktree: (d) => api.saveWorktreeSettings(d),
  watcher_auth: (d) => api.saveWatcherAuthSettings(d),
  watcher_config: (d) => api.saveWatcherConfigSettings(d),
}

/** JSON with object keys sorted, so a reordered map isn't a change. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  )
}

const pick = (s: Settings): Drafts => ({ worktree: s.worktree, watcher_auth: s.watcher_auth, watcher_config: s.watcher_config })

/**
 * The Settings modal's edit buffer: one draft per file, compared with the
 * server's values for dirty state. Secrets are not in here — SecretField
 * replaces them directly.
 */
export function useSettingsDraft(server: Settings | undefined) {
  const [base, setBase] = useState<Drafts | null>(server ? pick(server) : null)
  const [drafts, setDrafts] = useState<Drafts | null>(server ? pick(server) : null)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<SettingsFile, string>>>({})

  // First load only; later server values arrive through save/rebase so a
  // background refetch never clobbers edits in progress.
  useEffect(() => {
    if (server && !base) {
      setBase(pick(server))
      setDrafts(pick(server))
    }
  }, [server, base])

  const dirty = useMemo(() => {
    const out = { worktree: false, watcher_auth: false, watcher_config: false }
    if (base && drafts) for (const f of FILES) out[f] = canonical(base[f]) !== canonical(drafts[f])
    return out
  }, [base, drafts])

  const restartCount = useMemo(() => {
    if (!base || !drafts) return 0
    const a = base.worktree.ui, b = drafts.worktree.ui
    return [a.https_port !== b.https_port, canonical(a.allowed_hosts) !== canonical(b.allowed_hosts),
      a.tls.cert_file !== b.tls.cert_file, a.tls.key_file !== b.tls.key_file].filter(Boolean).length
  }, [base, drafts])

  const update = useCallback(<F extends SettingsFile>(file: F, fn: (d: Drafts[F]) => Drafts[F]) => {
    setDrafts((d) => (d ? { ...d, [file]: fn(d[file]) } : d))
  }, [])

  const discard = useCallback(() => {
    setDrafts(base)
    setErrors({})
  }, [base])

  /** New server values for every file that has no unsaved edits. */
  const rebase = useCallback((s: Settings) => {
    const next = pick(s)
    setBase((b) => {
      setDrafts((d) => {
        if (!d || !b) return next
        const out = { ...d }
        for (const f of FILES) if (canonical(b[f]) === canonical(d[f])) (out as Record<SettingsFile, unknown>)[f] = next[f]
        return out
      })
      return next
    })
  }, [])

  const save = useCallback(async () => {
    const saved: SettingsFile[] = []
    const errs: Partial<Record<SettingsFile, string>> = {}
    let latest: Settings | undefined
    if (!drafts) return { saved, errors: errs }
    setSaving(true)
    for (const f of FILES) {
      if (!dirty[f]) continue
      try {
        latest = await (savers[f] as (d: unknown) => Promise<Settings>)(drafts[f])
        saved.push(f)
        const fresh = pick(latest)[f]
        setBase((b) => (b ? { ...b, [f]: fresh } : b))
        setDrafts((d) => (d ? { ...d, [f]: fresh } : d))
      } catch (e) {
        errs[f] = e instanceof Error ? e.message : String(e)
      }
    }
    setErrors(errs)
    setSaving(false)
    return { saved, errors: errs, settings: latest }
  }, [drafts, dirty])

  return { drafts, dirty, anyDirty: FILES.some((f) => dirty[f]), restartCount, update, discard, save, saving, errors, rebase }
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd ui && npx vitest run src/components/settings/useSettingsDraft.test.ts && npx tsc --noEmit -p .`
Expected: the hook tests PASS. `tsc` reports errors only in `SettingsModal.tsx` and its
test, because they still use the old `Settings` shape. Task 9 fixes them. Note the
count, so you know they are the only ones.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/types.ts ui/src/api/client.ts ui/src/components/settings/useSettingsDraft.ts ui/src/components/settings/useSettingsDraft.test.ts ui/src/components/settings/testSettings.ts
git commit --signoff -m "feat(ui): settings API client and per-file draft state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Modal shell, shared parts, and the General tab

**Files:**
- Create: `ui/src/components/settings/parts.tsx`
- Create: `ui/src/components/settings/GeneralPanel.tsx`
- Rewrite: `ui/src/components/SettingsModal.tsx`
- Rewrite: `ui/src/components/SettingsModal.test.tsx`

**Interfaces:**
- Consumes: `useSettingsDraft`, `Drafts` and `SettingsFile` (Task 8). `SecretField` comes from Task 10. For this task, render the password row as a temporary `<Text c="dimmed">•••• set</Text>`; Task 10 swaps it in.
- Produces:
  - `parts.tsx`: `PersistedTo({ path })`, `SettingsSection({ title, badge?, children })`, `KeyPath({ path })`.
  - `GeneralPanel` props: `{ settings: Settings; draft: WorktreeSettings; update: (fn: (d: WorktreeSettings) => WorktreeSettings) => void; error?: string; onSecretSaved: () => void; onShowWatcherAuth: () => void }`.
  - Panels in Task 10 follow the same props shape for their own file.

- [ ] **Step 1: Write the failing tests**

Rewrite `ui/src/components/SettingsModal.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { SettingsModal } from "./SettingsModal"
import { baseSettings } from "./settings/testSettings"

function renderModal(qc = new QueryClient(), onClose = () => {}) {
  render(
    <QueryClientProvider client={qc}>
      <MantineProvider><SettingsModal opened onClose={onClose} /></MantineProvider>
    </QueryClientProvider>,
  )
  return qc
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("SettingsModal", () => {
  it("has the four tabs and the persisted-to line", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    for (const name of ["General", "Watcher Auth", "Watcher Config", "Devices"]) {
      expect(screen.getByRole("tab", { name: new RegExp(name) })).toBeInTheDocument()
    }
    expect(await screen.findByText(/These settings are persisted to/)).toHaveTextContent("~/.config/worktree/config.yaml")
  })

  it("does not save the cmux toggle until Save, then refreshes cmux queries", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const after = baseSettings()
    after.worktree.cmux_features_enabled = false
    const save = vi.spyOn(api, "saveWorktreeSettings").mockResolvedValue(after)
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, "invalidateQueries")
    renderModal(qc)
    await userEvent.click(await screen.findByLabelText(/^Enable cmux features/))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0][0].cmux_features_enabled).toBe(false)
    const predicate = invalidate.mock.calls.map((c) => c[0]?.predicate).find(Boolean)
    expect(predicate!({ queryKey: ["cmux-tree", "/wt"] } as never)).toBe(true)
    expect(predicate!({ queryKey: ["session"] } as never)).toBe(true)
    expect(predicate!({ queryKey: ["worktrees"] } as never)).toBe(false)
  })

  it("greys the cmux toggle out when the server is not in cmux", async () => {
    const s = baseSettings()
    s.environment.in_cmux = false
    vi.spyOn(api, "settings").mockResolvedValue(s)
    renderModal()
    await waitFor(async () => expect(await screen.findByLabelText(/^Enable cmux features/)).toBeDisabled())
  })

  it("shows a restart badge and counts restart changes", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    expect(await screen.findByText("Applies after restarting worktree ui")).toBeInTheDocument()
    const port = screen.getByLabelText("HTTPS port")
    await userEvent.clear(port)
    await userEvent.type(port, "9000")
    expect(screen.getByText(/1 needs a restart/)).toBeInTheDocument()
  })

  it("warns when an allowed host is not in the certificate", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    const hosts = await screen.findByLabelText("Allowed hosts")
    await userEvent.type(hosts, "10.0.0.5{enter}")
    expect(screen.getByText(/doesn't cover/)).toHaveTextContent("10.0.0.5")
  })

  it("Discard restores the saved values", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    const editor = await screen.findByLabelText("Editor")
    await userEvent.type(editor, "zed")
    await userEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(editor).toHaveValue("")
    expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument()
  })

  it("asks before closing with unsaved changes", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const onClose = vi.fn()
    renderModal(new QueryClient(), onClose)
    await userEvent.type(await screen.findByLabelText("Editor"), "zed")
    await userEvent.keyboard("{Escape}")
    expect(onClose).not.toHaveBeenCalled()
    const confirm = screen.getByRole("alert")
    await userEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }))
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard("{Escape}")
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Discard and close" }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("marks a tab with unsaved changes", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    renderModal()
    await userEvent.type(await screen.findByLabelText("Editor"), "zed")
    expect(screen.getByRole("tab", { name: /General/ })).toHaveTextContent("●")
    expect(screen.getByRole("tab", { name: /Watcher Auth/ })).not.toHaveTextContent("●")
  })

  it("shows a save error on its tab and keeps the change", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "saveWorktreeSettings").mockRejectedValue(new Error("disk full"))
    renderModal()
    await userEvent.type(await screen.findByLabelText("Editor"), "zed")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText("disk full")).toBeInTheDocument()
    expect(screen.getByLabelText("Editor")).toHaveValue("zed")
  })
})
```

Note the `Escape` behavior. Mantine `Modal` calls `onClose` on Escape. The shell
intercepts it, and calls the real `onClose` only when nothing is dirty or after
"Discard and close". The confirm is an `Alert` with `role="alert"` rendered above the
footer.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/components/SettingsModal.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement `parts.tsx`**

```tsx
import type { ReactNode } from "react"
import { Badge, Code, Group, Stack, Text, Title } from "@mantine/core"

/** "These settings are persisted to <path>": the first line of every config tab. */
export function PersistedTo({ path }: { path: string }) {
  return (
    <Text size="xs" c="dimmed" bg="var(--mantine-color-default-hover)" px="sm" py={6} style={{ borderRadius: 4 }}>
      These settings are persisted to <Code>{path}</Code>
    </Text>
  )
}

/** A group of fields under an uppercase heading, optionally badged. */
export function SettingsSection({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Title order={6} tt="uppercase" c="dimmed" fz="xs" lts="0.06em">{title}</Title>
        {badge && <Badge size="xs" color="orange" variant="light" tt="none">{badge}</Badge>}
      </Group>
      {children}
    </Stack>
  )
}

/** The YAML key a field writes, in dim monospace, for field descriptions. */
export function KeyPath({ path }: { path: string }) {
  return <Text span ff="monospace" fz="xs" c="dimmed" opacity={0.7}>{path}</Text>
}
```

- [ ] **Step 4: Implement `GeneralPanel.tsx`**

```tsx
import { Alert, Anchor, Code, NumberInput, Stack, TagsInput, Text, TextInput } from "@mantine/core"
import type { Settings, WorktreeSettings } from "../../api/types"
import { Toggle } from "../Toggle"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"

export const RESTART_BADGE = "Applies after restarting worktree ui"

interface Props {
  settings: Settings
  draft: WorktreeSettings
  update: (fn: (d: WorktreeSettings) => WorktreeSettings) => void
  error?: string
  /** Called after a secret (the UI password) was replaced, to refetch. */
  onSecretSaved: () => void
  /** Jump to the Watcher Auth tab. */
  onShowWatcherAuth: () => void
}

/** Every key of worktree's config.yaml. */
export function GeneralPanel({ settings, draft, update, error, onShowWatcherAuth }: Props) {
  const env = settings.environment
  const uncovered = env.cert_names
    ? draft.ui.allowed_hosts.filter((h) => !env.cert_names!.includes(h.toLowerCase()))
    : []
  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.worktree} />
      {error && <Alert color="red" title="Couldn't save config.yaml">{error}</Alert>}

      <SettingsSection title="Interface">
        <Toggle
          label="Enable cmux features"
          description="Workspace headers, tab controls, Follow cmux focus, cmux notifications and the 📬 unread title prefix."
          checked={draft.cmux_features_enabled}
          disabled={!env.in_cmux}
          onChange={(e) => { const on = e.currentTarget.checked; update((d) => ({ ...d, cmux_features_enabled: on })) }}
          tooltip={env.in_cmux ? undefined : "The worktree UI server is not running inside cmux, so there are no cmux features to turn on or off."}
        />
        <TextInput
          label="Editor"
          description={<>Command used by <Code>worktree open</Code> to open a worktree. <KeyPath path="editor" /></>}
          placeholder="$EDITOR"
          value={draft.editor}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, editor: v })) }}
          ff="monospace"
        />
      </SettingsSection>

      <SettingsSection title="Worktrees">
        <TextInput
          label="Worktrees base directory"
          description={<>Where new worktrees are created. <KeyPath path="worktrees_base" /></>}
          placeholder="~/.worktrees"
          value={draft.worktrees_base}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, worktrees_base: v })) }}
          ff="monospace"
        />
        {env.worktrees_base_env && (
          <Text size="xs" c="yellow">$WORKTREES_BASE is set in the server's environment and overrides this value.</Text>
        )}
      </SettingsSection>

      <SettingsSection title="Jira">
        <TagsInput
          label="Project keys"
          description={<>Prefixes detected in branch names and PR titles. <KeyPath path="jira.projects" /></>}
          placeholder="Add key…"
          value={draft.jira.projects}
          onChange={(v) => update((d) => ({ ...d, jira: { ...d.jira, projects: v } }))}
        />
        <TagsInput
          label="Alias hosts"
          description={<>Old hostnames whose /browse/KEY links still count as Jira issues. <KeyPath path="jira.alias_hosts" /></>}
          placeholder="Add host…"
          value={draft.jira.alias_hosts}
          onChange={(v) => update((d) => ({ ...d, jira: { ...d.jira, alias_hosts: v } }))}
        />
        <Text size="xs" c="dimmed">
          Jira host, email and token are on the <Anchor component="button" size="xs" onClick={onShowWatcherAuth}>Watcher Auth</Anchor> tab.
        </Text>
      </SettingsSection>

      <SettingsSection title="Login">
        {/* Task 10 replaces this with a SecretField. */}
        <Text size="sm">UI password</Text>
        <Text size="xs" c="dimmed">{settings.secrets.ui_password ? "•••• set" : "Not set"}</Text>
      </SettingsSection>

      <SettingsSection title="Remote access" badge={RESTART_BADGE}>
        <NumberInput
          label="HTTPS port"
          description={<><KeyPath path="ui.https_port" /> · default 8476</>}
          min={1}
          max={65535}
          w={160}
          value={draft.ui.https_port}
          onChange={(v) => update((d) => ({ ...d, ui: { ...d.ui, https_port: typeof v === "number" ? v : Number(v) || 0 } }))}
        />
        <TagsInput
          label="Allowed hosts"
          description={<>Names and IPs other devices use. Also the certificate's names. <KeyPath path="ui.allowed_hosts" /></>}
          placeholder="Add host…"
          value={draft.ui.allowed_hosts}
          onChange={(v) => update((d) => ({ ...d, ui: { ...d.ui, allowed_hosts: v } }))}
        />
        {uncovered.length > 0 && (
          <Alert color="yellow" p="xs">
            The current certificate doesn't cover <b>{uncovered.join(", ")}</b>. Run <Code>worktree setup</Code> to
            reissue it, then reinstall the CA on your phone.
          </Alert>
        )}
        <TextInput
          label="TLS certificate"
          description={<KeyPath path="ui.tls.cert_file" />}
          value={draft.ui.tls.cert_file}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, ui: { ...d.ui, tls: { ...d.ui.tls, cert_file: v } } })) }}
          ff="monospace"
        />
        <TextInput
          label="TLS key"
          description={<KeyPath path="ui.tls.key_file" />}
          value={draft.ui.tls.key_file}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, ui: { ...d.ui, tls: { ...d.ui.tls, key_file: v } } })) }}
          ff="monospace"
        />
      </SettingsSection>
    </Stack>
  )
}
```

The password lives in its own "Login" section, above the badged Remote access section, because it applies immediately (Task 6) and the restart badge must not cover it.

- [ ] **Step 5: Implement the `SettingsModal.tsx` shell**

```tsx
import { useState } from "react"
import { Alert, Box, Button, Group, Loader, Modal, Tabs, Text } from "@mantine/core"
import { useQuery, useQueryClient, type Query } from "@tanstack/react-query"
import { api } from "../api/client"
import { DevicesPanel } from "./DevicesPanel"
import { GeneralPanel } from "./settings/GeneralPanel"
import { useSettingsDraft, type SettingsFile } from "./settings/useSettingsDraft"

const settingsKey = ["settings"] as const

/**
 * Every cmux-backed query (["cmux"], ["cmux-tree", path],
 * ["cmux-browser-tabs"], ["cmux-groups"]) plus the session, whose
 * notify_mode follows the cmux toggle.
 */
const affectedByCmux = (q: Pick<Query, "queryKey">) => {
  const head = q.queryKey[0]
  return typeof head === "string" && (head.startsWith("cmux") || head === "session")
}

const tabFile: Record<string, SettingsFile | undefined> = {
  general: "worktree",
  "watcher-auth": "watcher_auth",
  "watcher-config": "watcher_config",
}

/**
 * The home page's settings. The three config tabs share one draft and one
 * Save/Discard footer; secrets are replaced in place by SecretField and
 * never sit in the draft. Devices manages logins and has no draft.
 */
export function SettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<string | null>("general")
  const [confirmClose, setConfirmClose] = useState(false)
  const settings = useQuery({ queryKey: settingsKey, queryFn: api.settings, enabled: opened })
  const draft = useSettingsDraft(settings.data)

  const refetchAfterSecret = async () => {
    const fresh = await qc.fetchQuery({ queryKey: settingsKey, queryFn: api.settings })
    draft.rebase(fresh)
  }

  const requestClose = () => {
    if (draft.anyDirty) setConfirmClose(true)
    else onClose()
  }

  const save = async () => {
    const wasCmux = draft.drafts && settings.data
      ? draft.drafts.worktree.cmux_features_enabled !== settings.data.worktree.cmux_features_enabled
      : false
    const out = await draft.save()
    if (out.settings) qc.setQueryData(settingsKey, out.settings)
    if (wasCmux && out.saved.includes("worktree")) void qc.invalidateQueries({ predicate: affectedByCmux })
  }

  const label = (name: string, value: string) => {
    const f = tabFile[value]
    return <>{name}{f && draft.dirty[f] ? <Text span c="orange" ml={4}>●</Text> : null}</>
  }

  const body = (() => {
    if (settings.isLoading || (settings.data && !draft.drafts)) return <Loader size="sm" />
    if (settings.error) return <Alert color="red" title="Couldn't load settings">{settings.error.message}</Alert>
    return null
  })()

  return (
    <Modal opened={opened} onClose={requestClose} title="Settings" size="lg">
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="general">{label("General", "general")}</Tabs.Tab>
          <Tabs.Tab value="watcher-auth">{label("Watcher Auth", "watcher-auth")}</Tabs.Tab>
          <Tabs.Tab value="watcher-config">{label("Watcher Config", "watcher-config")}</Tabs.Tab>
          <Tabs.Tab value="devices">Devices</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="general" pt="md">
          {body ?? (settings.data && draft.drafts && (
            <GeneralPanel
              settings={settings.data}
              draft={draft.drafts.worktree}
              update={(fn) => draft.update("worktree", fn)}
              error={draft.errors.worktree}
              onSecretSaved={refetchAfterSecret}
              onShowWatcherAuth={() => setTab("watcher-auth")}
            />
          ))}
        </Tabs.Panel>
        {/* Task 10 adds the watcher-auth and watcher-config panels here. */}
        <Tabs.Panel value="watcher-auth" pt="md">{body}</Tabs.Panel>
        <Tabs.Panel value="watcher-config" pt="md">{body}</Tabs.Panel>
        <Tabs.Panel value="devices" pt="md">
          <DevicesPanel active={opened && tab === "devices"} />
        </Tabs.Panel>
      </Tabs>

      {confirmClose && (
        <Alert role="alert" color="yellow" mt="md" title="Discard unsaved changes?">
          <Group gap="xs" mt="xs">
            <Button size="xs" variant="default" onClick={() => setConfirmClose(false)}>Keep editing</Button>
            <Button size="xs" color="red" onClick={() => { draft.discard(); setConfirmClose(false); onClose() }}>Discard and close</Button>
          </Group>
        </Alert>
      )}

      {tab !== "devices" && (
        <Box mt="md" pt="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)", position: "sticky", bottom: 0, background: "var(--mantine-color-body)" }}>
          <Group justify="space-between">
            <Text size="xs" c={draft.anyDirty ? "orange" : "dimmed"}>
              {draft.anyDirty
                ? `● Unsaved changes${draft.restartCount ? ` · ${draft.restartCount} ${draft.restartCount === 1 ? "needs" : "need"} a restart` : ""}`
                : "No unsaved changes"}
            </Text>
            <Group gap="xs">
              <Button size="xs" variant="subtle" disabled={!draft.anyDirty || draft.saving} onClick={draft.discard}>Discard</Button>
              <Button size="xs" disabled={!draft.anyDirty} loading={draft.saving} onClick={save}>Save</Button>
            </Group>
          </Group>
        </Box>
      )}
    </Modal>
  )
}
```

Also, if the Modal component swallows Escape before `onClose`, confirm the test passes.
Mantine calls `onClose` on Escape when `closeOnEscape` is true (the default), so it should.

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd ui && npx vitest run src/components/SettingsModal.test.tsx src/components/settings && npx tsc --noEmit -p .`
Expected: PASS, with no type errors. Also run the full suite with `npx vitest run`,
because `HomePage.test.tsx` mocks `api.settings` with the old shape. Update its mock to
`baseSettings()` (imported from `../components/settings/testSettings`) if it fails.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/settings/parts.tsx ui/src/components/settings/GeneralPanel.tsx ui/src/components/SettingsModal.tsx ui/src/components/SettingsModal.test.tsx
git commit --signoff -m "feat(ui): settings modal shell with shared Save/Discard and full General tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Also `git add` `HomePage.test.tsx` / `testSettings.ts` if Step 6 changed them.)

---

### Task 10: `SecretField`, Watcher Auth and Watcher Config tabs

**Files:**
- Create: `ui/src/components/settings/SecretField.tsx`
- Test: `ui/src/components/settings/SecretField.test.tsx`
- Create: `ui/src/components/settings/KeyValueTable.tsx`
- Create: `ui/src/components/settings/WatcherAuthPanel.tsx`
- Create: `ui/src/components/settings/WatcherConfigPanel.tsx`
- Modify: `ui/src/components/settings/GeneralPanel.tsx` (password → SecretField)
- Modify: `ui/src/components/SettingsModal.tsx` (mount the panels)
- Modify: `ui/src/components/SettingsModal.test.tsx` (watcher tab tests)

**Interfaces:**
- Consumes: `api.testCredential`, `api.replaceCredential`, `api.replacePassword` and `CredResult` (Task 8); `parts.tsx` (Task 9).
- Produces:

```ts
export type TestState = { status: "idle" } | { status: "testing" } | { status: "done"; result: CredResult; at: number }
export function SecretField(props: {
  label: string
  description: ReactNode
  isSet: boolean
  placeholder?: string            // focused-state placeholder, default "Paste a new token"
  /** Validate-then-write. Resolve with the CredResult; ok:false keeps the field open with the error. */
  onReplace: (value: string) => Promise<CredResult | void>
  /** Absent → no Test button and no chip (the UI password). */
  onTest?: () => void
  test?: TestState
}): JSX.Element
```

- [ ] **Step 1: Write the failing `SecretField` tests**

`ui/src/components/settings/SecretField.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { SecretField } from "./SecretField"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
afterEach(cleanup)

describe("SecretField", () => {
  it("shows set state with no value, and Test", async () => {
    const onTest = vi.fn()
    wrap(<SecretField label="Token" description="d" isSet onReplace={vi.fn()} onTest={onTest} test={{ status: "idle" }} />)
    const input = screen.getByLabelText("Token")
    expect(input).toHaveValue("")
    expect(input).toHaveAttribute("placeholder", expect.stringMatching(/set/))
    await userEvent.click(screen.getByRole("button", { name: "Test" }))
    expect(onTest).toHaveBeenCalledOnce()
  })

  it("disables Test when not set", () => {
    wrap(<SecretField label="Token" description="d" isSet={false} onReplace={vi.fn()} onTest={vi.fn()} test={{ status: "idle" }} />)
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled()
  })

  it("focus offers Replace and Cancel; Replace is disabled until typed", async () => {
    wrap(<SecretField label="Token" description="d" isSet onReplace={vi.fn()} />)
    await userEvent.click(screen.getByLabelText("Token"))
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled()
    await userEvent.type(screen.getByLabelText("Token"), "abc")
    expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByLabelText("Token")).toHaveValue("")
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument()
  })

  it("on success clears the value and shows Saved", async () => {
    const onReplace = vi.fn().mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    wrap(<SecretField label="Token" description="d" isSet onReplace={onReplace} />)
    await userEvent.type(screen.getByLabelText("Token"), "new-secret")
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith("new-secret"))
    expect(await screen.findByText(/Saved/)).toBeInTheDocument()
    expect(screen.getByLabelText("Token")).toHaveValue("")
    expect(screen.queryByDisplayValue("new-secret")).not.toBeInTheDocument()
  })

  it("on refusal keeps the value and explains nothing was saved", async () => {
    const onReplace = vi.fn().mockResolvedValue({ ok: false, kind: "auth", detail: "401 Bad credentials" })
    wrap(<SecretField label="Token" description="d" isSet onReplace={onReplace} />)
    await userEvent.type(screen.getByLabelText("Token"), "bad")
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    expect(await screen.findByText(/401 Bad credentials/)).toHaveTextContent(/Nothing was saved/)
    expect(screen.getByLabelText("Token")).toHaveValue("bad")
  })

  it("renders test chips", () => {
    const { rerender } = wrap(<SecretField label="T" description="d" isSet onReplace={vi.fn()} onTest={vi.fn()} test={{ status: "testing" }} />)
    expect(screen.getByText(/Testing/)).toBeInTheDocument()
    rerender(<MantineProvider><SecretField label="T" description="d" isSet onReplace={vi.fn()} onTest={vi.fn()} test={{ status: "done", at: Date.now(), result: { ok: false, kind: "network", detail: "timeout" } }} /></MantineProvider>)
    expect(screen.getByText(/Couldn't reach/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ui && npx vitest run src/components/settings/SecretField.test.tsx`
Expected: FAIL (the module is not found).

- [ ] **Step 3: Implement `SecretField.tsx`**

```tsx
import { useState, type ReactNode } from "react"
import { Badge, Button, Group, PasswordInput, Stack, Text } from "@mantine/core"
import type { CredResult } from "../../api/types"

export type TestState = { status: "idle" } | { status: "testing" } | { status: "done"; result: CredResult; at: number }

function TestChip({ test }: { test?: TestState }) {
  if (!test || test.status === "idle") return null
  if (test.status === "testing") return <Badge size="xs" variant="light" color="blue" tt="none">◌ Testing…</Badge>
  const r = test.result
  if (r.ok) return <Badge size="xs" variant="light" color="green" tt="none">✓ Valid</Badge>
  if (r.kind === "auth") return <Badge size="xs" variant="light" color="red" tt="none" title={r.detail}>✕ Rejected</Badge>
  if (r.kind === "missing") return <Badge size="xs" variant="light" color="gray" tt="none">Not configured</Badge>
  return <Badge size="xs" variant="light" color="yellow" tt="none" title={r.detail}>⚠ Couldn't reach</Badge>
}

/**
 * A write-only secret. The stored value never reaches the browser: the
 * field shows only whether one is set. Focusing it offers Replace, which
 * hands the typed value to onReplace (validate-then-write on the server)
 * and forgets it on success. Never part of the modal's Save/Discard draft.
 */
export function SecretField({ label, description, isSet, placeholder = "Paste a new token", onReplace, onTest, test }: {
  label: string
  description: ReactNode
  isSet: boolean
  placeholder?: string
  onReplace: (value: string) => Promise<CredResult | void>
  onTest?: () => void
  test?: TestState
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const cancel = () => {
    setEditing(false)
    setValue("")
    setError(null)
  }

  const replace = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await onReplace(value)
      if (r && !r.ok) {
        setError(`${r.detail || r.kind}. Nothing was saved, and the old value is still in place.`)
        return
      }
      setValue("")
      setEditing(false)
      setSaved(true)
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)}. Nothing was saved.`)
    } finally {
      setBusy(false)
    }
  }

  const idlePlaceholder = isSet ? "•••••••••••••••• set" : "Not set — click to add"
  return (
    <Stack gap={4}>
      <PasswordInput
        label={<Group gap="xs" component="span">{label}{onTest && <TestChip test={test} />}{saved && !editing && <Badge size="xs" color="green" variant="light" tt="none">✓ Saved</Badge>}</Group>}
        description={description}
        placeholder={editing ? placeholder : idlePlaceholder}
        value={value}
        visibilityToggleButtonProps={{ style: { display: editing ? undefined : "none" } }}
        onFocus={() => { setEditing(true); setSaved(false) }}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value) void replace()
          if (e.key === "Escape") { e.stopPropagation(); cancel() }
        }}
        error={error}
        aria-label={label}
        autoComplete="off"
        ff="monospace"
        rightSectionWidth={editing ? 0 : undefined}
      />
      <Group gap="xs">
        {editing ? (
          <>
            <Button size="xs" disabled={!value} loading={busy} onClick={replace}>Replace</Button>
            <Button size="xs" variant="subtle" onClick={cancel}>Cancel</Button>
          </>
        ) : (
          onTest && <Button size="xs" variant="default" disabled={!isSet || test?.status === "testing"} onClick={onTest}>Test</Button>
        )}
      </Group>
      {test?.status === "done" && !test.result.ok && test.result.detail && !editing && (
        <Text size="xs" c="dimmed">{test.result.detail}</Text>
      )}
    </Stack>
  )
}
```

The input carries `aria-label={label}` because the visible label also contains the chip text, and tests and screen readers should find the field by its plain name.

`Escape` inside the field cancels the edit, and `stopPropagation` keeps the modal from
treating it as a close request.

- [ ] **Step 4: Run the `SecretField` tests**

Run: `cd ui && npx vitest run src/components/settings/SecretField.test.tsx`
Expected: PASS

- [ ] **Step 5: Implement `KeyValueTable.tsx`**

```tsx
import { ActionIcon, Button, Group, Stack, TextInput } from "@mantine/core"
import { IconX } from "@tabler/icons-react"

/**
 * Edits a string map as rows. Rows are kept as an ordered array while
 * editing so a half-typed key doesn't reorder or merge with another; the
 * map passed to onChange drops rows whose key is blank.
 */
export function KeyValueTable({ rows, onChange, keyPlaceholder, valuePlaceholder }: {
  rows: [string, string][]
  onChange: (rows: [string, string][]) => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  const set = (i: number, at: 0 | 1, v: string) =>
    onChange(rows.map((r, j) => (j === i ? (at === 0 ? [v, r[1]] : [r[0], v]) : r)))
  return (
    <Stack gap={6}>
      {rows.map(([k, v], i) => (
        <Group key={i} gap={6} wrap="nowrap">
          <TextInput aria-label={`Field ${i + 1} name`} placeholder={keyPlaceholder} value={k} onChange={(e) => set(i, 0, e.currentTarget.value)} ff="monospace" size="xs" w="40%" />
          <TextInput aria-label={`Field ${i + 1} ID`} placeholder={valuePlaceholder} value={v} onChange={(e) => set(i, 1, e.currentTarget.value)} ff="monospace" size="xs" style={{ flex: 1 }} />
          <ActionIcon variant="subtle" color="gray" aria-label={`Remove field ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <IconX size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Button size="xs" variant="subtle" w="fit-content" onClick={() => onChange([...rows, ["", ""]])}>+ Add field</Button>
    </Stack>
  )
}
```

(Check that `@tabler/icons-react` is a dependency. Commit `ca9977c` uses Tabler icons,
so it should be. Otherwise use a plain `✕`.)

**Rows vs map:** the draft stores `custom_fields` as a map, but editing needs ordered
rows. Duplicate or blank keys would also collapse a map mid-typing. So
`WatcherConfigPanel` keeps local `rows` state, initialised from the draft map, and on
each change writes `Object.fromEntries(rows.filter(([k]) => k.trim()))` into the
draft. Blank rows are local only.

- [ ] **Step 6: Implement `WatcherConfigPanel.tsx`**

Custom-field rows are local state. The modal passes `key={resetToken}`, which it increments on Discard and after Save, so the panel remounts and re-reads the draft. No effect, and no lint suppression, is needed.

```tsx
import { useState } from "react"
import { Alert, Input, Stack, TagsInput } from "@mantine/core"
import type { Settings, WatcherConfigSettings } from "../../api/types"
import { KeyValueTable } from "./KeyValueTable"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"

/**
 * Every key of the watcher library's config.yaml. Custom fields are edited
 * as local rows (see KeyValueTable); the modal remounts this panel (via
 * key) on Discard and Save so the rows re-read the draft.
 */
export function WatcherConfigPanel({ settings, draft, update, error }: {
  settings: Settings
  draft: WatcherConfigSettings
  update: (fn: (d: WatcherConfigSettings) => WatcherConfigSettings) => void
  error?: string
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(draft.jira.custom_fields))
  const setFields = (next: [string, string][]) => {
    setRows(next)
    const map = Object.fromEntries(next.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v.trim()]))
    update((d) => ({ jira: { ...d.jira, custom_fields: map } }))
  }
  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.watcher_config} />
      {error && <Alert color="red" title="Couldn't save watcher config.yaml">{error}</Alert>}
      <SettingsSection title="Jira">
        <TagsInput
          label="Bot usernames"
          description={<>Comment and changelog authors to treat as bots. <KeyPath path="jira.bot_usernames" /></>}
          placeholder="Add username…"
          value={draft.jira.bot_usernames}
          onChange={(v) => update((d) => ({ jira: { ...d.jira, bot_usernames: v } }))}
        />
        <Input.Wrapper
          label="Custom fields"
          description={<>Friendly name → Jira field ID. The poller fetches and caches these. <KeyPath path="jira.custom_fields" /></>}
        >
          <KeyValueTable rows={rows} onChange={setFields} keyPlaceholder="epic_key" valuePlaceholder="customfield_10014" />
        </Input.Wrapper>
      </SettingsSection>
    </Stack>
  )
}
```

In `SettingsModal.tsx`, add `const [resetToken, setResetToken] = useState(0)`. Increment
it after `draft.discard()`, in both the Discard button handler and "Discard and close",
and after `save()` resolves. Pass `key={resetToken}` to `WatcherConfigPanel`.

- [ ] **Step 7: Implement `WatcherAuthPanel.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, Code, Stack, TextInput } from "@mantine/core"
import { api } from "../../api/client"
import type { CredService, Settings, WatcherAuthSettings } from "../../api/types"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"
import { SecretField, type TestState } from "./SecretField"

/** Every key of the watcher library's auth.yaml, except consumers and the legacy jira_custom_fields. */
export function WatcherAuthPanel({ settings, draft, update, error, active, onSecretSaved }: {
  settings: Settings
  draft: WatcherAuthSettings
  update: (fn: (d: WatcherAuthSettings) => WatcherAuthSettings) => void
  error?: string
  /** The tab is showing: run each configured service's test once. */
  active: boolean
  onSecretSaved: () => void
}) {
  const sec = settings.secrets
  const [tests, setTests] = useState<Record<CredService, TestState>>({
    github: { status: "idle" }, jira: { status: "idle" }, slack: { status: "idle" },
  })

  // Jira is tested with the host/email in the form, saved or not.
  const runTest = useCallback(async (svc: CredService) => {
    setTests((t) => ({ ...t, [svc]: { status: "testing" } }))
    try {
      const override = svc === "jira" ? { host: draft.jira.host, email: draft.jira.email } : undefined
      const result = await api.testCredential(svc, override)
      setTests((t) => ({ ...t, [svc]: { status: "done", result, at: Date.now() } }))
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      setTests((t) => ({ ...t, [svc]: { status: "done", at: Date.now(), result: { ok: false, kind: "network", detail } } }))
    }
  }, [draft.jira.host, draft.jira.email])

  // Test every configured service the first time the tab is shown. The ref
  // makes it one-shot even though runTest changes as the form is edited.
  const tested = useRef(false)
  useEffect(() => {
    if (!active || tested.current) return
    tested.current = true
    if (sec.github_token) void runTest("github")
    if (sec.jira_token) void runTest("jira")
    if (sec.slack_token && sec.slack_cookie) void runTest("slack")
  }, [active, runTest, sec.github_token, sec.jira_token, sec.slack_token, sec.slack_cookie])

  /** Replace = validate-then-write; on success refetch so *_set flags update, and show the result as the chip. */
  const replacer = (svc: CredService, body: (v: string) => Parameters<typeof api.replaceCredential>[1]) =>
    async (v: string) => {
      const r = await api.replaceCredential(svc, body(v))
      if (r.ok) {
        setTests((t) => ({ ...t, [svc]: { status: "done", result: r, at: Date.now() } }))
        onSecretSaved()
      }
      return r
    }

  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.watcher_auth} />
      {error && <Alert color="red" title="Couldn't save auth.yaml">{error}</Alert>}

      <SettingsSection title="GitHub">
        <SecretField
          label="Token"
          description={<>Personal access token with repo read scopes. <KeyPath path="services.github.token" /></>}
          isSet={sec.github_token}
          onReplace={replacer("github", (token) => ({ token }))}
          onTest={() => void runTest("github")}
          test={tests.github}
        />
      </SettingsSection>

      <SettingsSection title="Jira">
        <TextInput
          label="Host"
          description={<KeyPath path="services.jira.host" />}
          placeholder="https://yourorg.atlassian.net"
          value={draft.jira.host}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, jira: { ...d.jira, host: v } })) }}
          ff="monospace"
        />
        <TextInput
          label="Email"
          description={<KeyPath path="services.jira.email" />}
          value={draft.jira.email}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, jira: { ...d.jira, email: v } })) }}
          ff="monospace"
        />
        <SecretField
          label="API token"
          description={<>From id.atlassian.com → Security → API tokens. Tested with the host and email above. <KeyPath path="services.jira.token" /></>}
          isSet={sec.jira_token}
          onReplace={replacer("jira", (token) => ({ token, host: draft.jira.host, email: draft.jira.email }))}
          onTest={() => void runTest("jira")}
          test={tests.jira}
        />
      </SettingsSection>

      <SettingsSection title="Slack">
        <Alert color="blue" variant="light" p="xs">
          To automatically capture the Slack token and cookie from a browser session, run <Code>worktree setup slack</Code>.
        </Alert>
        <SecretField
          label="Session token"
          description={<>The xoxc-… token from a logged-in browser. <KeyPath path="services.slack.token" /></>}
          isSet={sec.slack_token}
          onReplace={replacer("slack", (token) => ({ token }))}
          onTest={() => void runTest("slack")}
          test={tests.slack}
        />
        <SecretField
          label="Session cookie"
          description={<>The browser's d= cookie (xoxd-…). Tested together with the token. <KeyPath path="services.slack.cookie" /></>}
          isSet={sec.slack_cookie}
          placeholder="Paste a new cookie"
          onReplace={replacer("slack", (cookie) => ({ cookie }))}
          onTest={() => void runTest("slack")}
          test={tests.slack}
        />
        <TextInput
          label="Workspace domain"
          description={<>Used to build permalinks. Filled in automatically after a successful Slack replace. <KeyPath path="services.slack.workspace_domain" /></>}
          value={draft.slack.workspace_domain}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, slack: { workspace_domain: v } })) }}
          ff="monospace"
        />
      </SettingsSection>
    </Stack>
  )
}
```

After a Jira replace, the server stores the form's host and email, so the draft's
host/email now equal the server's. `onSecretSaved` → `rebase` moves the baseline, and
the Watcher Auth dirty dot clears on its own. The same holds for the Slack workspace
domain.

- [ ] **Step 8: Wire the UI password and the panels**

In `GeneralPanel.tsx`, replace the temporary password text with:

```tsx
      <SettingsSection title="Login">
        <SecretField
          label="UI password"
          description={<>Required to log in from any device. Takes effect immediately; existing logins stay signed in. <KeyPath path="ui.password" /></>}
          isSet={settings.secrets.ui_password}
          placeholder="Type a new password"
          onReplace={async (pw) => { await api.replacePassword(pw); onSecretSaved() }}
        />
      </SettingsSection>
```

(Import `api` and `SecretField`, and destructure `onSecretSaved` from the props.)

In `SettingsModal.tsx`, replace the two placeholder panels:

```tsx
        <Tabs.Panel value="watcher-auth" pt="md">
          {body ?? (settings.data && draft.drafts && (
            <WatcherAuthPanel
              settings={settings.data}
              draft={draft.drafts.watcher_auth}
              update={(fn) => draft.update("watcher_auth", fn)}
              error={draft.errors.watcher_auth}
              active={opened && tab === "watcher-auth"}
              onSecretSaved={refetchAfterSecret}
            />
          ))}
        </Tabs.Panel>
        <Tabs.Panel value="watcher-config" pt="md">
          {body ?? (settings.data && draft.drafts && (
            <WatcherConfigPanel
              key={resetToken}
              settings={settings.data}
              draft={draft.drafts.watcher_config}
              update={(fn) => draft.update("watcher_config", fn)}
              error={draft.errors.watcher_config}
            />
          ))}
        </Tabs.Panel>
```

- [ ] **Step 9: Add the watcher tab tests to `SettingsModal.test.tsx`**

```tsx
  it("Watcher Auth: tests configured services on open and never renders secrets", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const test = vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    renderModal()
    await userEvent.click(screen.getByRole("tab", { name: /Watcher Auth/ }))
    await waitFor(() => expect(test).toHaveBeenCalledTimes(3))
    expect(test).toHaveBeenCalledWith("jira", { host: "https://x.atlassian.net", email: "me@x" })
    expect(screen.getByText(/run/)).toHaveTextContent("worktree setup slack")
    expect(screen.queryByText(/agent-handler/i)).not.toBeInTheDocument()
  })

  it("Watcher Auth: a Jira replace sends the form's host and email", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    vi.spyOn(api, "testCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    const replace = vi.spyOn(api, "replaceCredential").mockResolvedValue({ ok: true, kind: "ok", detail: "" })
    renderModal()
    await userEvent.click(screen.getByRole("tab", { name: /Watcher Auth/ }))
    const email = await screen.findByLabelText("Email")
    await userEvent.clear(email)
    await userEvent.type(email, "new@x")
    await userEvent.type(screen.getByLabelText("API token"), "tok")
    await userEvent.click(screen.getByRole("button", { name: "Replace" }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith("jira", { token: "tok", host: "https://x.atlassian.net", email: "new@x" }))
  })

  it("Watcher Config: edits custom fields and saves the map", async () => {
    vi.spyOn(api, "settings").mockResolvedValue(baseSettings())
    const save = vi.spyOn(api, "saveWatcherConfigSettings").mockResolvedValue(baseSettings())
    renderModal()
    await userEvent.click(screen.getByRole("tab", { name: /Watcher Config/ }))
    await userEvent.click(await screen.findByRole("button", { name: "Remove field 1" }))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0][0].jira.custom_fields).toEqual({ b: "customfield_2" })
  })
```

- [ ] **Step 10: Run the full frontend suite and typecheck**

Run: `cd ui && npx vitest run && npx tsc --noEmit -p . && npm run lint --if-present`
Expected: all PASS, with no lint errors and no `eslint-disable` added.
Run `grep -rn "eslint-disable" src/components/settings src/components/SettingsModal.tsx`
and expect no output.

- [ ] **Step 11: Commit**

```bash
git add ui/src/components/settings/SecretField.tsx ui/src/components/settings/SecretField.test.tsx ui/src/components/settings/KeyValueTable.tsx ui/src/components/settings/WatcherAuthPanel.tsx ui/src/components/settings/WatcherConfigPanel.tsx ui/src/components/settings/GeneralPanel.tsx ui/src/components/SettingsModal.tsx ui/src/components/SettingsModal.test.tsx
git commit --signoff -m "feat(ui): Watcher Auth and Watcher Config settings tabs with write-only secrets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, agent guidance, build, and manual verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/web-ui-architecture.md` (replace the "Settings toggle" section, and update the line-58 mention)
- Modify: `docs/features.md` or equivalent, if it lists Settings (`grep -n -i "settings" docs/*.md`)

**Interfaces:**
- Consumes: `settingsKeyPaths` and `settingsKeyExclusions` (Task 7).

- [ ] **Step 1: Add the CLAUDE.md rule**

Under `## Project Structure`, after the `webui` bullet's paragraph, add this section:

```markdown
## Config files ↔ Settings modal — keep them in sync

The web UI's Settings modal edits every user-facing key of three files:
worktree's `config.yaml` (`internal/config.Config`, General tab), and the
watcher library's `auth.yaml` (`wconfig.Config`, Watcher Auth tab) and
`config.yaml` (`wconfig.ConfigFile`, Watcher Config tab).

**Any change to a key in any of these — added, renamed, removed, or a
watcher re-pin that changes them — must update the modal in the same
change:**

1. `internal/config/editable.go` (`Editable`, `ReadEditable`, `WriteEditable`)
   for worktree keys; `internal/webui/settings_watcher.go` for watcher keys.
2. The DTO and PUT handler (`internal/webui/settings.go` /
   `settings_watcher.go`; secrets go through `settings_creds.go` and are
   never returned).
3. `settingsKeyPaths` in `internal/webui/settings_keys.go` — or
   `settingsKeyExclusions` with a reason, if the key must never be shown.
4. `ui/src/api/types.ts`, and the tab's panel in `ui/src/components/settings/`.
5. Tests on both sides.

`settings_keys_test.go` fails until steps 1–3 are done; it cannot check the
frontend, so step 4 is on you. See `docs/web-ui-architecture.md`
"Settings modal".
```

Also, in the `webui` bullet, replace any mention of the cmux "Settings toggle" with
"Settings modal (config editing; see "Config files ↔ Settings modal")".

- [ ] **Step 2: Rewrite the architecture doc section**

Replace `### Settings toggle: one server-side gate (settings.go)` and its body with a
`### Settings modal (settings*.go, ui/src/components/settings/)` section covering:

- **Routes table:** the seven routes and what each one does.
- **Save model:** one draft per file, modal-wide Save/Discard, and sequential per-file PUTs with a partial-failure behavior. The cmux toggle is part of the draft.
- **Secrets:** write-only. `*_set` booleans only. Validate-then-write, refusing on any error. Jira replace stores host, email and token together. Slack half-replace uses the stored other half. The password swap is live.
- **Writing:** worktree config via the node tree (comments and unknown keys kept, no rewrite when unchanged). auth.yaml via the library's Load/Save (comments not preserved, as with setup). watcher config.yaml via `SaveConfig`.
- **Live vs restart:** cmux gate, alias hosts (`jira.SetAliasHosts`) and password are live. Projects, worktrees_base and watcher keys are read per request or poll. `https_port`, `allowed_hosts` and TLS need a restart (badge).
- **The cmux gate paragraph:** keep it verbatim from the old section ("Every cmux feature is gated in Go…"). It still applies. Only the trigger changed, from `PUT /api/settings` to the worktree save.
- **The guard test**, and the exclusions with their reasons.

Update line 58's mention ("Settings modal (`DevicesPanel`) lists and revokes sessions.")
if it describes the modal as only sessions.

- [ ] **Step 3: Full verification**

Run: `make test && make build`
Expected: Go tests PASS. The UI builds and the binary builds.

Run: `cd ui && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS

- [ ] **Step 4: Install and exercise it live**

Run: `NONINTERACTIVE=1 make install`
(worktree ui restarts itself within ~5s, so there's no need to ask Mike to restart it.)

Then use the `run` skill, or Playwright per `~/.agents/context/playwright.md`, against
`http://127.0.0.1:8475`:

1. Open Settings. All four tabs render, and every "persisted to" path is correct.
2. General: type in Editor, Discard, and the value is restored. Toggle cmux: nothing is saved until Save. Save, and confirm `~/.config/worktree/config.yaml` still has its existing content and gained only the change. **Revert the change afterwards** with Discard or another save, so Mike's config is left as it was.
3. Watcher Auth: the chips for all three services show ✓ Valid (Mike's real creds). Clicking Test re-runs the test. Do **not** replace a real credential. To exercise refusal, paste `bad` into the GitHub token and press Replace. Expect "Nothing was saved", and confirm that `~/.config/watcher/auth.yaml` is byte-identical to before (`shasum` before and after).
4. Watcher Config: the tab renders the current bot usernames and custom fields. Make no save unless reverting.
5. `worktree setup slack --help` shows `--force`. Do not run the capture flow.

Take a screenshot of each tab and show them to Mike.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/web-ui-architecture.md
git commit --signoff -m "docs: settings modal architecture and config↔modal sync rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Also add `docs/features.md` if Step 2 changed it.)

- [ ] **Step 6: Report**

Emit a handler status, and tell Mike the branch is ready. Merging to `main` and
pushing are not covered by plan approval, so ask.
