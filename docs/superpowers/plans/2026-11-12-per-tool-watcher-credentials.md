# Per-tool Watcher Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `~/.config/watcher` from all code. Each tool keeps its own
library-format credentials file (`watcher-auth.yaml`) and puts watcher
preferences in its own `config.yaml`.

**Architecture:** The watcher library drops every default path, the consumer
registry, and the behavior-file type. It keeps the credential types and
`Load(path)`/`Save(path)`. worktree and agent-handler each derive a
`watcher-auth.yaml` path next to their own config. Each one embeds the
library's `GitHubBehavior`/`JiraBehavior` types in its own config struct.
Each repo's existing tests prove the switch; no test asserts that removed
code is absent.

**Tech Stack:** Go, gopkg.in/yaml.v3, cobra. worktree has a React/Mantine UI,
but its DTOs are unchanged.

**Spec:** `docs/superpowers/specs/2026-11-12-per-tool-watcher-credentials-design.md` (on worktree `main`)

## Where work happens

| Repo | Location | Branch |
|---|---|---|
| watcher | `~/git/watcher` (main checkout) | `per-tool-creds` |
| worktree | `~/.worktrees/worktree/per-tool-watcher-creds` (already created) | `per-tool-watcher-creds` |
| agent-handler | `~/git/agent-handler` (main checkout) | `per-tool-watcher-creds` |

Create the watcher and handler branches from their current `main` before you
touch them.

## Global Constraints

- No code, test, comment, message or current doc may mention or read
  `~/.config/watcher`, `WATCHER_HOME`, `DefaultPath`/`ConfigDefaultPath` (the
  watcher ones), consumers, or `jira_custom_fields`. There is no fallback and
  no migration from the old files. Leave historical `docs/superpowers/plans/`
  files and `.superpowers/` review notes alone.
- Don't add tests asserting that removed things are gone. Delete their tests.
- Credentials file names:
  - worktree: `<dir of worktree config.yaml>/watcher-auth.yaml`, i.e.
    `$XDG_CONFIG_HOME/worktree/watcher-auth.yaml` or
    `~/.config/worktree/watcher-auth.yaml`
  - handler: `<dir of handler config.yaml>/watcher-auth.yaml`, i.e.
    `$HANDLER_HOME/watcher-auth.yaml` or `~/.agent-handler/watcher-auth.yaml`
- Credentials files are written 0600 through the library's `(*Config).Save`.
  A group- or world-readable file is refused by `Load`.
- Preference YAML keys keep their current names: `github.bot_usernames`,
  `jira.bot_usernames`, `jira.custom_fields`.
- Commits use `--signoff` and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never use `git add -A`.
- **Checkpoints. Stop and ask Mike every time**, before:
  - merging to any `main`
  - pushing a branch or tag
  - running anything against the real `~/.agent-handler/data/handler.db`
  - `make install`

## Review Focus

1. **Fresh install, no `watcher-auth.yaml`.** Every reader treats each
   service as "not configured": no error, no crash. Setup prompts for each
   enabled service. (Task 3 and Task 8 tests.)
2. **`watcher-auth.yaml` that is 0644.** The error names the new path and the
   `chmod 600` fix, not the old directory. (Task 4 test.)
3. **GitHub bot list cleared in Settings.** The next `worktree setup` does not
   reseed it. The cleared list persists as `github: {bot_usernames: []}`.
   (Task 2 and Task 5 tests.)
4. **Hand-edited handler `config.yaml`** with comments, unknown keys, and the
   old `services:` block. Seeding Jira custom fields keeps all of it, byte for
   byte outside `jira.custom_fields`. (Task 8 test.)
5. **`XDG_CONFIG_HOME` set.** worktree's `watcher-auth.yaml` lands beside its
   `config.yaml` under that directory. (Task 2 test.)

---

## Part 1: watcher library

### Task 1: Drop shared location, registry and behavior file from `config`

**Files:**
- Modify: `~/git/watcher/config/config.go`
- Modify: `~/git/watcher/config/config_test.go`
- Modify: `~/git/watcher/README.md` (the config sections, around lines 115–300)
- Check: `~/git/watcher/credsetup/*.go`, `~/git/watcher/jira/*.go`, `~/git/watcher/testutil`

**Interfaces:**
- Produces, kept unchanged:
  - `type Config struct { Services Services \`yaml:"services"\` }`
  - `Services`, `GitHubConfig`, `JiraConfig`, `SlackConfig`
  - `Load(path string) (*Config, error)` (missing file → `&Config{}`; refuses
    `perm&0o077 != 0`)
  - `(*Config).Save(path string) error` (0600)
  - `(*Config).GitHub() (GitHubCreds, error)`, `Jira() (JiraCreds, error)`,
    `Slack() (SlackCreds, error)`
  - `GitHubBehavior{BotUsernames []string}`,
    `JiraBehavior{BotUsernames []string; CustomFields map[string]string}`
    (same yaml tags)
- Removed:
  - `DefaultPath`, `ConfigDefaultPath`
  - `Config.JiraCustomFields`, `Config.ConsumerRegistry`, `Consumer`,
    `RegisterConsumer`, `UnregisterConsumer`, `Consumers`
  - `JiraCreds.CustomFields`
  - `ConfigFile`, `LoadConfig`, `SaveConfig`, and the `ConfigFile` accessor
    methods

- [ ] **Step 1:** `git -C ~/git/watcher switch -c per-tool-creds`
- [ ] **Step 2: Remove the items listed above.** Rewrite the package doc
  comment so it says the package defines the credentials file *format* plus
  behavior types for consumers to embed, and that the library never chooses a
  file location.
- [ ] **Step 3: Delete the tests of removed items.** Covers `TestDefaultPath*`,
  `TestConfigDefaultPath*`, `TestLoadConfig*`, `TestJiraCustomFieldsNilBlock`,
  `TestRegisterConsumer*`, and anything else on removed items. Keep the
  `Load`/`Save`/permission/accessor tests.
- [ ] **Step 4:** `cd ~/git/watcher && go build ./... && go vet ./...`.
  Expected: clean. Fix any library-internal users, e.g. code reading
  `JiraCreds.CustomFields`.
- [ ] **Step 5: Update the README.** It should describe a credentials file
  whose path the consumer always passes, and behavior types the consumer
  embeds in its own config. Remove the example `jira_custom_fields:` /
  `consumers:` YAML and every `WATCHER_HOME` mention.
- [ ] **Step 6:** `go test ./...`. Expected: all `ok`.
  `grep -rn 'WATCHER_HOME\|config/watcher\|ConsumerRegistry\|ConfigDefaultPath' --include='*.go' --include='*.md' . | grep -v '^./.superpowers\|^./docs/superpowers'`
  Expected: no output.
- [ ] **Step 7: Commit:** `feat!: consumers own credential file locations; drop shared defaults, consumer registry and ConfigFile`

### Task 2 (checkpoint): Release v0.27.0

- [ ] **Step 1: Ask Mike** to approve merging `per-tool-creds` into watcher
  `main`, tagging `v0.27.0`, and pushing both.
- [ ] **Step 2: After approval:**
  1. `git switch main && git merge --ff-only per-tool-creds`
  2. `git tag v0.27.0`
  3. `git push origin main && git push origin v0.27.0`

## Part 2: worktree (all paths relative to `~/.worktrees/worktree/per-tool-watcher-creds`)

Tasks 3–5 compile against the currently pinned v0.26.0. They only stop
*using* the APIs that v0.27.0 removes. Task 6 re-pins.

### Task 3: worktree config gains the auth path and watcher preferences

**Files:**
- Modify: `internal/config/config.go` (`Config`, `JiraConfig`, a new `WatcherAuthPath`)
- Modify: `internal/config/editable.go` (`Editable`, `editableFromDoc`, `WriteEditable`)
- Test: `internal/config/config_test.go`, `internal/config/editable_test.go`

**Interfaces:**
- Produces:
  - `func WatcherAuthPath() string`: `filepath.Join(filepath.Dir(configPath()), "watcher-auth.yaml")`
  - `Config.GitHub *wconfig.GitHubBehavior \`yaml:"github,omitempty"\``
  - `JiraConfig` embeds `wconfig.JiraBehavior \`yaml:",inline"\`` beside
    `Projects` and `AliasHosts`
  - `Editable` gains:
    - `GitHubBotUsernames []string`
    - `HasGitHubBlock bool` (read-only; true when the `github` key exists)
    - `JiraBotUsernames []string`
    - `JiraCustomFields map[string]string`

- [ ] **Step 1: Write the failing tests:**
  - `TestWatcherAuthPathFollowsXDG`: with `XDG_CONFIG_HOME=<tmp>`, it is `<tmp>/worktree/watcher-auth.yaml`.
  - `TestEditableReadsWatcherPrefs`: from a file containing
    `github: {bot_usernames: ["*ci-bot*"]}` and
    `jira: {projects: [A], bot_usernames: [Automation for Jira], custom_fields: {epic_key: customfield_10014}}`,
    every field comes back, and `HasGitHubBlock` is true.
  - `TestWriteEditableWatcherPrefsKeepsComments`: a file with a comment and an
    unknown key keeps both after writing new `JiraCustomFields`.
  - `TestWriteEditableClearedGitHubBotsKeepsBlock`: writing an empty
    `GitHubBotUsernames` to a file that has the block leaves
    `github: {bot_usernames: []}`. Reading it back gives
    `HasGitHubBlock == true`.
  - `TestWriteEditableEmptyGitHubBotsNoBlock`: writing empty to a file
    without the block leaves no `github` key.
- [ ] **Step 2:** `go test ./internal/config/`. Expected: FAIL (undefined fields).
- [ ] **Step 3: Implement.**
  - Custom fields become a mapping node with keys sorted, so writes are stable.
  - An empty map deletes `jira.custom_fields`.
  - Jira bot list: same `list` helper as the others.
  - GitHub bot list: an empty list deletes the key only when
    `!cur.HasGitHubBlock`. Otherwise it writes an empty flow sequence.
- [ ] **Step 4:** `go test ./internal/config/`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(config): watcher-auth.yaml path and watcher preferences in config.yaml`

### Task 4: Runtime readers use worktree's own files

**Files:**
- Modify, in `internal/webui/`:
  - `settings.go`: `watcherAuthPath()` defaults to `config.WatcherAuthPath()`;
    delete `watcherConfigPath()`
  - `server.go`: drop the `WatcherConfigPath` field
  - `poller.go`
  - `selfid.go`
  - `jira_proxy.go`
  - `linked_api.go`
  - `bot_authors.go`
  - `settings_watcher.go`
  - `settings_keys.go`
  - `main_test.go`
  - `github_guard_test.go`
  - every test that sets `WATCHER_HOME`
- Modify, in `internal/jira/`:
  - `client.go`: `HostFromWatcherConfig` becomes `ConfiguredHost`;
    `ConfiguredCustomFields` takes no argument; delete `EffectiveCustomFields`
  - `jiratest/jiratest.go`
  - `client_test.go`
- Modify: `internal/slackcreds/slackcreds.go`
- Modify: `internal/worktreenew/prfetch.go`, `worktreenew_test.go`
- Modify: `cmd/watcher.go`, `cmd/info_test.go`, `cmd/resources_test.go`,
  `cmd/pr_threads_test.go`, `cmd/read_db_test.go`
- Test: `internal/webui/settings_keys_test.go`, `internal/webui/settings_watcher_test.go`

**Interfaces:**
- Consumes: `config.WatcherAuthPath()`, and `config.ReadEditable(path)` for
  `GitHubBotUsernames` / `JiraBotUsernames` / `JiraCustomFields` (Task 3).
- Produces:
  - `jira.ConfiguredHost() string`, reading `config.WatcherAuthPath()`
  - `jira.ConfiguredCustomFields() map[string]string`, reading
    `config.ReadEditable(config.ConfigPath())` (a missing or unreadable file
    gives an empty map)
  - `jira.ConfiguredIssueURL` keeps its signature
  - `PUT /api/settings/watcher-config` keeps its JSON DTO
    (`watcherConfigSettings`), but now writes through `config.WriteEditable`
    on `s.configPath()`

- [ ] **Step 1: Update tests first.**
  - Replace every `t.Setenv("WATCHER_HOME", d)` with
    `t.Setenv("XDG_CONFIG_HOME", d)`. Fixtures write
    `<d>/worktree/watcher-auth.yaml`. In webui, prefer `srv.WatcherAuthPath`
    where the test builds a `Server`.
  - `jiratest.WriteWatcherAuth` writes to `config.WatcherAuthPath()` under a
    temp `XDG_CONFIG_HOME`.
  - `main_test.go`: drop `WATCHER_HOME` from `isolatedEnv` and keep
    `XDG_CONFIG_HOME` isolated.
  - `github_guard_test.go`: assert `config.WatcherAuthPath()` and
    `config.ConfigPath()` are under the isolated dir.
  - `settings_keys_test.go`: remove the `watcher_config` root. If its
    yaml-tag walker doesn't follow `,inline`, teach it to, so the embedded
    `JiraBehavior` keys show up as `jira.bot_usernames` and
    `jira.custom_fields`.
  - `settings_keys.go`: move `github.bot_usernames`, `jira.bot_usernames` and
    `jira.custom_fields` into `"worktree"`; delete the `watcher_config` entry
    and all of `settingsKeyExclusions["watcher_auth"]`.
  - `settings_watcher_test.go`: the watcher-config PUT round-trip asserts the
    values land in the worktree `config.yaml` (`s.ConfigPath`) and that a
    comment in that file survives.
  - Add `TestWatcherAuthWorldReadableNamesFile`: a 0644 auth file makes the
    settings GET or the poller error mention `watcher-auth.yaml` and
    `chmod 600`. The library's message already does this; assert it surfaces.
  - **Modal file-name text (Mike's requirement).** Every place the Settings
    modal or its API names a file must name the real one:
    - `settingsPaths` in `internal/webui/settings.go` (the `paths` DTO
      behind the modal's "persisted to" lines): `watcher_auth` is
      `ShortPath(s.watcherAuthPath())`. `watcher_config` is now worktree's
      `config.yaml` path, since those keys live there. Keep the JSON keys so
      the draft structure is unchanged.
    - Add or extend a settings GET test asserting `paths.watcher_auth` ends
      in `worktree/watcher-auth.yaml` and `paths.watcher_config` equals
      `paths.worktree`.
    - `ui/src/components/settings/ConnectedServicesPanel.tsx`: the
      `fileTitle` labels become `watcher_auth: "watcher-auth.yaml"` and
      `watcher_config: "config.yaml"`.
    - Fix stale doc comments in `ConnectedServicesPanel.tsx`,
      `JiraPollingSection.tsx`, `tabDirty.ts`, `useSettingsDraft.ts` and
      `ui/src/api/types.ts`.
    - Server error strings in `settings_creds.go`, `settings_watcher.go` and
      `pr_comments_api.go`: "auth.yaml" becomes "watcher-auth.yaml", and
      "watcher config.yaml" becomes "config.yaml".
    - Verify with `cd ui && npm run build` (or the repo's typecheck/lint
      script), plus
      `grep -rn 'auth\.yaml\|watcher config' ui/src internal/webui --include='*.ts' --include='*.tsx' --include='*.go' | grep -v 'watcher-auth\.yaml'`,
      which should show nothing stale.
- [ ] **Step 2:** `go test ./internal/... ./cmd/...`. Expected: FAIL where
  code still reads the old paths.
- [ ] **Step 3: Switch every reader.**
  - In webui, `wconfig.Load(wconfig.DefaultPath())` becomes
    `wconfig.Load(s.watcherAuthPath())`.
  - Bot usernames and custom fields come from
    `config.ReadEditable(s.configPath())`.
  - `linked_api.go`: `loadLinkedCreds(s.watcherAuthPath())`.
  - `cmd/watcher.go` messages read
    `"no credentials configured in <ShortPath(config.WatcherAuthPath())> (run worktree setup)"`,
    and similarly per service. It passes Jira bot usernames from worktree
    config as well.
  - Rewrite `settings_watcher.go`'s header comment.
- [ ] **Step 4:**
  - `go build ./... && go test ./internal/... ./cmd/...`. Expected: PASS.
  - `go test -race ./internal/webui/`. Expected: PASS.
  - `grep -rn 'wconfig.DefaultPath\|ConfigDefaultPath\|LoadConfig\|SaveConfig\|WATCHER_HOME' --include='*.go' . | grep -v '^./internal/setup\|^./cmd/setup.go'`.
    Expected: no output.
- [ ] **Step 5: Commit:** `refactor: read watcher credentials and preferences from worktree's own files`

### Task 5: Setup and uninstall

**Files:**
- Modify: `internal/setup/setup.go`
  - `testAndRepairSharedCreds` becomes `testAndRepairWatcherCreds`
  - Plan seed check
  - Uninstall preview and execute
- Modify: `internal/setup/botdefaults.go`, `internal/setup/slack_setup.go`, `internal/setup/agentuninstall.go`
- Modify: `cmd/setup.go` (delete `registerWatcherConsumer` and its call)
- Test: `internal/setup/setup_test.go`, `internal/setup/agentuninstall_test.go`, a new `internal/setup/botdefaults_test.go` (or the existing one)

**Interfaces:**
- Consumes: `config.WatcherAuthPath()`, `config.ReadEditable` / `config.WriteEditable` (Task 3).
- Produces:
  - `needsGitHubBotSeed(configPath string) bool`: true when `!HasGitHubBlock`
  - `seedGitHubBotUsernames(configPath string) error`
  - `agentUninstall` loses `WatcherPath` and `Consumer`
  - `Plan` loses any registry field; `TestUninstallCoversEverySetupStep`
    must stay green

- [ ] **Step 1: Write the failing tests:**
  - `TestSeedGitHubBotsIntoWorktreeConfig`: seeding a config without a
    `github` key writes `["*ci-bot*"]` to `config.yaml`.
  - `TestSeedSkipsClearedGitHubBots`: no reseed when the file has
    `github: {bot_usernames: []}`.
  - `TestUninstallPreservesWatcherAuth`: the preview lists
    `Preserve credentials at …/watcher-auth.yaml`, and execute leaves the file.
  - `TestTestAndRepairSavesToWatcherAuth`: with a fake prompter and a stubbed
    validator, a fresh `XDG_CONFIG_HOME` gets `worktree/watcher-auth.yaml` at
    0600. Use the existing setup test seams; if none exist for the
    validators, test the load/save wrapper with `changed=true`.
- [ ] **Step 2:** `go test ./internal/setup/ ./cmd/`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each `wconfig.DefaultPath()` here becomes `config.WatcherAuthPath()`.
  - Bot seeding goes through `config.WriteEditable`.
  - Remove the consumer registration and unregistration and their preview
    lines.
  - Uninstall prints
    `Preserve credentials at <ShortPath(config.WatcherAuthPath())>` when the
    file exists.
  - Update the printed `"Updated …"` path.
- [ ] **Step 4:** `go test ./internal/setup/ ./cmd/`. Expected: PASS.
  `grep -rn 'wconfig.DefaultPath\|ConfigDefaultPath\|LoadConfig\|SaveConfig\|RegisterConsumer\|Consumers()' --include='*.go' .`
  Expected: no output.
- [ ] **Step 5: Commit:** `feat(setup): store watcher credentials in worktree's watcher-auth.yaml`

### Task 6: Re-pin v0.27.0, docs, full verification

**Files:**
- Modify: `go.mod`, `go.sum`
- Modify: `.claude/CLAUDE.md`
  - the `setup` package line ("writes to `~/.config/watcher/auth.yaml`")
  - "Slack credentials live in…"
  - "Slack creds are the user's own session credentials… stored in…"
  - the "Config files ↔ Settings modal" section: now two files, worktree
    `config.yaml` and worktree `watcher-auth.yaml` (`wconfig.Config`); the
    `wconfig.ConfigFile` root is gone
- Modify: `docs/web-ui-architecture.md` (every `~/.config/watcher` and
  `watcher config.yaml` mention)
- Modify: `README.md` if it mentions the old paths
- Modify: `internal/agentskill/skills/worktree/SKILL.md` if it mentions them

- [ ] **Step 1:** `go get github.com/mturley/watcher@v0.27.0 && go mod tidy`
- [ ] **Step 2:** `make build && make test`. Expected: builds, all `ok`.
  Then `go test -race ./internal/webui/`. Expected: PASS.
- [ ] **Step 3: Update the docs listed above.**
- [ ] **Step 4:**
  `grep -rn 'config/watcher\|WATCHER_HOME\|jira_custom_fields' --exclude-dir=node_modules --exclude-dir=.git . | grep -v 'docs/superpowers/plans/\|docs/superpowers/specs/'`
  Expected: no output.
- [ ] **Step 5: Commit:** `chore: re-pin watcher v0.27.0 and document per-tool credentials`

## Part 3: agent-handler (`~/git/agent-handler`)

### Task 7 (checkpoint): Catch up to watcher v0.26.0

**Files:** `go.mod`, `go.sum`

- [ ] **Step 1:**
  1. `git switch -c per-tool-watcher-creds`
  2. `go get github.com/mturley/watcher@v0.26.0 && go mod tidy`
- [ ] **Step 2:** `make build` (it builds `ui/dist`), then `go vet ./... && go test ./...`.
  Expected: clean and all `ok`. Fix any compile breaks by matching the
  library's current signatures.
- [ ] **Step 3: Commit:** `chore: bump watcher v0.8.0 → v0.26.0`
- [ ] **Step 4: Ask Mike** before the runtime check. It migrates the real DB.
  After approval:
  1. `cp ~/.agent-handler/data/handler.db ~/.agent-handler/data/handler.db.backup-$(date +%Y%m%dT%H%M%S)`
  2. `./bin/handler watcher run github`, then `jira`, then `slack`
  3. `./bin/handler status`

  Expected: no errors, and new rows in `watcher_events` if anything changed.
  Report the results. Also ask whether to `make install` now, so the
  scheduled watchers don't keep running the v0.8.0 binary against the
  migrated DB.

### Task 8: handler config owns the auth path and preferences

**Files:**
- Modify: `config/config.go`
  - drop `Services`, `GitHubConfig`, `JiraConfig`, `IsServiceConfigured`
  - add `WatcherAuthPath`, `GitHub`/`Jira` preference blocks, and
    `SeedJiraCustomFields`
  - `DefaultResourceURL` (Jira host) and `slackResourceURL` read the auth file
- Modify: `config/service_configured.go`
- Test: `config/config_test.go`, `config/service_configured_test.go`

**Interfaces:**
- Produces:
  - `func WatcherAuthPath() string`: `filepath.Join(filepath.Dir(DefaultPath()), "watcher-auth.yaml")`
    (honours `HANDLER_HOME`)
  - `Config.GitHub *wcfg.GitHubBehavior \`yaml:"github,omitempty"\``
  - `Config.Jira *wcfg.JiraBehavior \`yaml:"jira,omitempty"\``
  - `func SeedJiraCustomFields(path string, fields map[string]string) (bool, error)`:
    sets `jira.custom_fields` only when it is absent or empty, by editing the
    yaml.Node tree. Comments, key order, unknown keys (including an old
    `services:` block) and file mode stay as they are. A missing file is
    created 0600. Returns whether it wrote.
  - `ServiceConfiguredForWatching(service string) bool` keeps its signature
    and reads `WatcherAuthPath()`

- [ ] **Step 1: Write the failing tests.** Replace any `WATCHER_HOME` with
  `HANDLER_HOME` and fixtures with `<HANDLER_HOME>/watcher-auth.yaml`.
  - `TestWatcherAuthPathHonorsHandlerHome`
  - `TestServiceConfiguredReadsHandlerWatcherAuth`: github, jira and slack
    are each true only when that block is in `watcher-auth.yaml`. A missing
    file means all false.
  - `TestDefaultResourceURLJiraUsesAuthHost`: `PROJ-1` →
    `https://x.atlassian.net/browse/PROJ-1` from the auth file's `host`.
  - `TestSeedJiraCustomFieldsPreservesFile`: input has a comment,
    `services: {github: {token: t}}`, `auto_wake: {enabled: false}`. After
    seeding, those lines are unchanged and `jira.custom_fields` is present.
  - `TestSeedJiraCustomFieldsKeepsExisting`: existing fields → `(false, nil)`,
    file byte-identical.
- [ ] **Step 2:** `go test ./config/`. Expected: FAIL.
- [ ] **Step 3: Implement.** Delete tests of `IsServiceConfigured` and of the
  `services` block.
- [ ] **Step 4:** `go test ./config/`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(config): handler-owned watcher-auth.yaml and watcher preferences`

### Task 9: Watcher commands, migration, re-pin v0.27.0, docs

**Files:**
- Modify, in `cmd/watcher/`:
  - `auth.go`: load and save `config.WatcherAuthPath()`. Seed through
    `config.SeedJiraCustomFields(config.DefaultPath(), defaults)`; delete
    `writeWatcherBehaviorConfig`. The message names
    `~/.agent-handler/config.yaml` under `jira.custom_fields`. The help text
    names the new credentials file.
  - `install.go`: same load/save change.
  - `run.go`: credentials from `config.WatcherAuthPath()`. Bot usernames and
    custom fields come from `config.Read(config.DefaultPath())`'s
    `Jira`/`GitHub` blocks. Pass GitHub bot usernames through the GitHub
    poller's options if the v0.26+ signature takes them.
- Modify: `cmd/migrate_watcher.go`. Delete `migrateCredentials`,
  `migrateBehaviorConfig`, `writeWatcherBehaviorConfig` and their calls and
  output lines. Keep the DB migration.
- Modify: `cmd/migrate_watcher_test.go`, `integration_test.go`. Swap
  `WATCHER_HOME` for `HANDLER_HOME`; delete tests of the removed migration
  steps.
- Modify: `go.mod`, `go.sum`
- Modify: `README.md` (lines ~46, 224–270), `docs/watcher-migration-runbook.md`
  (~106), `skills/watch/SKILL.md` (~53)

**Interfaces:** Consumes `config.WatcherAuthPath()`, `config.SeedJiraCustomFields`, `Config.GitHub`/`Config.Jira` (Task 8).

- [ ] **Step 1: Update and write the tests.**
  - The auth/install tests (whatever exists in `cmd/watcher/*_test.go`)
    expect `<HANDLER_HOME>/watcher-auth.yaml`.
  - Add `TestRunReadsJiraPrefsFromHandlerConfig`, using whatever seam
    `run.go` tests already use for the poller. If there is none, extract
    `jiraAuthFor(creds wcfg.JiraCreds, cfg *config.Config) wjira.JiraAuth`
    and test that bot usernames and custom fields come from `cfg.Jira`.
- [ ] **Step 2:** `go test ./...`. Expected: FAIL.
- [ ] **Step 3: Implement the changes listed above.** Then
  `go get github.com/mturley/watcher@v0.27.0 && go mod tidy`.
- [ ] **Step 4:** `make build && go vet ./... && go test ./...`. Expected: all `ok`.
  `grep -rn 'config/watcher\|WATCHER_HOME\|wcfg.DefaultPath\|ConfigDefaultPath\|LoadConfig' --include='*.go' --include='*.md' . | grep -v 'docs/superpowers\|original-brainstorm'`
  Expected: no output.
- [ ] **Step 5: Update the docs.** Credentials live in
  `~/.agent-handler/watcher-auth.yaml`, written by `handler watcher auth`.
  Jira custom fields and bot usernames go under top-level `jira:` in
  `~/.agent-handler/config.yaml`. The migration paragraph no longer mentions
  copying credentials.
- [ ] **Step 6: Commit:** `feat!: per-tool watcher credentials; drop ~/.config/watcher`

## Part 4: Finish

### Task 10 (checkpoint): Merge, install, hand over

- [ ] **Step 1:** Run the final whole-branch reviews (worktree branch, handler
  branch).
- [ ] **Step 2: Ask Mike** about merging each branch to its `main`, pushing,
  and `make install` for worktree (`NONINTERACTIVE=1 make install`) and
  handler.
- [ ] **Step 3:** Ask Mike to run `! worktree setup` and
  `! handler watcher auth`. Both prompt for credentials interactively. Then
  verify: the worktree UI shows the services as configured, and
  `handler watching` lists github/jira/slack as configured.
- [ ] **Step 4: Give Mike the cleanup checklist:**
  - Copy `github.bot_usernames`, `jira.bot_usernames` and
    `jira.custom_fields` from `~/.config/watcher/config.yaml` into
    `~/.config/worktree/config.yaml` (or Settings → Connected Services), and
    into top-level `github:`/`jira:` in `~/.agent-handler/config.yaml`.
  - Delete the `services:` block from `~/.agent-handler/config.yaml`.
  - `rm -r ~/.config/watcher` (`auth.yaml`, `config.yaml`, `auth.yaml.bak-*`).
  - If Task 7 made one, delete the `handler.db.backup-*` once satisfied.
  - Delete the `per-tool-watcher-creds` worktree and the branches once merged.
  - Anything else found along the way.
