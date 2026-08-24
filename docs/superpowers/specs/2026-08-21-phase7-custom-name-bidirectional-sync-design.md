# Phase 7: Bidirectional custom-name sync (worktree ↔ handler)

**Status:** design — awaiting review
**Date:** 2026-08-21
**Repos:** watcher (library), worktree, agent-handler

## Problem

A resource's user-supplied **custom name** (`watcher_resource_meta.custom_name`)
lives in each consumer's *own* database. worktree and handler have physically
separate watcher DBs (shared schema, never shared rows). Today a custom name set
in one is invisible to the other. We want: **rename a Slack thread in either
tool and the other tool reflects it.**

Constraints (from Mike):

1. **Slack threads only** for this round (PR/Jira names are not synced —
   handler may hold its own for those).
2. **Newest-wins** conflict resolution via a per-resource `updated_at`
   timestamp; only replicate when the names differ and one side's timestamp is
   strictly newer.
3. **Handler interacts with worktree ONLY through the `worktree` CLI.** Handler
   must never open or write worktree's database directly. Handler reads/writes
   its *own* handler.db (via the watcher library on its own connection — that is
   its own database, which is allowed).
4. Fail gracefully when the `worktree` binary is absent (not every handler user
   runs worktree).

## Key correctness point: preserve the source timestamp

Replication must store the **origin** timestamp, not `now()`. If handler stamped
`now()` when pulling worktree's newer name, handler's copy would immediately look
newer and push straight back — an infinite ping-pong. Preserving the source
timestamp makes both sides converge to an identical `(name, updated_at)` pair and
then go quiet (names equal → no action).

Convergence example:
- Handler sets "Release blocker" at `T1`. worktree still has "" at `T0 < T1`.
- Heartbeat: handler newer → `worktree resources set-name … --name "Release blocker" --updated-at T1`. worktree stores `("Release blocker", T1)`.
- Next heartbeat: both `("Release blocker", T1)` → equal → quiet. ✅

## Design

### watcher (library) — new release, re-pin both consumers

`watcher_resource_meta` gains an `updated_at TEXT` column via the existing
additive-column migration path (`ensureAdditiveColumns`) plus a schema-version
bump. Backfill existing rows with the migration timestamp.

API (`db/resourcemeta.go`):

```go
type ResourceMeta struct {
    CustomName        string
    CustomDescription string
    UpdatedAt         string // RFC3339 UTC; "" only for pre-migration rows never rewritten
}

// SetResourceMetaAt upserts with an explicit timestamp (used for replication —
// stores the ORIGIN timestamp so cross-DB sync converges).
func SetResourceMetaAt(conn *sql.DB, r watcher.Resource, name, description, updatedAt string) error

// SetResourceMeta upserts, stamping updated_at = now() (interactive/local edits).
func SetResourceMeta(conn *sql.DB, r watcher.Resource, name, description string) error // = SetResourceMetaAt(..., now())
```

`GetResourceMeta` returns `UpdatedAt`.

Cross-repo dance (per CLAUDE.md): change + test in `~/git/watcher`, commit, tag
`vX.Y.Z`, push `main` + tag, then `go get …@vX.Y.Z && go mod tidy` in worktree and
handler.

### worktree

- Re-pin the new library.
- `resources list --json` DTO gains `custom_name`, `custom_description`,
  `updated_at` (additive; existing `type`/`id`/`url`/`primary` unchanged).
- New CLI: `worktree resources set-name <type> <id> --name <name>
  [--description <desc>] [--updated-at <rfc3339>] [--worktree <dir>]`.
  - Thin wrapper over `internal/resources` → `SetResourceMetaAt`.
  - `--updated-at` omitted → stamp `now()` (interactive use).
  - Handler always passes `--updated-at` with its origin timestamp.
  - `--name`/`--description` semantics mirror the web UI setter (empty string
    clears a field).

### handler

- Re-pin the new library.
- `worktreeinterop`:
  - `listItem`/`Resource` gain `CustomName`, `CustomDescription`, `UpdatedAt`.
  - `ListResources(dir) ([]Resource, error)` — **all** resources (a Slack thread
    may be "related", not primary). `ListPrimaryResources` stays for
    auto-subscribe.
  - `SetName(dir string, r Resource, name, description, updatedAt string) error`
    — shells `worktree resources set-name … --updated-at <ts>`; best-effort.
- Heartbeat sync step (in the statusline heartbeat block), **throttled**,
  **best-effort**, gated on `worktreeinterop.Available()`:
  - Throttle: skip if a marker file (`<data-dir>/last-name-sync`) was touched
    < 60s ago; otherwise touch it and proceed. (No schema change.)
  - `dir = session.CWD`. `ws := worktreeinterop.ListResources(dir)` (any error →
    silent return).
  - For each `r` in `ws` where `r.Type == "slack"`:
    - `h := wdb.GetResourceMeta(handlerConn, r.Type, r.ID)` (handler's own DB).
    - Compare `(name, updated_at)`:
      - names equal → nothing.
      - names differ, `r.UpdatedAt` newer than `h.UpdatedAt` → worktree wins →
        `wdb.SetResourceMetaAt(handlerConn, r, r.CustomName, r.CustomDescription, r.UpdatedAt)` (own DB).
      - names differ, `h.UpdatedAt` newer → handler wins →
        `worktreeinterop.SetName(dir, r, h.CustomName, h.CustomDescription, h.UpdatedAt)`.
      - equal timestamps but different names (rare tie): worktree wins
        (deterministic; avoids ping-pong).
    - Missing `updated_at` on either side (pre-migration "") sorts oldest.

### handler — fallback title from cached first message (local, no worktree)

Independent of the sync, handler should display a resource's name the way
worktree's UI already does: **custom name if set, else a fallback title cached
from the thread's first message.** This needs no worktree interaction — the
Slack poller (Phase 6) already writes `fallbackTitle(root message)` into
handler's own `watcher_resource_state.state_json["title"]` (same
`slack/fallbacktitle.go` logic worktree uses), and handler runs its own poller.

Change: in handler's resources API (`cmd/api/resources.go`), for each resource
also read `wdb.GetResourceMeta` (its own DB) and resolve a display title:

```
display_title = custom_name (meta)  ||  state["title"] (cached first message)  ||  resource_id
```

Surface `custom_name` and the resolved `display_title` in the resource DTO and
render `display_title` in the handler web UI. This closes the loop: once the
sync mirrors a Slack rename, handler shows the new custom name; before any
rename, handler shows the cached first-message title instead of a bare id.

#### Statusline: show + truncate the Slack thread title

`cmd/statusline.go`'s `shortResourceLabel` returns the raw resource id today —
for a Slack thread that is an unreadable `channel:threadTS`. Resolve the same
`display_title` (custom_name → cached `state["title"]` → id) and show it,
**truncated short**, with the width adapting to how many Slack threads the
session watches:

- watching **one** Slack thread → truncate to ~28 runes.
- watching **more than one** → truncate to ~14 runes each, so the line stays
  compact.

Reuse rune-safe truncation with a trailing ellipsis (the `fallbackTitle` style).
`shortResourceLabel` gains the resolved title and the watched-Slack-count as
inputs (compute the count once from `subs`); non-Slack labels are unchanged. The
widths are constants, easy to tune.

(Aside noted for implementation: `cmd/api/resources.go`'s `watchers` map is
still hardcoded `{"github","jira"}` — the Phase 6 `KnownWatchers` hoist did not
reach this web-API site, so the resources page omits the Slack watcher's status.
Fold the fix in here.)

## Non-goals

- No user-facing handler command to *set* a custom name yet (Mike adds that
  later). The two-way plumbing is complete regardless; until a handler-side edit
  exists, only the worktree→handler direction fires in practice.
- No sync for PR/Jira custom names.
- No real-time push — sync rides the existing statusline heartbeat.

## Testing

- **watcher:** migration adds column + backfills; `SetResourceMetaAt` stores the
  given ts; `SetResourceMeta` stamps now; `GetResourceMeta` round-trips
  `UpdatedAt`. `go test ./...`.
- **worktree:** `resources list --json` includes the new fields;
  `resources set-name` with/without `--updated-at` writes the expected row
  (assert stored ts); clearing via empty `--name`.
- **handler:** `worktreeinterop` parses new fields; `ListResources` returns
  related + primary; `SetName` emits the exact argv incl. `--updated-at`. Sync
  unit test with a fake worktree CLI (existing `SetSeamsForTest`) covering all
  three branches + convergence (a second pass is a no-op).
- **fallback title:** resources API returns `display_title` = custom_name →
  cached `state["title"]` → id, across the three cases.
- **statusline:** `shortResourceLabel` shows the resolved Slack title truncated
  to the single-thread width with one thread watched and to the multi-thread
  width with two+; non-Slack labels unchanged.
- **End-to-end (real Slack):** track one real thread in **both** tools
  (`worktree add <url>` + a handler subscription to the same thread), rename it
  in worktree's UI → confirm handler reflects it next heartbeat; rename via
  `worktree resources set-name` with a future ts → confirm it sticks; confirm
  handler shows the cached first-message title before any rename. Mike can point
  this session at a real thread to follow.

## Rename cleanup (`~/git/agent-ledger` → `~/git/agent-handler`)

Same change: update the active memory file with a rename note; leave historical
specs/plans/brainstorm docs and stale `settings.local.json` permission grants as
historical record (harmless).
