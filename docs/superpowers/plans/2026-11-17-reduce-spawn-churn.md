# Process-Spawn Churn Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the number of processes `worktree ui` spawns per second (git, cmux, lsof, ps) by an order of magnitude without changing any API response shape.

**Architecture:** `gitutil` gains a spawn counter, a single-process `git status --porcelain=v2 --branch` parser, and a no-spawn "state stamp" from gitdir file mtimes. `internal/webui` wraps `handleWorktreeGit`'s computation in a per-path, two-tier cache with singleflight: ref-derived values stay valid until the refs stamp changes; working-tree values stay valid for 10s. The UI collapses the `fetch=0/1` query variants into one query and slows polls. Server loop intervals move into `ui:` config with slower defaults.

**Tech Stack:** Go (stdlib only — no `golang.org/x/sync` in go.mod; write a tiny singleflight), React + TanStack Query, Vitest + Testing Library.

**Spec:** The task brief in the session that produced this plan (no separate spec file). Key requirements are restated in Global Constraints.

## Global Constraints

- `/api/worktree-git` response JSON (`worktreeGitDTO` in `internal/webui/worktree_git_api.go`) keeps every field, name and semantics. Fingerprint *values* may change once (they are opaque digests), but must still move on commits, fetches, branch switches and working-tree edits, and `working_fingerprint` only on working-tree edits.
- All git calls still go through `gitRaw` in `internal/gitutil/run.go` (keeps `--no-optional-locks`).
- Linked worktrees (`.git` is a file `gitdir: <path>`, gitdir has `commondir`) must be handled everywhere a gitdir is read.
- Cache validity (one entry per worktree path, two tiers):
  - **Ref tier** (branch, tracking, main-upstream ref, base remote, PR id, ref SHAs, merge base, vs_merge_base, vs_tracking): valid iff `Stamp.Refs` is unchanged AND the worktree's PR candidate `(ID, BaseRef)` from `s.worktreePR(path)` is unchanged. No TTL — everything in it derives from refs, HEAD and git config, all of which are stamped.
  - **Working tier** (working counts, both fingerprints): valid iff the ref tier is valid AND `Stamp.Index` is unchanged AND age < `workingTTL = 10*time.Second`.
  - Request cost: both tiers valid → 0 git processes. Only the ref tier valid → exactly 1 (`StatusV2`). Otherwise a full compute.
  - There is no `remoteTTL` and no per-repo merge-base cache: the ref tier replaces both, so nothing in the cache is keyed per commit and nothing needs pruning.
- The stamp is taken BEFORE any git command of a compute runs, and the entry is stored with that pre-compute stamp, so a change that lands mid-compute mismatches on the next request.
- Tests that assert a `gitutil.SpawnCount()` delta must NOT call `t.Parallel()` (the counter is process-wide; Go only runs parallel tests after the serial ones finish) and must use `fetch=0` requests so the fetch scheduler starts nothing in the background.
- UI polls: `useWorktreeGit` 15s while a code/diff view wants fetch, 30s otherwise; PR/review comment summary default 30s (ReviewActions' active value 15s); cmux polls (`ui/src/api/cmux.ts` both, `cmuxTree.ts`) 30s/15s/15s as specified per task. `refetchIntervalInBackground: false` stays wherever present.
- Server loop defaults: cmux unread sync 30s, listeners scan 30s, both configurable under `ui:` in config.yaml as Go durations, floor 5s.
- Commits use `git commit --signoff`, add files by name (never `git add -A`/`.`).
- Never kill or restart mprocs or the user's running `worktree ui`. Verification is by tests only. Do NOT start a second `worktree ui`: against the real database its pollers, notifier and cmux unread sync would duplicate the running instance's work (double notifications, competing cmux renames).
- No lint rule disabling.

## Review Focus

1. Unstaged working-tree edits (no gitdir change): `working_fingerprint` must change within `workingTTL` — test `TestWorktreeGitCache_WorkingEditVisibleAfterTTL` in Task 4.
2. Linked worktree whose `.git` is a file: stamp must change on commit in that worktree and on a fetch in the main repo (refs live in commondir) — tests in Task 2.
3. Detached HEAD / unborn branch / no upstream from porcelain v2 output (`(detached)`, `(initial)`, missing `branch.upstream`/`branch.ab`) — table test in Task 3.
4. Concurrent requests for one path (two tabs) share one computation and both get the result — `TestWorktreeGitCache_Singleflight` in Task 4.
5. Worktree deleted from disk between polls: handler still returns `{on_disk:false}` and the cache entry is not served — `TestWorktreeGit_OffDiskBypassesCache` in Task 4.

---

### Task 1: Git spawn counter

**Files:**
- Modify: `internal/gitutil/run.go`
- Test: `internal/gitutil/run_test.go` (create)

**Interfaces:**
- Produces: `func SpawnCount() int64` in package `gitutil` — monotonically increasing count of git processes started by `gitRaw` (atomic, process-wide).

- [ ] **Step 1: Write the failing test** `TestSpawnCountIncrements`: init a repo with `testgit` helpers (see `refs_test.go` `runIn`), `before := SpawnCount()`, call `CurrentBranch(dir)` and `RevSHA(dir, "HEAD")`, assert `SpawnCount()-before == 2`.
- [ ] **Step 2:** Run `go test ./internal/gitutil -run TestSpawnCountIncrements -v` — FAIL (undefined: SpawnCount).
- [ ] **Step 3:** Add `var spawns atomic.Int64`, increment in `gitRaw` immediately before `cmd.Run()`, export `SpawnCount()`.
- [ ] **Step 4:** Re-run — PASS.
- [ ] **Step 5: Commit**
```bash
git add internal/gitutil/run.go internal/gitutil/run_test.go
git commit --signoff -m "gitutil: count spawned git processes"
```

### Task 2: No-spawn state stamp from gitdir mtimes

**Files:**
- Create: `internal/gitutil/stamp.go`
- Test: `internal/gitutil/stamp_test.go`

**Interfaces:**
- Produces: `func GitDirs(worktree string) (gitDir, commonDir string, err error)` — reads `<worktree>/.git`; directory → both equal it; file `gitdir: X` → gitDir=X (relative resolved against worktree), commonDir from `<gitDir>/commondir` (relative resolved against gitDir) or gitDir if absent. No process spawned.
- Produces: `type Stamp struct { Refs, Index string }` and `func StateStamp(worktree string) (Stamp, error)`. Each field is an opaque digest of size + mtime ns (or "missing") of:
  - `Refs`: `gitDir/HEAD`, `gitDir/ORIG_HEAD`, `commonDir/packed-refs`, `commonDir/FETCH_HEAD`, `commonDir/config`, and every file and directory under `commonDir/refs` (filepath.WalkDir; include dir mtimes so creates/deletes register).
  - `Index`: `gitDir/index`.
  No process spawned. Splitting them lets a `git add` (index only) cost one `git status` instead of a full recompute.

- [ ] **Step 1: Write failing tests**
  - `TestGitDirs_Plain`: repo dir → `gitDir == commonDir == <dir>/.git`.
  - `TestGitDirs_Linked`: `git worktree add ../wt -b feat` → `gitDir` ends with `.git/worktrees/wt`, `commonDir == <main>/.git` (compare via `filepath.EvalSymlinks`, macOS `/private/var`).
  - `TestStateStamp_ChangesOnCommit` (linked worktree): s1 := stamp, commit in wt, s2 := stamp, assert `s1.Refs != s2.Refs`.
  - `TestStateStamp_ChangesOnRefUpdateInMain` (linked): `git -C main update-ref refs/remotes/origin/main HEAD` → `Refs` of wt changes.
  - `TestStateStamp_ChangesOnBranchSwitch`: `git checkout -b other` → `Refs` changes.
  - `TestStateStamp_ChangesOnRemoteConfig`: `git remote add up <url>` → `Refs` changes (config is stamped).
  - `TestStateStamp_StableAndSpawnFree`: two calls equal, and `SpawnCount()` unchanged across them (no `t.Parallel()`).
  - `TestStateStamp_StageChangesIndexOnly`: `git add` a new file → `Index` changes, `Refs` does not.
  Note: mtime granularity — touch files with `os.Chtimes(+1s)` where the test can't otherwise guarantee a different mtime, or include size.
- [ ] **Step 2:** `go test ./internal/gitutil -run 'TestGitDirs|TestStateStamp' -v` — FAIL.
- [ ] **Step 3:** Implement per Interfaces; hash entries with sha256 into hex.
- [ ] **Step 4:** Re-run — PASS.
- [ ] **Step 5: Commit**
```bash
git add internal/gitutil/stamp.go internal/gitutil/stamp_test.go
git commit --signoff -m "gitutil: add spawn-free StateStamp for linked and plain worktrees"
```

### Task 3: Single-process branch + working status (porcelain v2)

**Files:**
- Modify: `internal/gitutil/fingerprint.go` (WorkingState uses the new status)
- Create: `internal/gitutil/statusv2.go`
- Test: `internal/gitutil/statusv2_test.go`; existing `fingerprint_test.go` must still pass

**Interfaces:**
- Produces:
```go
type BranchStatus struct {
    HeadSHA  string // "" for unborn ("(initial)")
    Branch   string // "" when detached
    Upstream string // short name, e.g. "origin/feat"; "" when none
    Ahead, Behind int
    HasAB    bool   // false when no upstream or upstream gone
}
func parseStatusV2(out string) (BranchStatus, WorkingSummary, []statusEntry)   // pure, -z output
func StatusV2(dir string) (BranchStatus, WorkingSummary, Fingerprint /*Working only*/, error) // ONE git process
func WorkingStateWith(dir string, bs BranchStatus, refSHAs map[string]string) (WorkingSummary, Fingerprint, error)
```
  `statusEntry{XY, Path string}` with v2 `.` mapped to space and `?` entries as `"??"`, so the working hash is computed exactly as today (`"%s %s\x00"` + Lstat size/mtime). `StatusV2` runs `status --porcelain=v2 --branch -uall -z`. Ordinary `1`, rename/copy `2` (path is the field before the extra NUL'd orig path), unmerged `u` (count as staged+modified, XY as given), untracked `?`; ignore `!`.
  `WorkingState(dir, refs...)` keeps its signature and output semantics but uses `StatusV2` for HEAD (no `RevSHA(HEAD)` spawn); refs still resolved via `RevSHA`.

- [ ] **Step 1: Write failing table test** `TestParseStatusV2` with literal -z strings for: clean on branch with upstream `# branch.ab +2 -1` → Ahead 2 Behind 1 HasAB; detached `# branch.head (detached)` → Branch ""; unborn `# branch.oid (initial)` → HeadSHA ""; no upstream → Upstream "" HasAB false; dirty mix (`1 .M`, `1 A.`, `1 MM`, `2 R.` with orig, `? new`) → Staged 3, Modified 2, Untracked 1, Files 5.
- [ ] **Step 2: Write failing integration test** `TestStatusV2_MatchesLegacyHelpers` over real repos (clean, dirty, detached, no-upstream, linked worktree with upstream set via `git branch -u`): assert `bs.Branch` == `CurrentBranch`, `bs.Upstream` == `TrackingBranch`, `(bs.Ahead,bs.Behind)` == `AheadBehind(dir, upstream)`, `WorkingSummary` equal to the pre-change `WorkingState` result, and `SpawnCount` delta for `StatusV2` == 1.
- [ ] **Step 3:** `go test ./internal/gitutil -run 'StatusV2' -v` — FAIL.
- [ ] **Step 4:** Implement; refactor `WorkingState` onto it.
- [ ] **Step 5:** `go test ./internal/gitutil -v` — all PASS (incl. `fingerprint_test.go`, `status_test.go`).
- [ ] **Step 6: Commit**
```bash
git add internal/gitutil/statusv2.go internal/gitutil/statusv2_test.go internal/gitutil/fingerprint.go
git commit --signoff -m "gitutil: derive branch, upstream and working state from one porcelain v2 status"
```

### Task 4: Cached, singleflighted handleWorktreeGit

**Files:**
- Create: `internal/webui/worktree_git_cache.go`
- Modify: `internal/webui/worktree_git_api.go:60-128`, `internal/webui/server.go` (Server fields near line 144-150)
- Test: `internal/webui/worktree_git_cache_test.go`; existing `worktree_git_api_test.go` must pass unchanged

**Interfaces:**
- Consumes: `gitutil.SpawnCount`, `gitutil.StateStamp`, `gitutil.StatusV2`, `gitutil.WorkingStateWith` (Tasks 1-3); `s.mergeBaseRefFetch` (`internal/webui/base_ref.go:22`).
- Produces:
```go
type gitComputed struct {
    dto        worktreeGitDTO // everything except Fetch, OnDisk, Directory
    refs       []string       // for fetch=1 RemotesFor
    baseRemote string
}
type worktreeGitCache struct { /* mu; entries map[string]*gitCacheEntry; inflight map[string]*gitCall; now func() time.Time */ }
func (c *worktreeGitCache) get(path string, compute func() gitComputed) gitComputed
func (s *Server) computeWorktreeGit(path string) gitComputed
```
  Server gets `gitCache *worktreeGitCache` (lazily created, like `fetchScheduler`).
  Validity follows the two tiers in Global Constraints (drop the `repo map` field from the struct sketch above — there is no per-repo cache). The entry stores the `gitutil.Stamp` taken before computing, the PR candidate `(ID, BaseRef)`, the ref SHAs used for fingerprints, and the time the working tier was computed. In-flight calls for the same path wait on one `chan struct{}` and share the result.
  Per request: take the stamp; read `s.worktreePR(path)` (confirm it is a database read that starts no process — if it does start one, cache it in the ref tier and report that in the task summary).
  - Both tiers valid → return the stored result.
  - Ref tier valid only → run `StatusV2` once and rebuild working counts and fingerprints with `WorkingStateWith` and the stored ref SHAs. Safety net: if the fresh `StatusV2` reports a HEAD sha, branch or upstream different from the stored ref tier, discard the entry and do a full compute.
  - Otherwise full compute, in this order: `StatusV2` (branch, tracking, vs_tracking from `branch.ab`, working, HEAD) → `mergeBaseRefFetch` → `RevSHA(up)` → `MergeBase` + `AheadBehind(up)` → `WorkingStateWith` for fingerprints (refs = [up, tracking]). Full cost ≈ 5-7 git vs 10-14 today.
  Handler: off-disk check and `config.ReadEditable` stay uncached per request; `fetch=1` path and `out.Fetch = fetcher.State(path)` stay per request using cached `refs`/`baseRemote`. After `fetcher.Maybe` completes a fetch, FETCH_HEAD/refs mtimes change the stamp, so no explicit invalidation is needed.

- [ ] **Step 1: Write failing tests** (reuse `gitTestServer`, `gitIn`, `commitFile` from `worktree_git_api_test.go`; inject `cache.now` for time):
  - `TestWorktreeGit_WarmCacheSpawnsNoGit`: GET once, `before := gitutil.SpawnCount()`, GET again, assert delta `== 0` and bodies byte-equal.
  - `TestWorktreeGit_CommitInvalidates`: GET, commit, GET → `fingerprint` differs, `vs_merge_base`/`branch` reflect new state.
  - `TestWorktreeGitCache_WorkingEditVisibleAfterTTL`: GET, modify a tracked file without staging, advance fake clock 11s, GET → `working_fingerprint` differs and `working.modified == 1`.
  - `TestWorktreeGit_TTLExpiredUnchangedRefsSpawnsOne`: GET, advance fake clock 11s, GET → `SpawnCount` delta `== 1` and the body is byte-equal to the first.
  - `TestWorktreeGit_StageSpawnsOne`: GET, `git add` a new file, GET (no clock advance) → delta `== 1`, `working.staged == 1`.
  - `TestWorktreeGit_FetchedUpstreamInvalidates`: GET, move `refs/remotes/origin/main` forward with `git update-ref`, GET → `vs_merge_base.behind` increases and `fingerprint` differs.
  - `TestWorktreeGitCache_StampTakenBeforeCompute`: compute func that commits mid-compute → the next `get` recomputes.
  - `TestWorktreeGitCache_Singleflight`: `get` with a compute func that blocks on a channel and counts calls; start 5 goroutines, release, assert count == 1 and all 5 results equal.
  - `TestWorktreeGit_OffDiskBypassesCache`: GET, `os.RemoveAll(path)`, GET → `on_disk == false`.
  - `TestWorktreeGit_LinkedWorktreeCached`: same as warm-cache test on a `git worktree add` path.
- [ ] **Step 2:** `go test ./internal/webui -run 'WorktreeGit' -v` — new tests FAIL.
- [ ] **Step 3:** Implement cache file and rewire handler.
- [ ] **Step 4:** `go test ./internal/webui -v` — all PASS including the pre-existing `worktree_git_api_test.go`.
- [ ] **Step 5: Commit**
```bash
git add internal/webui/worktree_git_cache.go internal/webui/worktree_git_cache_test.go internal/webui/worktree_git_api.go internal/webui/server.go
git commit --signoff -m "webui: cache worktree-git status per path with stamp/TTL invalidation and singleflight"
```

### Task 5: One worktree-git query per path, slower UI polls

**Files:**
- Modify: `ui/src/hooks/useWorktreeGit.ts`, `ui/src/hooks/usePRComments.ts:6`, `ui/src/hooks/useReviewComments.ts` (POLL_MS), `ui/src/components/gitdiff/ReviewActions.tsx:37` (IDLE_POLL_MS stays ≥ default), `ui/src/api/cmux.ts:17,50`, `ui/src/api/cmuxTree.ts:18`
- Test: `ui/src/hooks/useWorktreeGit.test.tsx` (create; mock pattern from `useDiffData.test.tsx`)

**Interfaces:**
- `useWorktreeGit(path: string, opts: { fetch: boolean })` — signature unchanged (callers WorktreeDetailPage.tsx:124, WorktreeDetailCard.tsx:69, DiffView.tsx:108, GitDiffPanel.tsx:24 untouched).
- Query key becomes `["worktree-git", path]` (drop `opts.fetch`). A module-level `Map<string, number>` refcount of mounted observers with `fetch: true` (registered in `useEffect`) is read by `queryFn`: `api.worktreeGit(path, fetchWanted(path))`. `refetchInterval: opts.fetch ? 15_000 : 30_000` (each observer runs its own timer, so the shortest wins). Remove the cross-variant `placeholderData` (no longer needed); keep the visibilitychange invalidation and `refetchIntervalInBackground: false`.
- When the fetch refcount for a path goes 0 → 1 (the Code/diff view opens), call `qc.invalidateQueries({ queryKey: ["worktree-git", path] })` so a `fetch=1` request goes out at once. Today opening the Code tab starts a new query immediately; without this the background-fetch nudge would wait up to 30s.
- Constants: `usePRComments` / `useReviewComments` `POLL_MS = 30_000`; ReviewActions active value `15_000` (pass explicitly). `useCmux` 30_000; `useResourceCmuxTab` 30_000; `useCmuxTree` 15_000.

- [ ] **Step 1: Write failing tests** in `useWorktreeGit.test.tsx` (mock `../api/client` `worktreeGit: vi.fn(async () => ({...minimal WorktreeGit}))`):
  - `it("shares one request between fetch and non-fetch observers")`: render both `useWorktreeGit("/wt",{fetch:false})` and `{fetch:true}` in one wrapper component; after `waitFor` data, assert `worktreeGit` called exactly once and with `("/wt", true)`.
  - `it("asks without fetch when no observer wants it")`: only `{fetch:false}` → called with `("/wt", false)`.
  - `it("refetches with fetch as soon as a fetch observer mounts")`: render `{fetch:false}`, wait for data (1 call, `false`), then mount a `{fetch:true}` observer → a second call with `("/wt", true)` arrives without advancing timers.
  - `it("stops asking for fetch after the fetch observer unmounts")`: unmount it, trigger a refetch → called with `("/wt", false)`.
- [ ] **Step 2:** `cd ui && npx vitest run src/hooks/useWorktreeGit.test.tsx` — FAIL (called twice).
- [ ] **Step 3:** Implement hook change and interval constants. While there, check the handlers behind the polls this task does not touch (`LogTab.tsx:85` 3s, `ResourceStatusTab.tsx:69` 10s, `WatcherAlert.tsx` 15s) and report in the task summary whether any of them starts a process per request; do not change them.
- [ ] **Step 4:** `cd ui && npm test` — PASS; `cd ui && npx tsc -b` — no errors (no lint script exists in ui/package.json).
- [ ] **Step 5: Commit**
```bash
git add ui/src/hooks/useWorktreeGit.ts ui/src/hooks/useWorktreeGit.test.tsx ui/src/hooks/usePRComments.ts ui/src/hooks/useReviewComments.ts ui/src/components/gitdiff/ReviewActions.tsx ui/src/api/cmux.ts ui/src/api/cmuxTree.ts
git commit --signoff -m "ui: dedupe worktree-git queries and slow status, comment and cmux polls"
```

### Task 6: Configurable server loop intervals

**Files:**
- Modify: `internal/config/config.go` (UIConfig ~line 168), `cmd/ui.go:182`, `internal/webui/listeners.go:19` (default const), wherever `srv.listenersInterval` is set (or add a setter)
- Test: `internal/config/config_test.go` (add cases)

**Interfaces:**
- Produces on `UIConfig`:
```go
CmuxUnreadSyncInterval string `yaml:"cmux_unread_sync_interval,omitempty"` // Go duration
ListenersScanInterval  string `yaml:"listeners_scan_interval,omitempty"`
func (u UIConfig) UnreadSyncInterval() time.Duration   // default 30s, floor 5s, unparsable → default
func (u UIConfig) ListenersInterval() time.Duration    // default 30s, floor 5s
```
  Follows the `GitConfig.Interval()` pattern. `cmd/ui.go` passes `cfg.UI.UnreadSyncInterval()` to `StartCmuxUnreadSync` and sets the listeners interval from `cfg.UI.ListenersInterval()`; `listenersIntervalDefault` becomes `30 * time.Second`. Not added to the Settings modal / `Editable` (config-file only — YAGNI; the Settings modal edits through `Editable` and adding two duration fields is not trivially consistent). Update the `PortScanDisabled` comment ("every 10s") to 30s.

- [ ] **Step 1: Write failing table test** `TestUIConfigIntervals`: `""`→30s, `"bogus"`→30s, `"1s"`→5s, `"45s"`→45s, for both methods.
- [ ] **Step 2:** `go test ./internal/config -run TestUIConfigIntervals -v` — FAIL.
- [ ] **Step 3:** Implement and wire into `cmd/ui.go`.
- [ ] **Step 4:** `go test ./internal/config ./internal/webui ./cmd/... -v` — PASS; `go build ./...` OK.
- [ ] **Step 5: Commit**
```bash
git add internal/config/config.go internal/config/config_test.go cmd/ui.go internal/webui/listeners.go
git commit --signoff -m "ui: configurable cmux unread sync and listener scan intervals, default 30s"
```

### Task 7: Full verification

- [ ] `go vet ./... && go test ./...` — all PASS.
- [ ] `cd ui && npm test && npx tsc -b` — PASS / no errors.
- [ ] `go test -race ./internal/gitutil ./internal/webui` — PASS (the cache is shared across request goroutines).
- [ ] No manual run: do not start a second `worktree ui` (see Global Constraints).

## Deployment (user-run, after merge — not an implementer step)

- Rebuild the UI and binary, then the user restarts his `worktree ui` pane in mprocs himself. Nobody else stops or restarts it.
- `ui.cmux_unread_sync_interval` and `ui.listeners_scan_interval` can be set in config.yaml if 30s is too slow.
