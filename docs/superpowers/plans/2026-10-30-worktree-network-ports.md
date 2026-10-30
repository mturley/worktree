# Worktree Listening Ports ("Network") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, live, which TCP ports each worktree's processes listen on — in a Network column on the Environment tab, a badge on that tab, and a "Listening on …" line on home cards — with out-of-range ports in red, behind a Settings toggle.

**Architecture:** A pure `internal/listeners` package parses `lsof`/`ps` output and attributes listeners to worktrees (cwd, then ancestor cwd). `internal/webui` runs a 10s scan loop only while a listener-consuming `/api/stream` is open, and pushes the whole snapshot as a `listeners_changed` stream event when it changes (and to each new stream on connect). The frontend keeps it in a tiny external store read by three components.

**Tech Stack:** Go (stdlib `os/exec`), SQLite via existing `registry`/`ports`; React + Mantine + vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-worktree-network-ports-design.md`

## Global Constraints

- Scan interval: **10 seconds**; scan immediately when the loop starts.
- Scan only while ≥1 listener-consuming stream is open; the mini view's stream (`isMiniRoute()`) opts out with `listeners=0`.
- Commands (exactly three spawns per scan at most): `lsof -nP -iTCP -sTCP:LISTEN -F pcn`, `ps -axo pid=,ppid=`, and batched `lsof -a -p <pid,pid,…> -d cwd -F pn` (at most two batches: listeners, then their ancestors). Never one spawn per PID.
- `lsof` exits 1 when it finds nothing: exit 1 with empty stdout is an empty result, not an error.
- Path matching canonicalizes worktree paths (`Abs → EvalSymlinks → Clean`; on EvalSymlinks error fall back to `Clean(Abs)`), keyed by the registry's original path. A cwd matches a worktree when it equals the path or starts with path + `/`. Deepest match wins.
- Worktree with no port allocation → every port `in_range: true`, header "No reserved range".
- Copy (exact): "Network", "Reserved 4090–4099" (en dash), "No reserved range", "Nothing listening", "Listening on " + comma-space-separated ports, "Port scanning is off." followed by an "Enable it in Settings" link, Settings switch label "Scan for listening ports".
- Out-of-range ports render red (Mantine `c="red"`) everywhere: Network rows, tab badge, card line.
- Config key `ui.port_scan_disabled` (bool, `yaml:"port_scan_disabled,omitempty"`), absent = enabled.
- Production code writes no package globals per `Server`; seams are `Server` fields. New `internal/webui` tests call `t.Parallel()` first.
- Commits: `git commit --signoff`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Add files by name.

## Review Focus

1. **Sibling-prefix paths** — a process in `/w/foo-bar` must not be attributed to worktree `/w/foo`. Test: `TestAttributeIgnoresSiblingPrefix` (Task 1).
2. **Processes that exit mid-scan** — a listener PID with no cwd line, or an ancestor missing from `ps`, is skipped, never an error or infinite loop (also PPID cycles / ppid==pid). Test: `TestAttributeSkipsVanishedAndCycles` (Task 1).
3. **No listeners at all** — `lsof` exit 1 + empty output yields an empty snapshot with ranges still present. Test: `TestScanEmptyLsofIsNotError` (Task 2).
4. **`worktree setup` dropping the key** — rewriting config must preserve `ui.port_scan_disabled: true`. Test: extend setup's config round-trip test (Task 4).
5. **Reconnect / reshow** — a stream opened after the snapshot exists receives it immediately, and a stream opened with `listeners=0` receives none and does not start the scanner. Tests: `TestStreamSendsCurrentListeners`, `TestMiniStreamSkipsListeners` (Task 3).

---

### Task 1: `internal/listeners` — parsing and attribution (pure)

**Files:**
- Create: `internal/listeners/listeners.go`, `internal/listeners/listeners_test.go`

**Interfaces:**
- Produces:
  ```go
  type Listener struct { PID int; Command string; Addr string; Port int }
  type Port struct {
      Port      int      `json:"port"`
      Addresses []string `json:"addresses"`
      PID       int      `json:"pid"`
      Process   string   `json:"process"`
      InRange   bool     `json:"in_range"`
  }
  type Worktree struct { Path, Canon string; Start, End int; HasRange bool }
  type Snapshot struct {
      Enabled bool              `json:"enabled"`
      Ports   map[string][]Port `json:"ports"`  // keyed by Worktree.Path; never nil
      Ranges  map[string]string `json:"ranges"` // Path → "4090-4099", only worktrees with a range; never nil
  }
  func ParseListen(out []byte) []Listener   // lsof -F pcn: p<pid>, c<cmd>, n<addr:port>
  func ParseCwd(out []byte) map[int]string  // lsof -F pn
  func ParsePPID(out []byte) map[int]int    // ps -axo pid=,ppid=
  func Canonical(path string) string
  func Owner(cwd string, wts []Worktree) (path string, ok bool) // deepest Canon match
  func Attribute(ls []Listener, owners map[int]string, wts []Worktree) Snapshot
  ```
  `owners` maps listener PID → owning worktree Path (resolved by Task 2). `Attribute` groups by (worktree, port), merges addresses (sorted, deduped), keeps the lowest PID and its command, sets `InRange` (true when `!HasRange`), sorts ports ascending, fills `Ranges`, sets `Enabled: true`.

- [ ] **Step 1: Write failing tests** with synthetic lsof/ps text:
  - `TestParseListen`: input `"p27670\ncnode\nn[::1]:4091\nn127.0.0.1:4091\np6933\ncadb\nn127.0.0.1:5037\n"` → 3 listeners; addr `"[::1]"` port 4091 pid 27670 cmd `node`; `*:8476` parses addr `"*"`.
  - `TestParseCwd`: `"p1\nn/a\np2\nn/b c\n"` → `{1:"/a", 2:"/b c"}`.
  - `TestParsePPID`: `"  1     0\n 42     1\n"` → `{1:0, 42:1}`.
  - `TestOwnerDeepestWins`: wts `/w/a` and `/w/a/sub`; `Owner("/w/a/sub/x")` → `/w/a/sub`; `Owner("/w/a")` → `/w/a`.
  - `TestAttributeIgnoresSiblingPrefix`: `Owner("/w/foo-bar/frontend", [/w/foo])` → not ok.
  - `TestAttributeMergesAndRanges`: two listeners same PID port 4091 (`[::1]`, `127.0.0.1`) + port 9000 in a worktree with range 4090–4099 → ports `[4091 (addresses ["127.0.0.1","[::1]"], in_range true), 9000 (in_range false)]`; `Ranges["/w/a"] == "4090-4099"`; a worktree without range → its port `in_range true`, absent from `Ranges`.
  - `TestAttributeLowestPID`: two PIDs on one port → row PID is the lower.
  - `TestCanonicalResolvesSymlink`: `t.TempDir()` with a symlink → `Canonical(link) == Canonical(real)`; nonexistent path returns `filepath.Clean` of its absolute form.
- [ ] **Step 2:** `go test ./internal/listeners/` → FAIL (undefined).
- [ ] **Step 3:** Implement in `listeners.go`. Addresses split at the **last** `:`; skip lines that don't parse.
- [ ] **Step 4:** `go test ./internal/listeners/` → PASS.
- [ ] **Step 5:** Commit `feat(listeners): parse lsof output and attribute ports to worktrees`.

---

### Task 2: `internal/listeners` — Scan with an injectable runner

**Files:**
- Create: `internal/listeners/scan.go`, `internal/listeners/scan_test.go`
- Modify: `internal/listeners/listeners_test.go` (Review Focus 2 test lives here as it exercises owner resolution)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```go
  type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)
  func ExecRunner(ctx context.Context, name string, args ...string) ([]byte, error) // exec.CommandContext(...).Output()
  func Scan(ctx context.Context, run Runner, wts []Worktree) (Snapshot, error)
  ```
  Algorithm: listen lsof → if no listeners, return `Attribute(nil, nil, wts)`. Else cwd lsof for listener PIDs; each PID whose cwd has an `Owner` is resolved. For the rest: run `ps` once, walk each one's parent chain (stop at pid ≤ 1, a missing parent, or a PID already visited), collect all ancestor PIDs, one cwd lsof for them, then resolve each unresolved listener to the first ancestor with an `Owner`. Unresolved listeners are dropped.

- [ ] **Step 1: Write failing tests** with a fake `Runner` that switches on args and records calls:
  - `TestScanAttributesByCwd`: listener cwd inside worktree → in snapshot; asserts exactly 2 runner calls (no `ps`).
  - `TestScanFallsBackToAncestor`: listener cwd `/elsewhere`, its parent's cwd inside worktree → attributed; asserts 4 calls total.
  - `TestScanEmptyLsofIsNotError`: listen lsof returns `(nil, *exec.ExitError with code 1)` → err nil, empty `Ports`, `Ranges` populated. (Build the ExitError via a real `exec.Command("sh","-c","exit 1").Run()`.)
  - `TestScanPropagatesOtherErrors`: listen lsof returns a non-exit error → err non-nil.
  - `TestAttributeSkipsVanishedAndCycles` (in scan_test.go): a listener with no cwd line and a `ps` table with a cycle (`5→6, 6→5`) and a missing parent → returns without hanging, listener dropped.
- [ ] **Step 2:** `go test ./internal/listeners/` → FAIL.
- [ ] **Step 3:** Implement `scan.go`. Treat exit status 1 with empty output as empty for both lsof calls.
- [ ] **Step 4:** `go test ./internal/listeners/` → PASS.
- [ ] **Step 5:** Commit `feat(listeners): scan with batched lsof and ancestor fallback`.

---

### Task 3: Scanner loop, hub and `listeners_changed` stream event

**Files:**
- Create: `internal/webui/listeners.go`, `internal/webui/listeners_test.go`
- Modify: `internal/webui/server.go` (fields), `internal/webui/stream.go`, `internal/webui/server_test.go` (`testServer` stubs the scan)
- Modify: `docs/web-ui-architecture.md` (SSE section: the `listeners_changed` event, `listeners=0`, payload; new "Listening ports" subsection), `.claude/CLAUDE.md` (add `listeners` to the package list, one line like its neighbours)

**Interfaces:**
- Consumes: `listeners.Scan`, `listeners.ExecRunner`, `listeners.Snapshot`, `listeners.Worktree`, `listeners.Canonical`; `registry.List`; `ports.Lookup(conn, filepath.Base(path))`.
- Produces (on `Server`):
  ```go
  listenersOnce     sync.Once
  listeners         *listenersHub
  listenersScan     func(ctx context.Context) (listeners.Snapshot, error) // seam; nil → s.scanListeners
  listenersInterval time.Duration                                         // seam; 0 → 10s
  portScanDisabled  atomic.Bool
  func (s *Server) SetPortScanDisabled(disabled bool)   // initial state from config (Task 4 calls on change too)
  func (s *Server) listenersHub() *listenersHub
  func (h *listenersHub) subscribe() (<-chan []byte, func()) // first subscriber starts the loop, last unsubscribe cancels it; channel is pre-loaded with the current snapshot if one exists
  func (h *listenersHub) kick()                               // rescan now (used by the toggle)
  ```
  Hub mirrors `cmuxFocusHub` (buffered chans, non-blocking sends). It stores the last published JSON bytes and publishes only when a new snapshot's JSON differs. While `portScanDisabled`, the loop doesn't scan and the hub publishes `{"enabled":false,"ports":{},"ranges":{}}` (once, via the same change check). A failed scan logs via `s.logger()` and keeps the last snapshot. `scanListeners` builds `[]listeners.Worktree` from `registry.List` + `ports.Lookup` (Canon via `listeners.Canonical`) and calls `listeners.Scan(ctx, listeners.ExecRunner, wts)`.
  Stream: unless `r.URL.Query().Get("listeners") == "0"`, subscribe and emit `event: listeners_changed\ndata: <json>\n\n` + flush for each message.

- [ ] **Step 1: Write failing tests** (all `t.Parallel()`; fake `listenersScan` counting calls, `listenersInterval` 20ms):
  - `TestListenersScanOnlyWhileSubscribed`: no subscribe → 0 scans after 100ms; subscribe → ≥1 scan; unsubscribe, wait, count stops increasing.
  - `TestListenersPublishOnlyOnChange`: fake returns the same snapshot repeatedly → exactly one message received in 150ms; then changes → a second message.
  - `TestListenersFailedScanKeepsLast`: second scan errors → no new message; a new subscriber still gets the first snapshot.
  - `TestListenersDisabledPublishesOff`: `SetPortScanDisabled(true)` before subscribe → message JSON has `"enabled":false`, fake scan never called; `SetPortScanDisabled(false)` + `kick()` → a scan runs and an `"enabled":true` message arrives.
  - `TestStreamSendsCurrentListeners`: httptest server with an authenticated session (use the helper other stream/auth tests use), seed one snapshot, open `/api/stream` → reads `event: listeners_changed` with that JSON before the first heartbeat.
  - `TestMiniStreamSkipsListeners`: open `/api/stream?listeners=0` → fake scan never called, no `listeners_changed` line within 100ms.
- [ ] **Step 2:** `go test ./internal/webui/ -run 'Listeners|Stream'` → FAIL.
- [ ] **Step 3:** Implement `listeners.go`, add fields, wire `stream.go`; in `testServer` set `listenersScan` to return an empty enabled snapshot so no test spawns `lsof`. Update the two docs.
- [ ] **Step 4:** `go test -race ./internal/webui/` → PASS.
- [ ] **Step 5:** Commit `feat(webui): push listening ports over the stream while tabs are open`.

---

### Task 4: `ui.port_scan_disabled` config key and Settings toggle

**Files:**
- Modify: `internal/config/config.go` (`UIConfig.PortScanDisabled bool \`yaml:"port_scan_disabled,omitempty"\``), `internal/config/editable.go` (+ test), `internal/setup/setup.go` (`uiYaml` field, carried in `u := uiYaml{…}`, included in the "write ui block" condition) + its test, `internal/webui/settings.go` (DTO `PortScanEnabled bool \`json:"port_scan_enabled"\``, GET from `!s.portScanDisabled.Load()`, PUT stores it and calls `s.listenersHub().kick()` when it changed), `internal/webui/settings_keys.go` (`"ui.port_scan_disabled"`), settings tests, `cmd/ui.go` (`srv.SetPortScanDisabled(cfg.UI.PortScanDisabled)` beside `SetCmuxFeaturesDisabled`)
- Modify: `ui/src/api/types.ts` (`port_scan_enabled: boolean` beside `cmux_features_enabled`), `ui/src/components/settings/GeneralPanel.tsx`, `ui/src/components/settings/tabDirty.ts` (+ test), `ui/src/components/settings/testSettings.ts`
- Modify: `docs/web-ui-architecture.md` "Settings modal" key list

**Interfaces:**
- Consumes: `Server.SetPortScanDisabled`, `listenersHub().kick()` (Task 3).
- Produces: settings DTO field `port_scan_enabled`.

Follow `cmux_features_disabled` exactly at each layer (absent means enabled; `WriteEditable` deletes the key when enabled, writes `true` when disabled).

- [ ] **Step 1: Write failing tests:**
  - editable round-trip: `PortScanDisabled: true` writes `ui.port_scan_disabled: true`; back to false removes the key.
  - setup: a config with `ui.port_scan_disabled: true` survives setup's rewrite (Review Focus 4).
  - settings API: GET reports `port_scan_enabled: true` by default; PUT false → config file has the key, `s.portScanDisabled.Load()` true, and a subscribed hub receives `"enabled":false`.
  - `settings_keys_test.go` passes once the key is listed.
  - `tabDirty.test.ts`: toggling `port_scan_enabled` marks General dirty.
  - GeneralPanel: switch labelled "Scan for listening ports" reflects and updates `draft.port_scan_enabled`.
- [ ] **Step 2:** `go test ./internal/config/ ./internal/setup/ ./internal/webui/` and `cd ui && npm test -- settings` → FAIL.
- [ ] **Step 3:** Implement. Switch goes directly after "Enable cmux features"; description: "Show which ports each worktree's processes are listening on. Runs lsof every 10 seconds while the UI is open."
- [ ] **Step 4:** Same commands → PASS; `go test -race ./internal/webui/`.
- [ ] **Step 5:** Commit `feat(settings): toggle for scanning listening ports`.

---

### Task 5: Frontend store and stream wiring

**Files:**
- Create: `ui/src/lib/listenersStore.ts`, `ui/src/lib/listenersStore.test.ts`
- Modify: `ui/src/api/types.ts` (`ListenerPort`, `ListenersSnapshot` mirroring Task 1 JSON), `ui/src/hooks/useSSE.ts` (+ `useSSE.test.tsx`)

**Interfaces:**
- Produces:
  ```ts
  export function setListeners(snap: ListenersSnapshot): void
  export function useListeners(path: string): { enabled: boolean; ports: ListenerPort[]; range: string | null } | null
  // null until the first snapshot arrives; ports [] when the path has none.
  export function formatRange(range: string): string // "4090-4099" → "4090–4099"
  ```
  Module-level store + `useSyncExternalStore` (pattern: `lib/cmuxFocusBus.ts`). `streamUrl()` mini branch returns `"/api/stream?listeners=0"`; `useSSE` adds `es.addEventListener("listeners_changed", …)` that JSON-parses (ignore parse errors) and calls `setListeners`.

- [ ] **Step 1: Write failing tests:**
  - store: `useListeners` returns null before any snapshot; after `setListeners`, returns the path's ports and range; unknown path → `ports: []`, `range: null`; `formatRange("4090-4099") === "4090–4099"`.
  - `useSSE.test.tsx`: emitting `listeners_changed` with a JSON payload updates the store; `streamUrl()` on a mini route is `/api/stream?listeners=0`.
- [ ] **Step 2:** `cd ui && npm test -- listenersStore useSSE` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS.
- [ ] **Step 5:** Commit `feat(ui): listening-ports store fed by the stream`.

---

### Task 6: Network column, Environment badge, home card line

**Files:**
- Create: `ui/src/components/ListeningPorts.tsx` (inline comma list, red out-of-range), `ui/src/components/NetworkPanel.tsx`, tests beside each
- Modify: `ui/src/components/WorktreeDetailCard.tsx` (+ test), `ui/src/components/WorktreeCard.tsx` (+ test)
- Modify: `docs/web-ui-architecture.md` (`WorktreeCard` / Environment tab mentions)

**Interfaces:**
- Consumes: `useListeners`, `formatRange` (Task 5).
- Produces:
  ```tsx
  export function ListeningPorts(props: { ports: ListenerPort[] }): JSX.Element // "4091, 9000", each number red if !in_range
  export function NetworkPanel(props: { path: string }): JSX.Element
  ```

Behaviour:
- **NetworkPanel:** title "Network"; subtitle `Reserved ${formatRange(range)}` or "No reserved range"; disabled → "Port scanning is off." plus an "Enable it in Settings" `Anchor component="button"` that calls `useOpenSettings()` with `{ tab: "general" }` (pattern: `WatcherAlert.tsx`; check the tab id `SettingsContext` uses; if `useOpenSettings()` returns null, render the sentence without the link); no ports → "Nothing listening"; else one row per port: port (red if out of range), addresses joined with ", ", `process` and `pid`, a copy-PID `CopyButton`/`ActionIcon` (aria-label "Copy PID", pattern from `gitdiff/GitSummary.tsx`), and an `ActionIcon` link (`component="a"`, `href=http://localhost:${port}`, `target="_blank"`, `rel="noreferrer"`, aria-label `Open localhost:${port}`). Rows `wrap="wrap"`.
- **WorktreeDetailCard Environment panel:** `Grid` with env vars `span={{ base: 12, sm: 6 }}` left and `NetworkPanel` `span={{ base: 12, sm: 6 }}` right (stacks below `sm`, per "Responsiveness").
- **Environment tab badge:** `rightSection` like the Code tab's `Badge size="xs" variant="light"` containing `<ListeningPorts>`; rendered only when enabled and ports non-empty.
- **WorktreeCard:** after the Repo/Branch `Text`, a `Text size="xs" c="dimmed"` "Listening on " + `<ListeningPorts>`, only when enabled and ports non-empty.

- [ ] **Step 1: Write failing tests** (seed via `setListeners`):
  - ListeningPorts: renders "4091, 9000"; 9000 has red color, 4091 doesn't.
  - NetworkPanel: shows "Reserved 4090–4099"; "No reserved range" with no range; "Nothing listening"; "Port scanning is off." and an "Enable it in Settings" link that opens Settings on the General tab when `enabled:false`; Copy PID button present; open link `href` is `http://localhost:4091`.
  - WorktreeDetailCard: Environment tab label shows the ports badge when listening; no badge when empty or disabled.
  - WorktreeCard: "Listening on 4091, 9000" present after Repo/Branch; absent when none.
- [ ] **Step 2:** `cd ui && npm test -- ListeningPorts NetworkPanel WorktreeDetailCard WorktreeCard` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; then `cd ui && npm test` and `make build` (runs `tsc -b`) → both succeed.
- [ ] **Step 5:** Commit `feat(ui): Network column, Environment badge and card line for listening ports`.

---

### Task 7: End-to-end check

- [ ] **Step 1:** `make test` → PASS; `go test -race ./internal/webui/` → PASS.
- [ ] **Step 2:** Run this branch's UI on a free port without touching Mike's running `worktree ui` or installing (`bin/worktree ui --help` and `make dev` show the port / `--api-only` options; never `make install`). In this worktree start `python3 -m http.server 4121` and `python3 -m http.server 9999`, capturing their PIDs. With Playwright (read `~/.agents/context/playwright.md` first) at 1400px and 380px confirm: home card "Listening on 4121, 9999" with 9999 red; Environment badge and Network rows match; Copy PID and open link present; no horizontal scroll at 380px; turning the Settings switch off hides badge and line and shows the off message with its link, which opens Settings. Kill only the captured PIDs. If the UI cannot be run in isolation, skip and report that.
- [ ] **Step 3:** No commit unless a fix was needed (fix commits per the plan-approval rule).
