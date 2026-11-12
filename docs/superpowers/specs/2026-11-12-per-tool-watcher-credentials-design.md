# Per-tool watcher credentials (drop `~/.config/watcher`)

Status: approved design, 2026-11-12. Spans three repos: `~/git/watcher`
(library), `~/git/worktree`, `~/git/agent-handler`.

## Intent

Today every consumer of the watcher library reads one shared directory,
`~/.config/watcher/`:

- `auth.yaml` (0600): GitHub token, Jira host/email/token, Slack
  token/cookie/workspace domain, a leftover `jira_custom_fields` map, and a
  `consumers:` registry of each tool's DB path.
- `config.yaml` (0644): GitHub/Jira bot username globs and Jira custom field
  IDs.

That is a security problem: installing anyone else's watcher-based tool hands
it the user's GitHub, Jira and Slack credentials without the user ever setting
that up. It is also a correctness problem: tools pin different library
versions, and different versions may expect different contents in the same
file.

The fix: **tools never share credentials or config.** The shared directory
disappears from all code. Each tool owns its own credentials file and its own
preferences. The user accepts re-entering credentials once per tool as the
price.

## Goals

- No code in any of the three repos reads, writes, mentions, migrates from, or
  falls back to `~/.config/watcher` or `WATCHER_HOME`.
- The watcher library never chooses a file location. Callers always pass a
  path.
- Each tool has a credentials file whose format the library owns:
  - worktree: `~/.config/worktree/watcher-auth.yaml`
  - agent-handler: `~/.agent-handler/watcher-auth.yaml` (next to its existing
    `config.yaml`; handler does not move to `~/.config/`)
- Non-secret watcher preferences (GitHub/Jira bot usernames, Jira custom
  fields) live in each tool's **own** `config.yaml`, next to that tool's other
  preferences. The split is **secret vs. not secret**, not library vs. tool.
- Setup in each tool notices missing credentials and walks the user through
  them using the existing `credsetup` test-and-repair flow.
- agent-handler moves from watcher v0.8.0 to the new release.

## Non-goals

- No migration, import, or copy from `~/.config/watcher`. The user will move
  their Jira preferences by hand and delete the directory after everything is
  installed. Setup must not offer to copy, and nothing may detect the old
  files.
- No backward compatibility in the library. This is a breaking release.
- worktree and handler stay separate tools. Neither reads the other's files.

## Anti-goals (failure even if it "works")

- Any fallback that reads the old shared files "just in case". That keeps
  exactly the leak this design removes.
- A tool reading another tool's `watcher-auth.yaml`.
- Credentials ending up in a tool's `config.yaml`. That file must stay safe to
  share and need not be 0600.

## Design

### 1. watcher library (breaking release, v0.27.0 — v0.26.0 is already tagged and pinned by worktree)

`config` package:

| Item | Change |
|---|---|
| `DefaultPath`, `ConfigDefaultPath`, `WATCHER_HOME` handling | **Delete** |
| `Config.ConsumerRegistry`, `Consumer`, `RegisterConsumer`, `UnregisterConsumer`, `Consumers` | **Delete**. Nothing reads the registry for a real purpose. |
| `Config.JiraCustomFields` (`jira_custom_fields` in the auth file) and `JiraCreds.CustomFields` | **Delete**. These duplicate the behavior setting. Custom fields reach the Jira poller only from the tool's preferences. |
| `ConfigFile`, `LoadConfig`, `SaveConfig` | **Delete**. The library no longer owns a behavior file. |
| `GitHubBehavior`, `JiraBehavior` (with `BotUsernames`, `CustomFields`) | **Keep** as types tools embed in their own config structs. |
| `Config` (now just `Services`), `GitHubConfig`/`JiraConfig`/`SlackConfig`, `GitHub()`/`Jira()`/`Slack()` + `*Creds` | **Keep.** This is the credentials file format. |
| `Load(path)` / `(*Config).Save(path)` with the 0600 write and refusal to load a group/world-readable file | **Keep unchanged.** A missing file still loads as an empty `Config`. |

Update the package doc comment to say the library owns the *format* of a
credentials file but never its location.

`credsetup` is unchanged except for anything that relied on the removed items.
Other packages (pollers) already take explicit options and should need no
change, apart from any Jira poller wiring that read `JiraCreds.CustomFields`.

Update README/docs, delete tests for removed functions (do not add tests
asserting their absence), run `go test ./...`, commit, tag, and push both the
branch and the tag.

### 2. worktree

**Paths and accessors.**
- Add one way to get the credentials path, `~/.config/worktree/watcher-auth.yaml`,
  derived from the same base directory as worktree's `config.yaml`. In tests it
  must be overridable without env vars where practical: a `Server` field for
  `internal/webui`, and a parameter or injected path for `internal/setup`,
  `internal/jira`, `slackcreds`, `worktreenew`. Today's `WATCHER_HOME` uses in
  tests (`internal/jira/jiratest`, `TestMain`) move to that mechanism.
- Every current `wconfig.Load(wconfig.DefaultPath())` /
  `wconfig.LoadConfig(wconfig.ConfigDefaultPath())` call site switches to the
  new credentials path or to worktree's own config. Known sites:
  - `cmd/`: `watcher.go`, `setup.go`
  - `internal/setup/`: `setup.go`, `slack_setup.go`, `botdefaults.go`,
    `agentuninstall.go`
  - `internal/worktreenew/prfetch.go`
  - `internal/jira/client.go`
  - `internal/slackcreds/slackcreds.go`
  - `internal/webui/`: `poller.go`, `selfid.go`, `jira_proxy.go`,
    `linked_api.go`, `bot_authors.go`, `settings.go`, `settings_watcher.go`,
    `settings_creds.go`

  Grep again rather than trusting this list.
- User-facing strings such as `cmd/watcher.go`'s "no credentials configured
  in ~/.config/watcher/auth.yaml (run watcher auth setup)" must name the new
  file and the real worktree command that fixes it (`worktree setup`).

**Preferences in `config.yaml`.**
- `internal/config.Config` gains GitHub and Jira watcher preferences by
  embedding the library's behavior types:
  - `github.bot_usernames`
  - `jira.bot_usernames` and `jira.custom_fields`, next to the existing
    `jira.projects` and `jira.alias_hosts`

  The YAML keys keep their current names.
- The poller, `bot_authors.go`, and the Jira client read these from
  worktree's config and pass them to the library.

**Setup.**
- `testAndRepairSharedCreds` (rename it, since nothing is shared now) loads
  from and saves to the new file. A missing file starts empty, so a fresh
  install prompts for each enabled service, as for a first install.
- The GitHub bot-username seed (`botdefaults.go`, `Plan.SeedGitHubBotUsernames`)
  writes into worktree's `config.yaml`.
- Remove the consumer-registry step (`registerConsumer` in `cmd/setup.go`, the
  agent-uninstall registry removal, and its plan/preview lines).
- `--uninstall` **preserves** `watcher-auth.yaml` and says so (a `Preserve`
  line), just as it already does for `config.yaml`.
  `TestUninstallCoversEverySetupStep` must stay green.

**Settings modal.** Follow CLAUDE.md "Config files ↔ Settings modal":
- Credentials keys keep working through `settings_creds.go` against the new
  path (`watcherAuthPath()`).
- The behavior keys move from the `wconfig.ConfigFile` root to worktree's
  `config.Config` root (`editable.go` `Editable`/`ReadEditable`/`WriteEditable`).
- Remove the `wconfig.ConfigFile` root from `TestSettingsModalCoversEveryConfigKey`
  and `settingsKeyPaths`.
- Update `ui/src/api/types.ts`, the Connected Services panels, and `tabDirty.ts`
  if the DTO shape changes.

  The modal should look the same to the user.

**Docs.** Update CLAUDE.md (the `setup` package line, "Slack creds", and the
watcher-library section), `docs/web-ui-architecture.md`, the agent skill
(`internal/agentskill/skills/worktree/SKILL.md`), and the README. Leave
historical plans in `docs/superpowers/plans/` alone.

**Re-pin** to the new watcher tag, `go mod tidy`, `make build`, `make test`,
then run `go test -race ./internal/webui/` because webui tests change.

### 3. agent-handler

**Step A: pin bump on its own (v0.8.0 → v0.26.0, the latest release before this change).**
A trial build against v0.25.1 showed `go build`, `go vet` and `go test ./...`
all pass with no code changes. Re-check against v0.26.0, which adds the
`watcher_events.out_of_date` migration. Runtime is unverified: every library
schema migration since v0.8.0 will run against
`~/.agent-handler/data/handler.db`.
1. Back up the DB file.
2. Bump, build, and run `handler watcher run github|jira|slack` once each.
3. Check that events still land and `handler status` works.

Commit this separately so a schema problem can't be confused with the config
change.

**Step B: adopt the new release.**
- Re-pin to the new tag.
- Credentials path `~/.agent-handler/watcher-auth.yaml` comes from handler's
  `config` package. Switch every `wcfg.Load(wcfg.DefaultPath())` and
  `wcfg.LoadConfig(wcfg.ConfigDefaultPath())` site:
  - `cmd/watcher/auth.go`, `install.go`, `run.go`
  - `cmd/migrate_watcher.go`
  - `config/config.go`, `config/service_configured.go`
- **Delete the old `services:` block** from handler's `Config` (`Services`,
  `GitHubConfig`, `JiraConfig` with `url`). Anything that read it switches to
  the credentials file:
  - `IsServiceConfigured` (`config/config.go:135`)
  - the Jira browse-URL builder (`:166`), which uses the credentials file's
    Jira `host`
  - Slack permalinks
- Add top-level `github:` / `jira:` preference blocks to handler's
  `config.yaml` by embedding the library's behavior types. `handler watcher
  run` passes them to the pollers. `handler watcher auth`'s "add default Jira
  custom fields" step writes them to handler's own `config.yaml`
  (`writeWatcherBehaviorConfig` goes away).
  *Builder's call, made in review:* the user edits this file by hand, and today's only
  writer (`config.Write`, a struct marshal) would drop comments and any key
  the struct doesn't know about. So writes to handler's `config.yaml` edit
  the YAML node tree and touch only the keys being set, keeping everything
  else as it was.
- `--migrate-watcher`: delete the part that copies credentials and behavior
  settings into `~/.config/watcher`. Keep the DB-migration part.
- `handler watcher auth`/`install` load from and save to the new credentials
  file. A missing file prompts as for a first install.
- Update the README (the watcher section, Jira custom fields, the migration
  paragraph), `docs/watcher-migration-runbook.md` where it names the shared
  path, and any skills or rules text.
- `go test ./...` and `make build`.

### Order and branches

1. watcher: change, release v0.27.0, tag, push.
2. worktree: feature branch, re-pin and adopt, merge.
3. agent-handler:
   - Step A on a branch.
   - Step B on the same or a following branch.

Then install both (`NONINTERACTIVE=1 make install` for worktree does the
install, but its setup needs the interactive credential prompts, so the user
runs `worktree setup` themselves; likewise `handler watcher auth`). The user
fills in credentials and moves their Jira preferences by hand, then deletes
`~/.config/watcher`.

## Leftover tokens in handler's config.yaml (user's decision)

Code never detects, warns about, or removes the old `services:` block in
`~/.agent-handler/config.yaml`. The user deletes it by hand. Because writes
keep unknown keys (above), the block stays until then.

## Wrap-up deliverable

When everything is merged and installed, give the user a manual cleanup
checklist. At minimum:
- Move Jira/GitHub preferences (bot usernames, custom fields) from
  `~/.config/watcher/config.yaml` into each tool's `config.yaml`.
- Delete the `services:` block from `~/.agent-handler/config.yaml`.
- Delete `~/.config/watcher/`, including `auth.yaml.bak-*`.
- Anything else found along the way.

## Left to the builder

- Exact names of accessors/fields and how tests inject paths.
- Exact new library version number.
- Whether handler's Step A and Step B share a branch.
