# Phase 7: Bidirectional custom-name sync (worktree ↔ handler) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share a Slack thread's custom name between worktree and handler (each has its own watcher DB) via newest-wins timestamp sync over the worktree CLI, and show a cached first-message fallback title in handler.

**Architecture:** Add `updated_at` to the library's `watcher_resource_meta` with a timestamp-preserving setter (new release). worktree exposes the meta fields in `resources list --json` and gains a `resources set-name` CLI. handler's statusline heartbeat does a throttled, best-effort, newest-wins sync per Slack resource — reading/writing its own DB and reaching worktree only through the CLI — and resolves a display title (custom_name → cached `state["title"]` → id) in its resources API + statusline.

**Tech Stack:** Go (watcher lib, worktree, agent-handler), SQLite, cobra CLI.

**Spec:** `docs/superpowers/specs/2026-08-21-phase7-custom-name-bidirectional-sync-design.md`

## Global Constraints

- **Separate DBs, shared schema only.** handler must NEVER open or write worktree's DB. handler↔worktree interop is CLI-only (`worktree` binary via `worktreeinterop`); handler reads/writes only its own handler.db via the watcher library on its own conn.
- **Preserve the source timestamp on replication** — never stamp `now()` when copying a name across DBs, or the two sides ping-pong. Interactive/local edits stamp `now()`; replication passes the origin `updated_at` through.
- **Slack threads only** this round (no PR/Jira name sync).
- **Best-effort + graceful** when `worktree` is absent (`worktreeinterop.Available()` gate); any error → silent no-op, session proceeds.
- **Never write to Slack.** Read-only.
- Commit with `--signoff`. Cross-repo release dance per each repo's CLAUDE.md: change+test in `~/git/watcher`, commit, tag `vX.Y.Z`, push main+tag, then `go get …@vX.Y.Z && go mod tidy` in worktree and handler.
- Slack fallback-title truncation reuses the existing `fallbackTitle` rune-safe style (collapse whitespace, trim, truncate, trailing `…`).

---

## Task 1: watcher — add `updated_at` to resource meta + timestamp-preserving setter

**Files:**
- Modify: `~/git/watcher/db/resourcemeta.go`
- Modify: `~/git/watcher/db/schema.go` (add column to `watcher_resource_meta` DDL; bump `CurrentSchemaVersion`; ensure `ensureAdditiveColumns` covers the new column)
- Modify/Create test: `~/git/watcher/db/resourcemeta_test.go`

**Interfaces:**
- Produces: `SetResourceMetaAt(conn *sql.DB, r watcher.Resource, name, description, updatedAt string) error`; `SetResourceMeta(conn, r, name, description) error` (= `SetResourceMetaAt` with `now()`); `ResourceMeta{CustomName, CustomDescription, UpdatedAt string}`; `GetResourceMeta` returns `UpdatedAt`.

- [ ] **Step 1: Write failing tests** — (a) after `Migrate`, `watcher_resource_meta` has an `updated_at` column (query `PRAGMA table_info`); (b) `SetResourceMetaAt(conn, r, "N", "D", "2020-01-02T03:04:05Z")` then `GetResourceMeta` returns `UpdatedAt == "2020-01-02T03:04:05Z"`; (c) `SetResourceMeta(conn, r, "N", "D")` sets a non-empty RFC3339 `UpdatedAt` close to now; (d) an existing DB migrated from the prior version backfills `updated_at` non-empty for a pre-existing row.
- [ ] **Step 2: Run tests, verify they fail.** Run: `cd ~/git/watcher && go test ./db/ -run ResourceMeta -v` — expect compile/assert failures.
- [ ] **Step 3: Implement.**
  - `schema.go`: add `updated_at TEXT` to the `watcher_resource_meta` CREATE; add it to the additive-columns map so existing DBs get `ALTER TABLE … ADD COLUMN updated_at TEXT`; backfill existing NULL/empty rows to the migration timestamp; bump `CurrentSchemaVersion` and the column list constant if `watcher_resource_meta` is enumerated there.
  - `resourcemeta.go`: add `UpdatedAt` to `ResourceMeta`; write `SetResourceMetaAt` (upsert incl. `updated_at = ?`); make `SetResourceMeta` call it with `time.Now().UTC().Format(time.RFC3339)`; update `GetResourceMeta` SELECT + Scan to include `updated_at`.
- [ ] **Step 4: Run tests, verify pass.** Run: `cd ~/git/watcher && go test ./...`
- [ ] **Step 5: Commit.** `git -C ~/git/watcher commit -s -am "feat(db): add updated_at to resource meta + timestamp-preserving SetResourceMetaAt"`

## Task 2: watcher — release + re-pin both consumers

**Files:** `~/git/watcher` tag; `~/git/worktree/go.mod`, `~/git/agent-handler/go.mod`

- [ ] **Step 1:** Confirm `go test ./...` green in `~/git/watcher`.
- [ ] **Step 2:** Determine next tag from `git -C ~/git/watcher tag | sort -V | tail`. Tag and push: `git -C ~/git/watcher tag vX.Y.Z && git -C ~/git/watcher push origin main && git -C ~/git/watcher push origin vX.Y.Z`.
- [ ] **Step 3:** Re-pin worktree: `cd ~/git/worktree && go get github.com/mturley/watcher@vX.Y.Z && go mod tidy && go build ./... && go test ./...`
- [ ] **Step 4:** Re-pin handler: `cd ~/git/agent-handler && go get github.com/mturley/watcher@vX.Y.Z && go mod tidy && go build ./... && go test ./...`
- [ ] **Step 5: Commit** the `go.mod`/`go.sum` bumps in each repo (separately, `-s`).

## Task 3: worktree — expose meta fields in `resources list --json`

**Files:**
- Modify: `~/git/worktree/cmd/resources.go` (the list `--json` DTO)
- Modify test: `~/git/worktree/cmd/resources_test.go`

**Interfaces:**
- Produces: JSON list items now carry `custom_name`, `custom_description`, `updated_at` alongside existing `type`,`id`,`url`,`primary`. `internal/resources.Resource` already has `CustomName`/`CustomDescription`; `UpdatedAt` flows from `GetResourceMeta` (Task 1) via `internal/resources` — add `UpdatedAt` to that struct + its loader if not already present.

- [ ] **Step 1: Write failing test** — `resources list --json` for a worktree with one resource that has a custom name emits `"custom_name":"…"` and `"updated_at":"…"`.
- [ ] **Step 2: Run, verify fail.** `cd ~/git/worktree && go test ./cmd/ -run Resources -v`
- [ ] **Step 3: Implement** — add `UpdatedAt` to `internal/resources.Resource` and populate it from `meta.UpdatedAt` in `resources.go`'s loader; add `CustomName`/`CustomDescription`/`UpdatedAt` to the CLI list DTO in `cmd/resources.go`.
- [ ] **Step 4: Run, verify pass.** `go test ./...`
- [ ] **Step 5: Commit** `-s`.

## Task 4: worktree — `resources set-name` CLI

**Files:**
- Modify: `~/git/worktree/cmd/resources.go` (new subcommand)
- Modify: `~/git/worktree/internal/resources/resources.go` (add `SetMetaAt` if only `SetMeta` exists)
- Modify test: `~/git/worktree/cmd/resources_test.go`

**Interfaces:**
- Produces CLI: `worktree resources set-name <type> <id> --name <name> [--description <desc>] [--updated-at <rfc3339>] [--worktree <dir>]`. Omitted `--updated-at` → stamp now (calls `SetResourceMeta`); provided → `SetResourceMetaAt`. Empty `--name` clears the name (mirror web UI semantics).

- [ ] **Step 1: Write failing test** — `resources set-name slack CH:TS --name "Hello" --updated-at 2030-01-01T00:00:00Z` writes a meta row whose `custom_name=="Hello"` and `updated_at=="2030-01-01T00:00:00Z"` (assert via `resources list --json` or `GetResourceMeta`). Second case: without `--updated-at`, `updated_at` is non-empty/near-now.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add `internal/resources.SetMetaAt(conn, type, id, name, desc, updatedAt)` calling `watcherdb.SetResourceMetaAt`; keep `SetMeta` → `SetResourceMeta`. Wire the cobra subcommand with the four flags, resolving the worktree conn like the other `resources` subcommands.
- [ ] **Step 4: Run, verify pass.** `go test ./...`
- [ ] **Step 5: Commit** `-s`.

## Task 5: handler — `worktreeinterop` parses new fields + `ListResources` + `SetName`

**Files:**
- Modify: `~/git/agent-handler/worktreeinterop/cli.go`
- Modify test: `~/git/agent-handler/worktreeinterop/*_test.go` (or `cmd/*_test.go` seam tests)

**Interfaces:**
- Produces: `Resource` gains `CustomName`, `CustomDescription`, `UpdatedAt`; `listItem` parses `custom_name`,`custom_description`,`updated_at`. `ListResources(dir string) ([]Resource, error)` returns ALL resources (not primary-filtered), carrying meta. `SetName(dir string, r Resource, name, description, updatedAt string) error` shells `worktree resources set-name <type> <id> --name <name> [--description <d>] --updated-at <updatedAt> --worktree <dir>` (always passes `--updated-at`); best-effort.

- [ ] **Step 1: Write failing tests** (using `SetSeamsForTest`) — (a) `ListResources` parses a JSON blob with `custom_name`/`updated_at` and returns both primary and related items; (b) `SetName` invokes the exact argv incl. `--updated-at <ts>` and `--worktree <dir>`; empty description omits `--description`.
- [ ] **Step 2: Run, verify fail.** `cd ~/git/agent-handler && go test ./worktreeinterop/... ./cmd/... -run 'ListResources|SetName' -v`
- [ ] **Step 3: Implement** — extend `listItem`/`Resource`; add `ListResources` (like `ListPrimaryResources` minus the primary filter, carrying meta); add `SetName`.
- [ ] **Step 4: Run, verify pass.** `go test ./...`
- [ ] **Step 5: Commit** `-s`.

## Task 6: handler — throttled newest-wins Slack name sync in the heartbeat

**Files:**
- Create: `~/git/agent-handler/cmd/namesync.go` (`syncSlackNames(d *db.DB, cwd string, now string)` + throttle helper)
- Modify: `~/git/agent-handler/cmd/statusline.go` (call it from the heartbeat block, near `autoSubscribeWorktreePrimaries`)
- Create test: `~/git/agent-handler/cmd/namesync_test.go`

**Interfaces:**
- Consumes: `worktreeinterop.Available/ListResources/SetName` (Task 5); `wdb.GetResourceMeta`/`wdb.SetResourceMetaAt` on handler's own conn (`d.Conn()`); a throttle marker file under `filepath.Dir(db.DefaultPath())`.
- Produces: `syncSlackNames(d, cwd, now)` — best-effort, returns nothing (logs at debug only). Newest-wins per Slack resource:
  - `w.UpdatedAt` strictly newer than handler's → `wdb.SetResourceMetaAt(d.Conn(), r, w.CustomName, w.CustomDescription, w.UpdatedAt)`.
  - handler's strictly newer → `worktreeinterop.SetName(cwd, r, h.CustomName, h.CustomDescription, h.UpdatedAt)`.
  - equal timestamps, differing names → worktree wins (write handler's own DB), deterministic.
  - equal names → no-op. Empty `updated_at` sorts oldest.

- [ ] **Step 1: Write failing tests** (fake worktree CLI via `SetSeamsForTest`, real temp handler DB) —
  - worktree newer → handler's meta updated to worktree's name+ts; no `set-name` call.
  - handler newer → exactly one `set-name` call with handler's name+ts; handler's own meta unchanged.
  - equal name → zero writes, zero `set-name` calls.
  - **convergence:** after a worktree-newer apply, a second `syncSlackNames` pass makes no writes and no CLI calls.
  - non-slack resources are ignored.
  - throttle: two calls within the window → the second is a no-op (assert via a call counter).
- [ ] **Step 2: Run, verify fail.** `cd ~/git/agent-handler && go test ./cmd/ -run SlackNameSync -v`
- [ ] **Step 3: Implement** `namesync.go` — throttle via marker-file mtime (skip if < 60s; else touch + proceed); gate on `worktreeinterop.Available()`; `ListResources(cwd)`; loop Slack resources; compare RFC3339 strings (lexicographic works for same-format UTC; guard empties as oldest); apply per the rules. Wire the call into the statusline heartbeat (worker sessions, when `cwd` is set).
- [ ] **Step 4: Run, verify pass.** `go test ./...`
- [ ] **Step 5: Commit** `-s`.

## Task 7: handler — resources API fallback title + `custom_name` + slack watcher status

**Files:**
- Modify: `~/git/agent-handler/cmd/api/resources.go` (add `custom_name`, `display_title`; fix `watchers` map)
- Modify test: `~/git/agent-handler/cmd/api/*_test.go`
- Modify (frontend, if handler web UI renders resource names): handler UI resource list to render `display_title`.

**Interfaces:**
- Produces DTO fields: `custom_name` (from `wdb.GetResourceMeta`), `display_title` = `custom_name` → `state["title"]` → resource id. `watchers` map keyed by `watcher.KnownWatchers` (adds `slack`).

- [ ] **Step 1: Write failing test** — resources endpoint returns `display_title == "Custom"` when meta set; `== state title` when only cached title; `== id` when neither; response `watchers` includes `slack`.
- [ ] **Step 2: Run, verify fail.** `cd ~/git/agent-handler && go test ./cmd/api/ -run Resources -v`
- [ ] **Step 3: Implement** — in the enrich loop, `GetResourceMeta` per resource; compute `display_title`; add both fields to `resourceEntry`; replace the hardcoded `{"github","jira"}` `watchers` map with a loop over `watcher.KnownWatchers` (`buildWatcherStatus` per name). If the handler web UI shows a name, render `display_title`.
- [ ] **Step 4: Run, verify pass.** `go test ./...`
- [ ] **Step 5: Commit** `-s`.

## Task 8: handler — statusline shows + truncates the Slack title

**Files:**
- Modify: `~/git/agent-handler/cmd/statusline.go` (`shortResourceLabel` + its caller; add a fallback-title resolver + rune-safe truncate helper)
- Modify test: `~/git/agent-handler/cmd/statusline_test.go`

**Interfaces:**
- Consumes: resolved display title per Slack resource (custom_name → cached `state["title"]` → id) from handler's own DB; count of watched Slack subs.
- Produces: `shortResourceLabel` (or a new `slackLabel`) returns the truncated title — `slackTitleWidthSingle = 28`, `slackTitleWidthMulti = 14`; multi width applies when the session watches ≥2 Slack threads. Non-slack labels unchanged.

- [ ] **Step 1: Write failing tests** — a rune-safe `truncateTitle(s, n)` (trims, appends `…` when over n, counts runes not bytes); label for a slack resource with 1 slack sub uses width 28, with 2+ uses width 14; PR/jira labels unchanged.
- [ ] **Step 2: Run, verify fail.** `cd ~/git/agent-handler && go test ./cmd/ -run 'ShortResourceLabel|TruncateTitle|SlackLabel' -v`
- [ ] **Step 3: Implement** — compute the watched-slack count once from `subs`; for slack subs resolve the title from meta/state (own DB) and truncate with the width chosen by the count; leave PR/jira paths as-is.
- [ ] **Step 4: Run, verify pass.** `go test ./...`
- [ ] **Step 5: Commit** `-s`.

## Task 9: skills + rename cleanup + docs

**Files:**
- Already edited (uncommitted): `~/git/agent-handler/skills/{watch,unwatch,watching}/SKILL.md` (Slack support).
- Modify: memory `~/.claude-personal/projects/-Users-mturley-git-worktree/memory/watcher-ui-roadmap.md` (Phase 7 entry + agent-ledger→agent-handler rename note).
- Modify: `~/git/agent-handler/CLAUDE.md` and/or `~/git/worktree/.claude/CLAUDE.md` if they need a Phase 7 / name-sync note.

- [ ] **Step 1:** Commit the three skill edits in agent-handler (`-s`).
- [ ] **Step 2:** Add a Phase 7 memory entry + a one-line note that `~/git/agent-ledger` was renamed to `~/git/agent-handler`.
- [ ] **Step 3:** Skim the CLAUDE.md files; add a brief note about the custom-name sync + `resources set-name` CLI if warranted.

## Task 10: Build, reinstall, end-to-end real-Slack test

**Files:** none (verification).

- [ ] **Step 1:** `cd ~/git/worktree && make build`; `cd ~/git/agent-handler && make build` (or the repo's build). Reinstall handler (kill running handler UI first, confirm with Mike, restart after) so the updated skills + binary land.
- [ ] **Step 2:** Ensure the test thread `slack:C069KSM8T9N:1787257539.775119` is tracked in BOTH tools (`worktree add <url>` + the existing handler subscription). Let each side poll once so the cached first-message title populates.
- [ ] **Step 3:** Confirm handler shows the cached first-message title (statusline + resources API) before any rename.
- [ ] **Step 4:** Rename the thread in worktree's UI → wait a heartbeat → confirm handler reflects the new name (statusline + resources API). Confirm a second heartbeat is a no-op (convergence).
- [ ] **Step 5:** `worktree resources set-name slack C069KSM8T9N:1787257539.775119 --name "…" --updated-at <future ts>` → confirm handler picks it up; then confirm handler-newer direction by setting handler's own meta with a newer ts (temporary test setter or direct `SetResourceMetaAt` on handler.db in a throwaway harness) → confirm `worktree resources list --json` shows it. Confirm statusline truncation with 1 vs 2 watched Slack threads.
- [ ] **Step 6:** Report results. Never post to Slack.

## Self-Review notes

- Spec coverage: library updated_at + setter (T1/T2), worktree list fields (T3) + set-name (T4), interop (T5), sync (T6), fallback title/API + watchers-map fix (T7), statusline truncation (T8), skills+rename (T9), e2e (T10). ✓
- Timestamp preservation enforced in T1 (setter), T5 (`SetName` always passes `--updated-at`), T6 (apply uses source ts). ✓
- CLI-only + own-DB-only invariant lives entirely in T6 (no direct worktree DB access anywhere in handler). ✓
