# Settings modal: full config editing + Watcher Auth/Config tabs

Date: 2026-10-14

## Goal

The web UI's Settings modal can view and edit every user-facing key in the
three config files worktree reads, so the user never has to open a YAML file
or re-run `worktree setup` just to change a value:

| Tab | File |
|---|---|
| General | `~/.config/worktree/config.yaml` (worktree) |
| Watcher Auth | `~/.config/watcher/auth.yaml` |
| Watcher Config | `~/.config/watcher/config.yaml` |
| Devices | unchanged |

Secrets (tokens, cookie, UI password) are write-only: the UI shows that one
is set but never shows its value. Each credential has a Test button, and
replacing a credential tests it before writing.

A new `worktree setup slack` subcommand reruns the Playwright Slack capture
on its own. Agent guidance, backed by a test, makes future config keys show
up in the modal.

## Out of scope

- auth.yaml `consumers` (owned by setup; never shown).
- auth.yaml's legacy `jira_custom_fields` (never shown; stays file-only).
- Reissuing the HTTPS certificate from the UI (setup's job).
- Restarting the server from the UI.
- Any mention of agent-handler in the UI.

## UI

Mockups: `.superpowers/brainstorm/51852-1792010815/content/general-tab.html`
and `watcher-tabs-v2.html`.

### Common to every config tab

- First line: "These settings are persisted to `<path>`" (home-relative path).
- Fields are grouped under section headings that mirror the YAML's nesting.
  Each field shows a label, a one-line description and its YAML key path in
  dim text.
- List fields (`jira.projects`, `jira.alias_hosts`, `ui.allowed_hosts`,
  `jira.bot_usernames`) use Mantine `TagsInput`. Maps (`jira.custom_fields`)
  use a key/value table with add/remove rows.

### Save model

- **One modal-wide Save/Discard footer** covers every non-secret field on
  every tab. It appears in an inactive state when nothing has changed. A dot
  on a tab label marks a tab with unsaved changes, and the footer says how
  many of the changes need a restart.
- The **cmux toggle is no longer live**: it is a footer-saved field like any
  other. On Save the server persists it, then flips the gate, and runs the
  unread-prefix strip when disabling, exactly as `PUT /api/settings` does
  today. Then the client invalidates the cmux and session queries.
- Save sends one request per file that has changes (General, Watcher Auth
  non-secrets, Watcher Config), in that order. A file that saved stays
  saved. A failure shows an error on that tab and leaves its changes in
  place so the user can retry.
- Closing the modal with unsaved changes asks for confirmation (Mantine
  `modals.openConfirmModal` or an inline confirm, whichever the codebase
  already uses).

### Secret fields (`SecretField`)

Used for `services.github.token`, `services.jira.token`,
`services.slack.token`, `services.slack.cookie` and `ui.password`. States:

| State | Shows |
|---|---|
| not set | input with placeholder "Not set — click to add"; Test disabled |
| set, idle | masked "•••• set"; Test button; last test result chip |
| focused | empty input ("Paste a new token"); **Replace** (disabled until non-empty) and **Cancel** |
| replacing | Replace shows a loader |
| replace failed | input keeps the typed value; error text says nothing was saved and the old value is still in place |
| replace ok | back to "•••• set"; chip "✓ Saved · valid" |

- Replace is **per field and immediate**; it is not part of the footer. A
  secret never sits in form state waiting to be saved. On success the client
  drops the typed value.
- Replace **always refuses** a credential that fails validation, whether the
  service rejected it or could not be reached. Nothing is written.
- Test chip values: untested / testing… / ✓ Valid · tested Xm ago /
  ✕ Rejected (detail) / ⚠ Couldn't reach (detail). Results live in client
  state only, and the Watcher Auth tab runs Test for each configured service
  when it is first opened.
- `ui.password` uses `SecretField` with no Test button and no chip.

### General tab (worktree config.yaml)

- Interface: Enable cmux features (`ui.cmux_features_disabled`, inverted;
  disabled with a tooltip when the server can't reach cmux, as today),
  Editor (`editor`).
- Worktrees: Worktrees base directory (`worktrees_base`). The description
  notes that `$WORKTREES_BASE` overrides it when set; the server reports
  whether it is set, and the field then shows a note saying the env var
  wins.
- Jira: Project keys (`jira.projects`), Alias hosts (`jira.alias_hosts`),
  plus a one-line pointer: "Jira host, email and token are on the Watcher
  Auth tab."
- Remote access — badge "Applies after restarting worktree ui":
  UI password (`ui.password`, SecretField; **applies immediately**, see
  below), HTTPS port (`ui.https_port`, 1–65535), Allowed hosts
  (`ui.allowed_hosts`), TLS certificate / key (`ui.tls.cert_file`,
  `ui.tls.key_file`).
- When the allowed hosts entered include a name the current certificate does
  not cover (`uitls.ReadCert` + `uitls.Uncovered`, computed server-side and
  returned in the GET DTO for the saved values; the client checks unsaved
  entries against a returned `cert_names` list), show a warning: "The
  current certificate doesn't cover X. Run `worktree setup` to reissue it,
  then reinstall the CA on your phone."

### Watcher Auth tab (auth.yaml)

- GitHub: Token (SecretField + Test).
- Jira: Host (`services.jira.host`), Email (`services.jira.email`), API token
  (SecretField + Test). Jira Test and Replace send the host and email
  **currently in the form**, even if unsaved, so a host change can be tested
  together with a new token.
- Slack: info line "To automatically capture the Slack token and cookie from
  a browser session, run `worktree setup slack`." Then Session token,
  Session cookie (both SecretField; one Test validates the pair and updates
  both chips; replacing one is validated with the stored value of the
  other), and Workspace domain (`services.slack.workspace_domain`, plain
  field). A successful Slack replace also re-resolves the workspace domain
  via `TeamInfo` (best-effort) and writes it.

### Watcher Config tab (watcher config.yaml)

- Jira: Bot usernames (`jira.bot_usernames`), Custom fields
  (`jira.custom_fields`; name → field ID). Keys and values are trimmed and
  must be non-empty, and names must be unique.

## Backend

### Routes (all behind the existing session auth + forgery guard)

| Method + path | Purpose |
|---|---|
| `GET /api/settings` | One DTO with all three files plus environment facts |
| `PUT /api/settings/worktree` | Write worktree config.yaml non-secret fields |
| `PUT /api/settings/watcher-auth` | Write auth.yaml non-secret fields (jira host/email, slack workspace_domain) |
| `PUT /api/settings/watcher-config` | Write watcher config.yaml |
| `PUT /api/settings/password` | Replace `ui.password` |
| `PUT /api/settings/credentials/{service}` | Validate then write a credential (`github`, `jira`, `slack`) |
| `POST /api/settings/credentials/{service}/test` | Validate stored (or partially overridden) credentials |

The existing `PUT /api/settings` (cmux toggle only) is removed; its gate and
strip logic move into the worktree-file save. The client is updated in the
same change.

### GET DTO

```jsonc
{
  "environment": {
    "in_cmux": true,
    "worktrees_base_env": false,           // $WORKTREES_BASE is set
    "cert_names": ["mturley-mac.local", "192.168.86.22"]  // null if no cert
  },
  "worktree": {
    "path": "~/.config/worktree/config.yaml",
    "worktrees_base": "~/.worktrees",       // as written in the file (unexpanded)
    "editor": "",
    "cmux_features_enabled": true,
    "jira": { "projects": [...], "alias_hosts": [...] },
    "ui": {
      "password_set": true,
      "https_port": 8476,
      "allowed_hosts": [...],
      "tls": { "cert_file": "...", "key_file": "..." }
    }
  },
  "watcher_auth": {
    "path": "~/.config/watcher/auth.yaml",
    "github": { "token_set": true },
    "jira": { "host": "...", "email": "...", "token_set": true },
    "slack": { "token_set": true, "cookie_set": true, "workspace_domain": "..." }
  },
  "watcher_config": {
    "path": "~/.config/watcher/config.yaml",
    "jira": { "bot_usernames": [...], "custom_fields": { "epic_key": "customfield_10014" } }
  }
}
```

No secret value ever appears in any response. A handler test asserts this
by seeding known secret strings and checking that the serialized body does
not contain them.

The worktree section reports **raw file values**, read through the node
tree, not the `Load()` result. `Load()` expands `~` and applies env
overrides, and writing those back would silently rewrite the file.

### PUT bodies

The PUT bodies for the three files are full replacements of the section's
editable fields, mirroring the DTO minus secrets, paths and `*_set`. Fields
are validated server-side: port range, non-empty list entries, and Jira
host as an http(s) URL. Errors return 400 with a message the UI shows on
the tab.

Credential PUT bodies:
- github: `{ "token" }`
- jira: `{ "token", "host", "email" }`. Host and email are required, and
  are written together with the token so the stored triple is always one
  that validated.
- slack: `{ "token"?, "cookie"? }`. At least one is required; the missing
  one comes from the stored config.

Test bodies: empty to test what is stored; jira may pass `host` and
`email` overrides. The response is
`{ "ok": bool, "kind": "ok"|"auth"|"network", "detail": string }`, where
`kind` comes from `errors.Is(err, <pkg>.ErrAuth)`.

### Writing each file

- **worktree config.yaml:** generalize `internal/config/settings.go`'s
  `editUIKey` into a small node-tree editor: set a scalar, set a string
  list, delete a key, at any key path. Every write preserves comments,
  unknown keys and key order, and keeps the 4-space indent and 0600 mode.
  Empty or default values delete the key: empty editor, empty lists,
  `https_port` equal to the default, and cmux enabled.
- **auth.yaml:** the watcher library's `config.Load` + `(*Config).Save`, as
  `worktree setup` already does. Load → mutate → Save, all under a
  process-wide mutex in webui so concurrent requests don't lose updates.
- **watcher config.yaml:** new library `config.SaveConfig(path, *ConfigFile)`
  (see below), with the same load → mutate → save pattern under the same
  mutex.

### Live application

- cmux toggle: live gate, as today.
- `ui.password`: `Security.Password` becomes swappable at runtime: an
  accessor guarded by a mutex or an `atomic.Pointer[string]`, used by
  login. `PUT /api/settings/password` writes the file, then swaps the
  value. Existing sessions stay valid.
- editor, worktrees_base and Jira projects/alias_hosts: verify during
  implementation that each is read from `config.Load()` per request. For any
  that the server caches at startup, refresh the cached value on save.
  Never mark one "restart required" just to avoid the work.
- `https_port`, `allowed_hosts` and TLS paths: restart required; badge
  only.
- Watcher fields: already re-read from disk per poll and request.

## Watcher library changes (cross-repo, one release)

In `~/git/watcher`, with tests, then tag, push, and re-pin here:

1. `config.SaveConfig(path string, c *ConfigFile) error`: marshals to YAML
   and creates the directory with 0700. The file is non-secret, so 0644 is
   fine; match the library's conventions.
2. `credsetup.Replace(cfg *config.Config, svc Service, p Prompter) (bool, error)`:
   prompts, validates and applies without first testing the stored value.
   It reuses the existing repair functions' prompt → validate → apply tail,
   factored out rather than duplicated.

## `worktree setup slack`

New cobra subcommand under `setup`, with a `--force` flag.

1. Load auth.yaml.
2. With `--force`, go straight to step 4.
3. Run `credsetup.TestAndRepair(cfg, credsetup.Slack, prompter)`. That
   covers missing creds (offers setup) and rejected creds (confirm, then
   capture). If the creds were valid (no change, no error), ask "Slack
   credentials are valid. Capture new credentials anyway?" (default No);
   on yes, go to step 4.
4. Run `credsetup.Replace(cfg, credsetup.Slack, prompter)`. The existing
   `Prompter.PromptSlack` runs `acquireSlackCreds`, which is the Playwright
   auto-extract with manual fallback.
5. Save auth.yaml if anything changed.

`tokenInstructions`' "run worktree setup again" text changes to
`worktree setup slack`.

## Agent guidance

- `CLAUDE.md` (this repo): add a rule that any change to a key in
  worktree's `config.Config`, or to the watcher `config.Config` or
  `config.ConfigFile` that worktree pins, must update the Settings modal:
  the DTO, the PUT handler, the panel and the tests. List the files.
- `docs/web-ui-architecture.md`: replace the "Settings toggle" section with
  a "Settings modal" section covering the routes, the save model, the
  secret handling, the live-vs-restart table and the guard test.
- **Guard test (Go):** reflect over the YAML tags of `config.Config` and of
  the watcher `config.Config`/`ConfigFile`, building the full key-path set.
  Assert that every path is in the settings key-path list or an explicit,
  commented exclusion list (`consumers`, `jira_custom_fields`). A new key
  fails CI until it is handled.

## Testing

- Go:
  - node-tree editor round-trips: comments and unknown keys survive;
    defaults delete keys
  - each PUT handler: valid, invalid → 400, unchanged → no rewrite
  - credential replace: validator stubbed via seam; success writes;
    failure (both auth and network) writes nothing
  - test endpoint kinds
  - secrets never in GET
  - password swap takes effect for login
  - the guard test
  - `setup slack` decision flow with a fake prompter
- Vitest:
  - `SecretField` state machine
  - footer dirty / Discard / per-file save with partial failure
  - tab dirty dots
  - close confirmation
  - cmux toggle no longer saves on change
- Library: `SaveConfig` round-trip; `Replace` per service with stubbed
  validators.
