# cmux Two-Way Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Two-way sync" toggle in the Following cmux banner that, when on, makes the UI's own worktree navigation switch cmux's workspace instead of turning following off.

**Architecture:** Client only. A per-tab sessionStorage flag (sharing a small factory with `useFollowCmux`); `CmuxFollower` reads it and, on a location change it did not cause, selects the new worktree's workspace through the existing `POST /api/cmux/select`, with a short guard against stale focus events; `FollowingCmuxBanner` gets the toggle and the alternate text.

**Tech Stack:** React 18, Mantine, TanStack Query, wouter, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-19-cmux-two-way-sync-design.md`

All paths below are relative to the worktree root `/Users/mturley/.worktrees/worktree/cmux-two-way-sync`. Run UI commands from `ui/`.

## Global Constraints

- No server (Go) changes.
- Storage key: `worktree.cmuxTwoWaySync`, sessionStorage, independent of `worktree.followCmuxFocus`.
- Banner text, two-way on (exact): `Synced with cmux: switching workspaces there opens their worktrees here, and opening a worktree here switches cmux to it.`
- Banner text, two-way off: unchanged (`Following cmux: switching workspaces there opens their worktrees here.`).
- Toggle label (exact): `Two-way sync`.
- Bounce guard window: 2000 ms.
- With two-way off, behaviour is exactly today's.
- Every commit: `--signoff`, and the message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Add files by name, never `git add -A`.

## Review Focus

- Two-way on, going list → worktree page selects cmux (not only worktree → worktree). Test in Task 2.
- A select that rejects or returns `{ ok: false }` must clear the guard, so a later real cmux switch is still followed. Test in Task 2.
- The cmux query not yet loaded when the user navigates: the follower must fetch it rather than silently skip. Test in Task 2 (cache empty at navigation time).
- The follower's own navigation (from a focus event) must never trigger a select back to cmux. Test in Task 2.
- Two-way on while following is off does nothing: no select on navigation. Test in Task 2.

---

### Task 1: Two-way sync flag

**Files:**
- Create: `ui/src/lib/sessionFlag.ts`
- Create: `ui/src/hooks/useCmuxTwoWaySync.ts`
- Modify: `ui/src/hooks/useFollowCmux.ts` (re-implement on the factory; exports unchanged)
- Test: `ui/src/hooks/useCmuxTwoWaySync.test.ts`

**Interfaces:**
- Produces:
  - `sessionFlag(key: string): { read(): boolean; set(value: boolean): void; use(): [boolean, (value: boolean) => void] }` — the logic now in `useFollowCmux.ts` (sessionStorage `"true"`/`"false"`, in-memory fallback when storage throws, listener set, `useSyncExternalStore`). Each call has its own listeners and fallback.
  - `useFollowCmux`, `setFollowCmux`, `FOLLOW_CMUX_KEY` — same names and behaviour as today.
  - `CMUX_TWO_WAY_SYNC_KEY = "worktree.cmuxTwoWaySync"`, `setCmuxTwoWaySync(value: boolean): void`, `isCmuxTwoWaySync(): boolean`, `useCmuxTwoWaySync(): [boolean, (value: boolean) => void]` in `hooks/useCmuxTwoWaySync.ts`.

- [ ] **Step 1: Write the failing tests** in `useCmuxTwoWaySync.test.ts`:
  - `"defaults to off"`: `renderHook(useCmuxTwoWaySync).result.current[0] === false`.
  - `"persists to sessionStorage under its own key"`: `act(() => setCmuxTwoWaySync(true))` → `sessionStorage.getItem("worktree.cmuxTwoWaySync") === "true"` and `sessionStorage.getItem("worktree.followCmuxFocus")` is `null`.
  - `"re-renders subscribers"`: hook value flips to `true` after `act(() => setCmuxTwoWaySync(true))`.
  - `"is independent of following"`: `setFollowCmux(false)` after `setCmuxTwoWaySync(true)` leaves `isCmuxTwoWaySync() === true`.
  - `beforeEach` clears sessionStorage; `afterEach` calls `setCmuxTwoWaySync(false)`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/hooks/useCmuxTwoWaySync`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `sessionFlag`, re-implement `useFollowCmux.ts` on it, add `useCmuxTwoWaySync.ts`.** Move the storage comments that are about the mechanism into `sessionFlag.ts`; keep the "why per tab" comment in each hook file.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/hooks src/components/CmuxFollower src/components/HomeHeader`
Expected: PASS (existing follow tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/sessionFlag.ts ui/src/hooks/useCmuxTwoWaySync.ts ui/src/hooks/useCmuxTwoWaySync.test.ts ui/src/hooks/useFollowCmux.ts
git commit --signoff -m "feat(ui): per-tab cmux two-way sync flag"
```

### Task 2: Follower switches cmux on the UI's own navigation

**Files:**
- Modify: `ui/src/components/CmuxFollower.tsx`
- Test: `ui/src/components/CmuxFollower.test.tsx` (new `describe("CmuxFollower, two-way sync")`)

**Interfaces:**
- Consumes: `useCmuxTwoWaySync()` / `setCmuxTwoWaySync()` from Task 1; `api.cmux()`, `api.cmuxSelect(ref)`; `CmuxResponse` / `CmuxWorkspace` from `api/types.ts`.
- Produces: `export const TWO_WAY_GUARD_MS = 2000` in `CmuxFollower.tsx`.

Behaviour, in the existing location effect (which already tells the follower's own navigations apart via `expectedRef`):
- Unchanged when `!follow`, or when the change was the follower's own (`to === expected`).
- `follow && !twoWay`: today's rule (leaving a worktree page turns following off).
- `follow && twoWay`: never turns following off. If `to` is a worktree path, call `selectFor(to)`; if `to` is null (home page etc.), do nothing.

`selectFor(path)`: get cmux data with `queryClient.fetchQuery({ queryKey: ["cmux"], queryFn: () => api.cmux(), staleTime: 30_000 })` (cache when fresh, fetch when empty). If `!available`, or the path has no matches, or any match is `selected`, do nothing. Otherwise set the guard to `{ path, until: Date.now() + TWO_WAY_GUARD_MS }`, call `api.cmuxSelect(matches[0].ref)`, and on rejection or `{ ok: false }` clear the guard. Invalidate `["cmux"]` on success (as `useCmuxSelect` does).

Guard, at the top of the `onCmuxFocus` handler: if a guard is set and `msg.path === guard.path`, clear it and carry on; else if `Date.now() < guard.until`, ignore the event; else clear it and carry on.

- [ ] **Step 1: Write the failing tests.** Shared setup: `setFollowCmux(true)`, `setCmuxTwoWaySync(true)`, `vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: { [A]: [{ ref: "workspace:1", title: "a", selected: true }], [B]: [{ ref: "workspace:2", title: "b", selected: false }] } })`, `const select = vi.spyOn(api, "cmuxSelect").mockResolvedValue({ ok: true })`. Each test starts on `pageOf(A)`. Add `setCmuxTwoWaySync(false)` to the file's `afterEach`.
  - `"switches cmux when the user opens another worktree"`: `act(() => navigate(pageOf(B)))` → `await waitFor(() => expect(select).toHaveBeenCalledWith("workspace:2"))`; follow key still `"true"`.
  - `"switches cmux when going from the list to a worktree"`: start at `/`, navigate to `pageOf(B)` → select called with `"workspace:2"`.
  - `"keeps following and leaves cmux alone on the home page"`: navigate to `/` → follow key `"true"`; after a tick, `select` not called.
  - `"does not re-select a workspace cmux already has selected"`: matches for B with `selected: true`; navigate to B → after a tick, `select` not called.
  - `"leaves cmux alone for a worktree with no workspace"`: navigate to `pageOf("/wt/repo/c")` → after a tick, `select` not called; follow `"true"`.
  - `"never echoes its own navigation back to cmux"`: `focus(B)` → page is B; after a tick, `select` not called.
  - `"ignores a stale focus event for the worktree just left"`: navigate to B, wait for select; `focus(A)` → still on `pageOf(B)`.
  - `"follows again once cmux confirms the switch"`: navigate to B, wait for select; `focus(B)`; `focus(A)` → on `pageOf(A)`.
  - `"follows again after the guard window"`: `vi.spyOn(Date, "now")` returning a controlled value; navigate to B, wait for select; advance the value by `TWO_WAY_GUARD_MS + 1`; `focus(A)` → on `pageOf(A)`.
  - `"a failed switch clears the guard"`: `select.mockResolvedValue({ ok: false, error: "x" })`; navigate to B, wait for select; flush; `focus(A)` → on `pageOf(A)`.
  - `"fetches cmux state when none is cached"`: assert `api.cmux` was called after navigating (the wrap's QueryClient starts empty) and select called with `"workspace:2"`.
  - `"does nothing while following is off"`: `setFollowCmux(false)`; navigate to B → after a tick, `select` not called.
  - Existing tests (two-way off) must keep passing unchanged.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/CmuxFollower`
Expected: the new two-way tests FAIL; existing tests PASS.

- [ ] **Step 3: Implement** as described above, using `useQueryClient()` for the fetch and a `useRef<{ path: string; until: number } | null>` for the guard. Update the component's doc comment to describe two-way sync.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/CmuxFollower && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/CmuxFollower.tsx ui/src/components/CmuxFollower.test.tsx
git commit --signoff -m "feat(ui): two-way cmux sync switches cmux on UI navigation"
```

### Task 3: Banner toggle, text, and docs

**Files:**
- Modify: `ui/src/components/FollowingCmuxBanner.tsx`
- Modify: `docs/web-ui-architecture.md` ("Follow cmux" section, ~line 4535)
- Modify: `docs/superpowers/specs/2026-11-19-cmux-two-way-sync-design.md` (already edited: "Synced with cmux:" wording; commit it here)
- Test: `ui/src/components/CmuxFollower.test.tsx` (`describe("FollowingCmuxBanner")`)

**Interfaces:**
- Consumes: `useCmuxTwoWaySync()` from Task 1; `Toggle` from `components/Toggle.tsx`.

- [ ] **Step 1: Write the failing tests** in the existing `FollowingCmuxBanner` describe:
  - `"offers two-way sync, off by default"`: following on → `getByRole("switch", { name: "Two-way sync" })` not checked; text matches `/^Following cmux:/`.
  - `"turning it on persists and changes the text"`: click the switch → `sessionStorage.getItem("worktree.cmuxTwoWaySync") === "true"`; `getByText(/^Synced with cmux: switching workspaces there opens their worktrees here, and opening a worktree here switches cmux to it\.$/)`.
  - `"stop following keeps the two-way choice"`: two-way on, click "Stop following" → banner gone, `isCmuxTwoWaySync() === true`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/CmuxFollower -t FollowingCmuxBanner`
Expected: FAIL (no switch).

- [ ] **Step 3: Implement.** Put the `Toggle` (label `Two-way sync`, tooltip `Opening a worktree here also switches cmux to its workspace`, `style={{ flex: "none" }}`) in the banner's right-hand group, before "Stop following". Let the outer group wrap (`wrap="wrap"`) so a narrow screen puts the controls under the text. Swap the text on the flag. Update the component's doc comment.

- [ ] **Step 4: Update `docs/web-ui-architecture.md`** "Follow cmux": add a **Two-way sync** bullet covering the toggle and its key, select-on-own-navigation (worktree pages only; the home page keeps following and leaves cmux alone), already-selected/no-workspace no-ops, the 2000 ms guard and its early clear, and that with it off leaving a worktree page still turns following off.

- [ ] **Step 5: Run the full UI suite and typecheck**

Run: `npx tsc --noEmit -p . && npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/FollowingCmuxBanner.tsx ui/src/components/CmuxFollower.test.tsx docs/web-ui-architecture.md docs/superpowers/specs/2026-11-19-cmux-two-way-sync-design.md
git commit --signoff -m "feat(ui): Two-way sync toggle in the following-cmux banner"
```
