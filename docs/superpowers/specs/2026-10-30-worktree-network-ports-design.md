# Worktree listening ports ("Network") — design

Date: 2026-10-30

## Why

Mike runs dev servers in many worktrees at once and loses track of them:
he leaves one running and forgets it, forgets he closed one, or hits a port
conflict and has to work out which worktree owns the port. Today the only
way to answer "what is this worktree listening on?" is `lsof` by hand.

The web UI should show, live, which TCP ports each worktree's processes are
listening on, and flag any port outside the worktree's reserved range
(`internal/ports`), since those are where conflicts come from.

## Goals

- Show every TCP port a worktree's processes are listening on — including
  ports outside its reserved range — in three places:
  1. **Environment tab, new "Network" column** on the worktree detail card
     (`WorktreeDetailCard.tsx`).
  2. **Environment tab label badge**: comma-separated active ports.
  3. **Home page worktree card** (`WorktreeCard.tsx`): a "Listening on 4091,
     4093" line directly after the Repo/Branch line.
- **Out-of-range ports are red everywhere they appear** (Network rows, badge,
  card line).
- Starting or stopping a dev server is reflected within one scan interval,
  with no new frontend polling and no refetch churn when nothing changed.

## Non-goals

- Killing processes from the UI.
- History of what was listening, or notifications when a server starts/stops.
- Container-published ports (Docker/podman: the listener is the runtime's
  proxy process, whose cwd says nothing about the worktree).
- UDP listeners.
- Listeners not attributable to any registered worktree (typically
  `worktree ui` itself, `handler`, `adb`, which run from outside worktrees)
  — shown nowhere. There is deliberately **no exclusion list**: if such a
  process *is* attributed to a worktree (e.g. `make dev` of this repo run in
  one of its worktrees, or `handler ui` started from a worktree's shell), it
  is shown there, because that worktree really did launch it. (Claude's call.)
- The mini view / menu bar app: it does not show listeners.
- Linux support for the scanner beyond what `lsof` gives for free (macOS is
  the target; see Constraints).

## Anti-goals

- A new frontend polling loop. The data rides the existing `/api/stream`.
- Scanning while nobody is looking: no listener-consuming UI stream open →
  no `lsof` runs. The menu bar app's mini view keeps its stream open
  permanently, so it must not count (see Scanning and delivery).
- Persisting this in the DB. It is live process state, held in memory only.
- Churn: a scan whose result equals the previous one sends nothing.

## Constraints

- Process spawns are expensive on Mike's machine (~100ms each, throughput
  limited machine-wide; see CLAUDE.md "Writing Go tests"). Measured: listing
  listeners (`lsof -nP -iTCP -sTCP:LISTEN`) ≈ 0.1s; cwd of *every* process
  ≈ 0.4s. So the scan fetches cwd only for the listening PIDs (and, for the
  fallback, their ancestors), in batched `lsof -p pid1,pid2,… -d cwd` calls —
  about three spawns per scan, never one per PID.
- Paths must be canonicalized (`Abs → EvalSymlinks → Clean`) on both sides
  before matching, as `cmux.Match` does: `lsof` reports real paths, registry
  paths may go through a symlink.
- Hidden tabs over plain HTTP close their streams (`lib/backgroundStreams.ts`)
  and reopen on reshow; the design must deliver current state on (re)connect.
- Parallel-by-default Go tests (CLAUDE.md): the scanner must be injectable per
  `Server` (a `Server` field, not a package global) so tests never spawn
  `lsof`.

## Decided behaviour

### Attribution (server)

A listener belongs to a worktree when its process's cwd is the worktree path
or inside it. If the process's own cwd is not inside any worktree, walk its
parent chain (`ps -axo pid=,ppid=`, one spawn) and use the first ancestor
whose cwd is — so a server started from an mprocs pane or shell in the
worktree still counts. Stop at PID 1. If worktrees are nested, the deepest
(longest) matching path wins.

### Per-port record

One entry per (worktree, port). If the same port is bound on several
addresses (IPv4 + IPv6, or by several processes), it is still one row;
the row lists its addresses. Fields:

- `port` (int)
- `addresses` ([]string, e.g. `["[::1]"]`, `["*"]`, `["127.0.0.1"]`)
- `pid` (int) and `process` (command name) — if several processes share the
  port, the lowest PID is shown (builder may refine)
- `in_range` (bool) — `false` when outside the worktree's allocation

Reserved range lookup: `ports.Lookup(conn, filepath.Base(wt.Path))`, as
`shellenv.Lines` does. **A worktree with no allocation has no range to
violate: its ports are shown uncoloured (`in_range: true`), and the Network
header says "No reserved range".**

Ports are sorted numerically everywhere.

### Scanning and delivery

- A background scanner on the `Server` runs every **10 seconds**, but only
  while at least one *listener-consuming* `/api/stream` is open
  (reference-counted by subscriptions to the listeners hub; starts on the
  first, stops after the last closes).
- **The mini view's stream does not consume listeners** (Mike's decision):
  it opts out (e.g. a stream query param such as `listeners=0`, set by
  `MiniApp`'s use of `useSSE`; builder picks the mechanism). An opted-out
  stream neither subscribes to the hub nor counts toward keeping the scanner
  running, and receives no `listeners_changed` events. Ordinary tabs —
  including hidden HTTPS tabs, whose streams stay open — do count.
- It builds the full snapshot: `map[worktreePath][]portEntry` plus the
  reserved range string of **every registered worktree** (even those with
  nothing listening, since the Network header shows it), and compares it to
  the previous snapshot.
- On change, it publishes a `listeners_changed` stream event whose payload is
  the **whole snapshot**. Fan-out follows the existing `cmuxFocusHub` pattern
  (`internal/webui/cmux_focus.go`): buffered, non-blocking sends; a stalled
  stream misses an update that a later one supersedes.
- **A newly connected stream immediately receives the current snapshot** (if
  one exists), so reconnects/reshows are correct without a refetch. If no
  snapshot exists yet (first stream just started the scanner), it arrives
  when the first scan completes — the scanner should scan immediately on
  start, not wait 10s.
- If a scan fails (`lsof` error), keep the last good snapshot, log the error
  via `s.logger()`, show nothing to the user.
- Worktrees with nothing listening are omitted from the map (or empty);
  the frontend treats absent and empty the same.

### Settings toggle (added by Mike after approval)

- New config key **`ui.port_scan_disabled`** in worktree's `config.yaml`
  (bool, `omitempty`; absent means enabled — same pattern as
  `ui.cmux_features_disabled`). Default: scanning **enabled**.
- Settings modal, **General** tab: a switch **"Scan for listening ports"**
  (checked = enabled), following the "Enable cmux features" switch.
- Takes effect live, without restarting `worktree ui`: turning it off stops
  scanning at once and publishes a snapshot with `enabled: false`; turning
  it on scans immediately.
- While off: the badge and card line are hidden, and the Network column
  says "Port scanning is off." with an "Enable it in Settings" link that
  opens the Settings modal on the General tab (Mike's request)
- Follows CLAUDE.md "Config files ↔ Settings modal" (editable.go, DTO/PUT,
  `settingsKeyPaths`, types.ts, `tabDirty.ts`, tests) and must be carried by
  `internal/setup`'s `uiYaml` copy so `worktree setup` doesn't drop it.

### Frontend

- `useSSE` handles `listeners_changed` by writing the payload into a
  page-wide store (e.g. `qc.setQueryData(["listeners"], payload)` with no
  queryFn fetch, or a small store like `cmuxFocusBus`). All three surfaces
  read from it via a hook such as `useListeners(path)`.
- **Environment tab layout**: two columns — env vars on the left (existing
  `EnvVarRow` list), **Network on the right**; on narrow/mobile widths the
  Network column collapses below the env vars (follow the project's
  existing responsive approach; see `docs/web-ui-architecture.md`
  "Responsiveness").
- The pushed payload carries `enabled` (the toggle's state) alongside
  `ports` and `ranges`.
- **Network column**:
  - Header with the reserved range ("Reserved 4090–4099", or "No reserved
    range").
  - One row per port: port number (red if `!in_range`), addresses, process
    name and PID, a **copy-PID-to-clipboard button**, and an **"open in
    browser" button** that opens `http://localhost:PORT` in a new tab.
  - Empty state: "Nothing listening".
- **Tab badge**: on the Environment tab label, comma-separated port numbers,
  each red if out of range; hidden when nothing is listening. Same `Badge`
  styling as the Code tab's badge.
- **Home card line**: "Listening on 4091, 4093" after the Repo/Branch line,
  out-of-range numbers red; hidden when nothing is listening.

"Open in browser" always targets `localhost`. From a phone over remote
access it would point at the phone; accepted — most dev servers bind only
`[::1]` and aren't reachable remotely anyway.

## Left to the builder

- File/package layout (e.g. a small `internal/listeners` package holding the
  pure parse + attribute logic, with the scanner/hub in `internal/webui`).
- Exact `lsof -F` field parsing and the batching of the cwd lookups.
- Whether the frontend store is TanStack query data or a tiny bus.
- Exact visual styling of the column, rows and buttons, within Mantine and
  the card's existing look.
- Updating `docs/web-ui-architecture.md` (SSE section, Environment tab,
  WorktreeCard) and CLAUDE.md's package list if a new package is added.

## Testing expectations

- Pure attribution logic (lsof output + process tree + worktree list →
  snapshot) unit-tested from synthetic fixtures: cwd match, ancestor
  fallback, nested worktrees, symlinked worktree path, IPv4+IPv6 dedupe,
  no allocation, out-of-range.
- Scanner/hub tested with an injected fake scan function: scans only while a
  stream is subscribed, publishes only on change, new subscriber gets the
  current snapshot, failed scan keeps the last snapshot.
- Frontend tests for the three surfaces, including red for out-of-range and
  hidden-when-empty.
