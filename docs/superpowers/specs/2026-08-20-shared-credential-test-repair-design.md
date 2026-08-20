# Shared credential test + repair (watcher library) — Design

**Status:** Approved in-session 2026-08-20. Ready for implementation planning.

**Repos (3):** `~/git/watcher` (library — new capability), `~/git/worktree` (consumer), `~/git/agent-ledger` (agent-handler consumer; module `github.com/mturley/agent-handler`).

## Goal

Give `worktree setup` and `handler`'s setup a single, shared "test the credential; if it's bad or missing, help set up a new one, validate, save" flow for **all three** services watcher uses — GitHub, Jira, Slack — with the credentials in the shared `~/.config/watcher/auth.yaml`. Today the two consumers cover disjoint, divergent subsets (handler: github+jira, tested; worktree: slack, untested + jira, tested) and duplicate/diverge the logic. This unifies them on library-owned validation + a shared repair loop.

## Motivating facts (from recon)

- The watcher library `config` package is dependency-free and **already writes `auth.yaml`** via `(*Config).Save(path)` (0600 file, 0700 dir).
- Slack already has a real validate primitive: `slack.New(token,cookie).AuthTest(ctx)` / `.TeamInfo(ctx)` → wrapped `slack.ErrAuth` on bad creds (`TeamInfo` also returns the workspace host for `WorkspaceDomain`).
- GitHub/Jira have **no** validate primitive in the library and **no** auth sentinel — BUT agent-handler already has working validators (`~/git/agent-ledger/config/validate.go`: `ValidateGitHubToken` = GraphQL `{ viewer { login } }`; `ValidateJiraToken` = `GET /rest/api/3/myself`). The shared logic exists; it's in the wrong place. Port it into the library.
- The library has **zero interactive/prompt code** — it is a pure lib; all UX must stay in consumers.
- `config` imports no service package and the service packages don't import `config` → no cycle risk for a new leaf package that imports all of them.
- Current watcher tag: **v0.3.0**. worktree pins v0.3.0; handler pins **v0.2.6** (4 releases behind).
- The v0.2.6→v0.4.0 jump for handler is **non-breaking**: the only `config` change in that range is additive Slack fields (`Cookie`/`WorkspaceDomain`) which handler never touches; `db` change is the additive `watcher_resource_meta` table + schema-version bump 2→3. No signature removals.

## Architecture (three layers)

### Layer 1 — Core validate primitives (pure; in the existing service packages)
Added to `~/git/watcher`, no prompts, no config dependency, no cycles:
- `github.Validate(token string) error` — port handler's `{ viewer { login } }` GraphQL probe; return `github.ErrAuth` (new sentinel) on 401/`invalid`/unauthorized, a plain error on transport/other failures.
- `jira.Validate(host, email, token string) error` — port handler's `GET /rest/api/3/myself` (basic auth); return `jira.ErrAuth` (new sentinel) on 401/403, plain error otherwise.
- `slack.Validate(token, cookie string) error` — thin wrapper over the existing `AuthTest`; already yields `slack.ErrAuth`. (Keep `TeamInfo` for domain resolution.)
- Add `ErrAuth` sentinels to `github` and `jira` (slack has one). `config`/`(*Config).Save` unchanged.

### Layer 2 — `watcher/credsetup` (NEW distinct package; the only place with prompting-shaped code)
Imports `config` + `github`/`jira`/`slack`; nothing imports it → cycle-free. Quarantines all interaction behind a consumer-supplied interface so the core stays prompt-free.

```go
package credsetup

type Service string
const ( GitHub Service = "github"; Jira Service = "jira"; Slack Service = "slack" )

// Prompter is the consumer-supplied UX. credsetup never touches stdin/stdout —
// all interaction goes through this.
type Prompter interface {
    Info(msg string)                                          // status lines
    Confirm(msg string) bool                                  // y/N
    PromptToken(service Service, instructions string) string  // secret input; "" = abort
    PromptSlack(instructions string) (token, cookie string)   // slack needs token+cookie
}

// TestAndRepair tests svc's creds in cfg; if invalid/missing, walks the user
// (via p) through supplying + validating new creds, mutating cfg on success.
// It does NOT save — the caller persists via cfg.Save so a full setup batches
// all three services into one atomic write. Returns whether cfg changed.
func TestAndRepair(cfg *config.Config, svc Service, p Prompter) (changed bool, err error)
```

**Uniform flow inside `TestAndRepair`:**
1. Read svc creds from `cfg` (via `cfg.GitHub()/Jira()/Slack()`). Missing (accessor "not configured") → skip test, go to prompt (setup-not-repair).
2. `p.Info("Testing X…")` → `Validate(...)`. Valid → `Info("ok")`, return `(false, nil)`.
3. On `ErrAuth` (or missing): `Info("failed")`; if it WAS configured, `p.Confirm("Replace the X credentials?")` — if declined, return `(false, nil)`. (Missing → no confirm; proceed straight to prompt.)
4. `PromptToken`/`PromptSlack` → re-`Validate` the new creds. For Slack, resolve `WorkspaceDomain` via `TeamInfo` on success. Valid → mutate `cfg.Services.X`, return `(true, nil)`. Empty/abort → return `(false, nil)`.
5. **One retry, then give up** (matches existing worktree/handler flows — no infinite loop). A second validation failure → `Info` the error, return `(false, nil)`.
6. Transport (non-`ErrAuth`) error on the initial test → surface it (return the error); do NOT prompt for a new token (creds may be fine, network's down).

**Save ownership:** caller-saves-once. `TestAndRepair` mutates `cfg` only. Consumers run it for github+jira+slack, then call `cfg.Save(config.DefaultPath())` once.

### Layer 3 — Consumers
Each implements `Prompter` with its existing UX and calls `credsetup.TestAndRepair` for all three services, then saves once.
- **worktree** (`internal/setup`): implement `Prompter` over the existing `ui` package (`ui.Confirm`, `ui.PromptSecret`, colored `Info`). Replace `testAndRepairJira`/`promptAndSaveSlack` with `credsetup.TestAndRepair` calls; ADD GitHub. The setup Plan gains "test github/jira/slack" steps that run even when already configured (the whole point). Slack's browser-token acquisition (`extract.mjs` auto path + manual) stays worktree-side behind `PromptSlack` — credsetup only validates + saves the returned token/cookie.
- **handler** (`~/git/agent-ledger`, `cmd/watcher/auth.go` + `installAll`): re-pin watcher v0.2.6→v0.4.0 + `go mod tidy`. Implement `Prompter` over handler's bufio + `confirm()` primitives. Replace `configureGitHub`/`configureJira` (and their local `config/validate.go` calls) with `credsetup.TestAndRepair`; ADD Slack (extend `knownWatchers`, `defaultIntervals`, `runAuth` service list, `isServiceConfigured`, `ServiceConfiguredForWatching` — all currently hardcode github/jira). Handler's Slack `PromptSlack` supplies the token+cookie acquisition instructions (handler has no `extract.mjs`; manual devtools instructions are fine — or share worktree's approach later; out of scope here).

## Slack token acquisition nuance
credsetup does NOT own Slack browser-token extraction (the Playwright/`extract.mjs` auto-path or the manual devtools walkthrough). That stays consumer-side inside each `PromptSlack` implementation. credsetup only: validates the returned (token, cookie), resolves the workspace domain via `TeamInfo`, and writes all three into `cfg.Services.Slack`. This keeps the library free of Playwright/browser concerns.

## Release & cross-repo sequencing
1. Library: add the three `Validate` + `ErrAuth` primitives and the `credsetup` package, with tests. Verify committed tree in isolation. Tag **v0.4.0**, push.
2. worktree: re-pin v0.4.0, implement `Prompter`, rewire setup, add GitHub. Build + test.
3. handler: re-pin v0.2.6→v0.4.0 (+ `go mod tidy`), implement `Prompter`, rewire `cmd/watcher/auth.go`, add Slack. Build + test. **Verify handler's DB migrates cleanly (schema 2→3, the additive `watcher_resource_meta` table) on first run after the jump** — this is a verify step, not a code change.

## Testing
- **Library:** unit-test each `Validate` against a stub HTTP server (valid → nil; 401 → ErrAuth; 500/transport → plain error). `credsetup.TestAndRepair` against a fake `Prompter` + fake validators (injected via a seam — see below): valid-first-try → no prompt, changed=false; ErrAuth → confirm→prompt→revalidate→save-mutation, changed=true; declined confirm → no change; new-creds-also-invalid → one retry then give up; transport error → surfaced, no prompt.
  - **Test seam:** so `credsetup` is unit-testable without live network, the per-service validate must be injectable (e.g. `TestAndRepair` uses an internal `validator` func table defaulting to the real `github.Validate`/`jira.Validate`/`slack.Validate`, overridable in tests). Keep the public signature clean; the seam is internal.
- **worktree:** `Prompter` impl over `ui`; a setup test that a configured-but-invalid cred triggers the repair path (fake prompter). Existing setup tests stay green.
- **handler:** `Prompter` impl over bufio/confirm; the github/jira/slack wiring; DB-migration-clean verification.

## Non-goals
- Slack browser-token extraction in the library (stays consumer-side).
- Changing what the pollers do, or the poll loop.
- A general config-editing UI. This is credential test+repair only.
- Unifying worktree's and handler's overall setup command structure (they stay their own shapes; only the cred flow is shared).
