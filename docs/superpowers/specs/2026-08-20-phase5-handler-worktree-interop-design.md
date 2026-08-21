# Phase 5 — agent-handler ↔ worktree interop — Design

**Status:** Approved in-session 2026-08-20. Ready for implementation planning.

**Repo:** `~/git/agent-ledger` (module `github.com/mturley/agent-handler`) —
**handler-side only.** No watcher-library change, no worktree change (the CLI
contract it depends on already shipped in Phase 1). No DB schema migration.

**Roadmap:** Phase 5 of
`docs/superpowers/specs/2026-08-11-worktree-ui-and-watcher-adoption-roadmap.md`
(this repo). See also the Phase-5 open-question note in the
`watcher-ui-roadmap` memory.

## Goal

Let a running agent-handler session share resource-watching *intent* with the
`worktree` CLI, replacing handler's dead `.worktree-resources` file readers.
When handler runs inside a worktree and the `worktree` binary is present, it:
(a) auto-watches the worktree's **primary** resources at session registration,
and (b) propagates an explicit `/watch` to worktree so its UI/timeline picks
the resource up. Everything degrades gracefully when `worktree` is not
installed — handler-only users are unaffected.

## Load-bearing decisions (brainstorm 2026-08-20)

These correct the original roadmap wording (CC-2 / Phase-5 bullet), which was
written before the semantics were settled. **The decisions below win over the
roadmap text where they differ.**

1. **Separate databases; interop is purely at the CLI level.** handler and
   worktree each own a *separate* watcher DB (same library schema, different
   files). They do **not** share subscription rows. handler never opens
   worktree's DB and vice versa — all integration is handler shelling out to
   the `worktree` binary. (This corrects the earlier mental model of "same DB,
   two subscribers.")

2. **`/unwatch` is handler-only. It must NOT touch worktree's subscriptions.**
   A user may run multiple handler sessions and still want worktree (and other
   sessions) to keep watching a resource that one session unwatches. So
   `/unwatch` stays entirely within handler's own DB (its existing per-session
   `UserUnsubscribe` tombstone). **No worktree CLI call on the unwatch path.**
   This drops the roadmap's "soft-unsubscribe in worktree as
   unsubscribed-by-user" and the primary→related demotion idea — both would let
   one session's action affect worktree's global view.

3. **`/watch` propagates to worktree as PRIMARY by default**, with an opt-in
   `--related` flag on handler's subscribe command that handler passes straight
   through to `worktree resources add --related`. Handler does not otherwise use
   the flag today (it may grow its own primary/related notion later).

4. **Registration auto-watch respects the session's tombstone.** Reading
   worktree's primaries and subscribing uses handler's existing
   `SubscribeIfNew` (IfAbsent) semantics, which already refuse to resurrect a
   user-tombstoned subscription. A resource this session previously
   `/unwatch`ed stays unwatched even if worktree still lists it primary. This
   preserves the current `.worktree-resources` behavior.

5. **Graceful degradation everywhere.** Every worktree interaction is gated on
   `exec.LookPath("worktree")` and is best-effort. Not installed, non-zero
   exit, or malformed output → handler logs and proceeds with its own DB
   unchanged. Not all users run both tools.

## Interop model (directions of flow)

- **Registration (worktree → handler, READ):** handler runs
  `worktree resources list --json`, filters `primary:true`, and auto-watches
  those in *handler's own DB* via `SubscribeIfNew`. Replaces the
  `.worktree-resources` file read at every seam.
- **`/watch <resource>` (handler → worktree, WRITE):** handler subscribes in
  its own DB, then additionally runs `worktree resources add <type> <id>`
  (primary by default; `--related` when the pass-through flag is set) so
  worktree's UI/timeline picks it up.
- **`/unwatch` (handler-only):** handler's DB only (existing tombstone). No
  worktree call.

## worktree CLI contract (already shipped in Phase 1 — no change needed)

Verified in `~/git/worktree/cmd/resources.go`:

- `worktree resources list --json [--worktree <dir>]` → `[{type,id,url,primary}]`
  (`primary = !Related`).
- `worktree resources add <type> <id> [--related] [--url <u>] [--worktree <dir>]`
  — default primary; `--related` flag already present.
- (`unwatch`, `remove` exist but Phase 5 does not call them.)

### Field mapping (worktree JSON → handler subscription)

`{type,id,url}` maps 1:1 to `db.Subscription{ResourceType, ResourceID,
ResourceURL *string}`. URL handling preserves the current backfill:

1. worktree `url` non-empty → use it.
2. empty → `resCfg.DefaultResourceURL(type, id)` (handler's existing backfill,
   `cmd/register.go`).
3. still empty → `ResourceURL = nil` (a `*string`, never `""` — per the
   no-empty-string-fallback rule).

worktree can legitimately emit an empty `url` (a resource added without one),
so the backfill is not dead code.

## Components (all in `~/git/agent-ledger`)

The existing top-level `worktree/` package
(`github.com/mturley/agent-handler/worktree`, currently the `.worktree-resources`
file reader) is **renamed to `worktreeinterop`** (`git mv` to preserve history;
package clause + all importers updated) and repurposed as the CLI client.

**`worktreeinterop/cli.go` (new):**
- `Available() bool` — wraps `exec.LookPath("worktree")` (cmux-precedent
  pattern). All callers gate on this.
- `ListPrimaryResources(dir string) ([]Resource, error)` — runs
  `worktree resources list --json --worktree <dir>`, unmarshals, returns only
  `primary:true`. Any error → `(nil, err)`; callers treat as "no worktree
  integration."
- `AddResource(dir string, r Resource, related bool) error` — runs
  `worktree resources add <type> <id> [--related] [--url <u>] --worktree <dir>`.
  Best-effort; error logged, not fatal.
- `Resource{Type, ID, URL string}` — wire struct mirroring worktree's JSON.
- **Command seam:** an internal overridable runner (`execCommand`/`lookPath`
  package vars) so tests inject fakes.

**`worktreeinterop/resources.go` (retire the file reader):** delete
`ReadResources` / `ParseResourceID` and all `.worktree-resources` format
parsing. Nothing file-based remains.

**Call-site changes (4 read seams + 2 write seams):**
- `cmd/register.go`, `cmd/statusline.go`, `cmd/user_prompt_submit.go` — swap
  `worktree.ReadResources(path)` → `worktreeinterop.ListPrimaryResources(cwd)`
  guarded by `Available()`; the downstream `SubscribeIfNew` loop +
  `DefaultResourceURL` backfill are unchanged.
- `cmd/subscribe.go` — replace the `--persist`-writes-to-file logic with: on
  `/watch`, if `Available()`, call `AddResource(cwd, r, related)`. Add the
  pass-through `--related` flag.
- `cmd/unsubscribe.go` — **remove** the `--persist` file-removal logic entirely;
  `/unwatch` becomes handler-DB-only (no worktree call).

## Error handling & graceful degradation

- **Detection gate:** every call site checks `Available()` first; not installed
  → skip silently, proceed with handler's own DB.
- **Read path (registration):** `ListPrimaryResources` error → treat as "no
  worktree resources," log at debug, continue registration normally. A broken
  worktree CLI must never block registration.
- **Write path (`/watch`):** `AddResource` failure → log a warning; handler's
  own subscribe already succeeded, so `/watch` still reports success. Worktree
  not learning the resource is a soft degradation, not a user-facing error.
- **Not-in-a-worktree:** `worktree resources list --worktree <cwd>` when cwd
  isn't a registered worktree — verify worktree's actual behavior (empty `[]`
  vs. error) during implementation; either way, treat as no resources.
- **No timeouts initially:** local subprocess against local SQLite is fast.
  Add `exec.CommandContext` timeouts only if testing shows a hang risk (e.g.
  worktree DB write-lock contention). Flagged as a watch-item, not built
  speculatively.

## Testing

- **`worktreeinterop` unit tests via the command seam** (fake runner returns
  canned stdout/exit codes, mirroring the credsetup validator seam):
  - `ListPrimaryResources`: mixed primary/related JSON → only primaries; empty
    `[]` → empty slice, no error; non-zero exit → error; malformed JSON →
    error; empty `url` row → passed through empty (backfill is a call-site
    concern).
  - `AddResource`: correct argv for primary vs. `--related`; `--url` only when
    non-empty; non-zero exit → error.
  - `Available()`: seam `lookPath` for found/not-found without host dependency.
- **Call-site tests** (`register`, `subscribe`, `unsubscribe`) using the seam
  + handler's existing temp-DB / `WATCHER_HOME` hermeticity pattern:
  - registration auto-watches worktree primaries via `SubscribeIfNew` and
    **respects a pre-existing tombstone** (subscribe → unwatch → re-register →
    stays unwatched). This is the load-bearing multi-session behavior.
  - `/watch` calls `AddResource` when `Available()`, skips it when not.
  - `/unwatch` makes **zero** worktree calls (fake asserts no invocation).
  - graceful degradation: `Available()==false` and error-returning fakes → all
    call sites still complete their handler-DB work.
- **Manual smoke item (out of unit scope, like prior phases' Slack smoke):**
  real `worktree` installed → register in a worktree, confirm primaries
  auto-watch; `/watch` shows in worktree's UI; `/unwatch` doesn't.

## Release / cross-repo

- **Handler-only.** No watcher-library change, no worktree change, no DB schema
  migration. Single-repo work in `~/git/agent-ledger` → build + test + merge;
  no cross-repo tag/pin dance.
- **Build/install gotcha (from roadmap):** Mike keeps a handler UI server
  running. Before building/installing agent-handler (replacing the running
  binary), **confirm with Mike, then kill the running handler UI server
  first** (a live server holding the binary/DB has caused build/install
  failures), then build/install, then restart it.

## Non-goals

- Any worktree-side or watcher-library change (the CLI contract is complete).
- handler having its own primary/related concept (the `--related` flag is a
  pure pass-through for now; a real handler notion is future work).
- Slack as a handler-watched resource type (that's Phase 6).
- Removing/soft-unsubscribing worktree resources from handler (decision 2).
- A daemon/IPC protocol — interop is one-shot CLI calls only.
