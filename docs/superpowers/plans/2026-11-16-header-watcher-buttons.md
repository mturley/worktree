# Header Watcher Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Refresh watchers → Watcher logs → Settings icon buttons at the top right of every page header (refresh + logs in the mini view), with watcher logs moved out of Settings into its own modal.

**Architecture:** Frontend only (`ui/src`). A new `WatcherLogsButton` owns a `WatcherLogsModal` (the old Settings `LogsPanel` content) and turns into a warning icon when `/api/watchers` reports any `has_error`. A `HeaderActions` group renders the three buttons; it replaces `SettingsButton` in `HomeHeader` and is added to the worktree page header. Per-feed `RefreshWatchersButton`s are removed.

**Tech Stack:** React, Mantine 7, TanStack Query, Tabler icons, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-16-header-watcher-buttons-design.md`

## Global Constraints

- Button order, left to right: Refresh watchers → Watcher logs → Settings. Top right of every page header.
- Mini view: Refresh watchers → Watcher logs → "Open full UI ↗"; no Settings button.
- Warning state = any watcher in `useWatchers().data.watchers` with `has_error`. Not `watcher-health`; a disabled watcher is not an error.
- Accessible names: `"Refresh watchers"` (unchanged), `"Watcher logs"`, `"Settings"` (unchanged). Failing: aria-label `"Watcher logs (watchers failing)"`.
- Log polling still runs only while the logs modal is open (keep `keepMounted={false}` sub-tabs, render nothing when closed).
- Run UI tests with `cd ui && npx vitest run <path>`; full suite `cd ui && npm test`; typecheck via `cd ui && npx tsc -b`.
- Commits use `--signoff` and add files by name.

## Review Focus

- Logs modal closed → no `/api/watchers/log` or `/api/watchers/resources` request (Task 1 test).
- Two watchers failing → tooltip reads "GitHub and Jira watchers failing — open logs"; one failing → "GitHub watcher failing — open logs" (Task 1 test).
- Watchers response not loaded yet (undefined) → plain logs icon, no crash (Task 1 test).
- Worktree page narrow → the trio is still in the header's title row, not lost in the narrow toolbar (Task 2 test).
- Mini popover → logs modal opens full-screen and closes with its close button (Task 3 test).

---

### Task 1: Watcher logs modal and button; remove Logs from Settings

**Files:**
- Move: `ui/src/components/settings/LogsPanel.tsx` → `ui/src/components/watcherlog/WatcherLogsModal.tsx` (`git mv`, then edit)
- Create: `ui/src/components/watcherlog/WatcherLogsButton.tsx`
- Create: `ui/src/components/watcherlog/WatcherLogsButton.test.tsx`
- Modify: `ui/src/components/SettingsModal.tsx` (drop Logs tab, `LogsPanel` import, `tab !== "logs"` footer check)
- Modify: `ui/src/components/settings/SettingsContext.tsx` (drop `"logs"` from `SettingsTarget["tab"]` and `SETTINGS_TABS`)
- Modify: `ui/src/components/SettingsModal.test.tsx` (drop "Logs" from the tab-name list at line 34; move the "Logs: fetches nothing until opened…" test (line 41) to `WatcherLogsButton.test.tsx`, adapted)

**Interfaces:**
- Produces: `WatcherLogsModal({ opened, onClose, fullScreen }: { opened: boolean; onClose: () => void; fullScreen?: boolean })` — Mantine `Modal`, title "Watcher logs", size "xl"; body is the existing pills tabs ("Watcher log" / "Resource status", `keepMounted={false}`), rendered only while `opened`.
- Produces: `WatcherLogsButton({ fullScreen }: { fullScreen?: boolean })` — `ActionIcon` (`variant="subtle" color="gray" size="sm"`, as `SettingsButton`) holding its own `useState` open flag and rendering `WatcherLogsModal`. Icon: `IconFileText` size 16 when healthy; `IconAlertTriangleFilled` size 16 with `color="red"` when any watcher `has_error`. Tooltip: "Watcher logs" healthy; failing: "<names> watcher(s) failing — open logs", names from `serviceName` in `settings/watcherText.ts` keyed by `w.name`.

- [ ] **Step 1: Commit spec and plan**

```bash
git add docs/superpowers/specs/2026-11-16-header-watcher-buttons-design.md docs/superpowers/plans/2026-11-16-header-watcher-buttons.md
git commit --signoff -m "docs: design and plan for header watcher buttons"
```

- [ ] **Step 2: Write failing tests in `WatcherLogsButton.test.tsx`**

Mock `api.watchers`, `api.watcherLog`/`api.watchedResources` (whatever `LogTab`/`ResourceStatusTab` call — copy the spies from the moved SettingsModal test). Tests:
- `"shows a plain logs icon when every watcher is healthy"` — button name `"Watcher logs"`; no element with name matching `/failing/`.
- `"shows a plain logs icon before watcher status loads"` — `api.watchers` returns a never-resolving promise; button `"Watcher logs"` present.
- `"turns into a warning when a watcher is failing"` — watchers `[{name:"github",type:"pr",has_error:true,error_message:"401"}, {name:"jira",type:"jira"}]`; `findByRole("button", { name: "Watcher logs (watchers failing)" })`.
- `"names every failing watcher in the tooltip"` — github and jira both `has_error`; hover; tooltip text contains both service names.
- `"fetches nothing until opened, then shows the watcher log and resource status sub-tabs"` — the moved test: log/resources spies not called before click; after click, dialog titled "Watcher logs" with tabs "Watcher log" and "Resource status".
- `"opens full screen when asked"` — `render(<WatcherLogsButton fullScreen />)`, click; the dialog's modal content has Mantine's full-screen attribute (`data-full-screen`) .

- [ ] **Step 3: Run to see them fail**

Run: `cd ui && npx vitest run src/components/watcherlog/WatcherLogsButton.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement** `WatcherLogsModal` (from the moved `LogsPanel`) and `WatcherLogsButton`; remove the Logs tab from `SettingsModal` and `"logs"` from `SettingsContext`; update `SettingsModal.test.tsx`. Update the `SettingsModal` doc comment ("Devices manages logins; it has no draft").

- [ ] **Step 5: Verify**

Run: `cd ui && npx vitest run src/components/watcherlog src/components/SettingsModal.test.tsx src/components/settings && npx tsc -b`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/watcherlog/WatcherLogsModal.tsx ui/src/components/watcherlog/WatcherLogsButton.tsx ui/src/components/watcherlog/WatcherLogsButton.test.tsx ui/src/components/settings/LogsPanel.tsx ui/src/components/SettingsModal.tsx ui/src/components/SettingsModal.test.tsx ui/src/components/settings/SettingsContext.tsx
git commit --signoff -m "feat(ui): watcher logs get their own modal and header button"
```

### Task 2: HeaderActions in both page headers; drop per-feed refresh buttons

**Files:**
- Create: `ui/src/components/HeaderActions.tsx`
- Modify: `ui/src/components/HomeHeader.tsx:43` (`<SettingsButton />` → `<HeaderActions />`; update doc comment)
- Modify: `ui/src/pages/WorktreeDetailPage.tsx` (add `<HeaderActions />` as the second child of the `data-detail-header` Group at ~line 816, `style={{ flex: "none" }}`, both widths; remove `<RefreshWatchersButton />` from `activityControls` ~line 423 and its import; fix the comment "refresh, the watcher log and mark all read")
- Modify: `ui/src/components/ActivityPanel.tsx:164` (remove `RefreshWatchersButton` and import; comment "refresh and mark all read" → "mark all read")
- Modify: `ui/src/components/ResourceDetailPane.tsx:189` (remove `RefreshWatchersButton` and import; keep "Updated …" and `WatcherErrorMark`)
- Modify: `ui/src/components/linked/LinkedResourcesPanel.tsx:123` comment that references `RefreshWatchersButton` placement, if it no longer reads true
- Test: `ui/src/components/HomeHeader.test.tsx`, `ui/src/pages/HomePage.test.tsx:136-153`, `ui/src/components/ResourceDetailPane.test.tsx:333-338`, `ui/src/pages/WorktreeDetailPage.test.tsx`

**Interfaces:**
- Consumes: `WatcherLogsButton` (Task 1), `RefreshWatchersButton`, `SettingsButton`.
- Produces: `HeaderActions({ settings = true, fullScreenLogs }: { settings?: boolean; fullScreenLogs?: boolean })` — `<Group gap={4} wrap="nowrap" data-testid="header-actions">` with Refresh, Logs (`fullScreen={fullScreenLogs}`), and Settings when `settings`.

- [ ] **Step 1: Update/write failing tests**
- `HomeHeader.test.tsx`: `"ends with refresh, logs and settings, in that order"` — within `header-actions`, `getAllByRole("button")` names equal `["Refresh watchers", "Watcher logs", "Settings"]`. (Wrap needs `api.watchers` mocked.)
- `HomePage.test.tsx` tab bar test: tablist has no `"Refresh watchers"`; the page header has one.
- `ResourceDetailPane.test.tsx`: replace "offers a refresh button beside the heading" with `"leaves refresh to the page header"` (`queryByRole("button", { name: "Refresh watchers" })` null); in "says nothing when the watcher has never succeeded", await something else (e.g. the heading) instead of the refresh button.
- `WorktreeDetailPage.test.tsx`: `"puts refresh, logs and settings in the header"` for `setViewport("wide")` and `"narrow"`: within `[data-detail-header]`, the three buttons in order; `activity-controls` has no `"Refresh watchers"`.

- [ ] **Step 2: Run to see them fail**

Run: `cd ui && npx vitest run src/components/HomeHeader.test.tsx src/pages src/components/ResourceDetailPane.test.tsx`
Expected: the new/changed assertions fail.

- [ ] **Step 3: Implement** `HeaderActions` and the edits above.

- [ ] **Step 4: Verify**

Run: `cd ui && npm test && npx tsc -b`
Expected: whole suite passes (fix any other test that found the refresh button in a feed toolbar, e.g. `LinkPane.test.tsx:90` should still hold).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/HeaderActions.tsx ui/src/components/HomeHeader.tsx ui/src/components/HomeHeader.test.tsx ui/src/pages/WorktreeDetailPage.tsx ui/src/pages/WorktreeDetailPage.test.tsx ui/src/pages/HomePage.test.tsx ui/src/components/ActivityPanel.tsx ui/src/components/ResourceDetailPane.tsx ui/src/components/ResourceDetailPane.test.tsx
git commit --signoff -m "feat(ui): refresh, logs and settings at the top right of every page"
```
(Add `LinkedResourcesPanel.tsx` if its comment changed.)

### Task 3: Mini view refresh and logs

**Files:**
- Modify: `ui/src/pages/MiniPage.tsx:~207` (inside the `Group` before "Open full UI ↗": `<HeaderActions settings={false} fullScreenLogs />`)
- Test: `ui/src/pages/MiniPage.test.tsx`

**Interfaces:**
- Consumes: `HeaderActions` (Task 2).

- [ ] **Step 1: Write failing tests**
- `"puts refresh and logs before Open full UI, without settings"` — header buttons in order `"Refresh watchers"`, `"Watcher logs"`, then `/Open full UI/`; no `"Settings"` button.
- `"opens the watcher logs full screen and closes them"` — click `"Watcher logs"`; dialog "Watcher logs" has `data-full-screen`; click its close button; dialog gone.

- [ ] **Step 2: Run to see them fail**

Run: `cd ui && npx vitest run src/pages/MiniPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify**

Run: `cd ui && npx vitest run src/pages/MiniPage.test.tsx && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/MiniPage.tsx ui/src/pages/MiniPage.test.tsx
git commit --signoff -m "feat(ui): refresh and watcher logs in the mini view"
```

### Task 4: Docs and full build

**Files:**
- Modify: `docs/web-ui-architecture.md` "Watcher log" section (~line 2461: now its own modal opened from the header logs button, `watcherlog/WatcherLogsModal` / `WatcherLogsButton`, warning icon on `has_error`; "Only while the tab is showing" → "while the modal is open"; frontend file list) and any "Settings modal" tab list naming Logs (grep `Logs` / `RefreshWatchersButton` in the doc and fix references to refresh placement)
- Modify: `CLAUDE.md` `webui` bullet: "the Settings modal Logs tab's read-only…" → "the watcher logs modal's read-only…"

- [ ] **Step 1: Edit docs** (grep `docs/` and `CLAUDE.md` for `Logs tab`, `LogsPanel`, `RefreshWatchersButton`, `settings=logs`).
- [ ] **Step 2: Verify build**

Run: `make build && make test`
Expected: both succeed.

- [ ] **Step 3: Commit**

```bash
git add docs/web-ui-architecture.md CLAUDE.md
git commit --signoff -m "docs: watcher logs modal and header buttons"
```
