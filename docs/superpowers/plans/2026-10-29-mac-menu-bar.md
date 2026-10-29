# macOS Menu Bar Mini View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS menu bar app whose dropdown shows the web UI's Tasks and Activity at `/mini`, whose icon blinks while anything is unread, and which `worktree setup` installs, rebuilds and removes; plus "switch cmux" buttons in workspace hover cards everywhere.

**Architecture:** The frontend gains a `/mini` route rendered by a separate `MiniApp` shell (own router hook that sends other routes to the browser, no tab registration, a JS bridge to the native app). Activity logic moves out of `HomePage` into a `useActivityPanel` hook both pages use. The native side is a small AppKit app (`NSStatusItem` + `NSPopover` + `WKWebView`) whose Swift source is embedded in the Go binary (`internal/macapp`) and compiled locally by `worktree setup` with `swiftc`.

**Tech Stack:** React + Mantine + wouter + vitest (ui/), Go + cobra (setup), Swift/AppKit/WebKit via plain `swiftc`, launchd LaunchAgent.

**Spec:** `docs/superpowers/specs/2026-10-29-mac-menu-bar-design.md`

## Global Constraints

- Work in `~/.worktrees/worktree/mac-menu-bar` on branch `mac-menu-bar`. Commits use `--signoff`; add files by name, never `git add -A`/`.`.
- Server URL is fixed: `http://127.0.0.1:8475` (`config.DefaultHTTPPort`). No new config keys anywhere.
- Mini route path is exactly `/mini`.
- Dropdown size about 420×640.
- Bridge handler name: `worktree` (`window.webkit.messageHandlers.worktree`). Messages: `{type:"unread",unread,count}`, `{type:"open",url}`, `{type:"ready"}`, `{type:"login"}`, plus `{type:"unreachable"}` (plan addition, see Task 2).
- App bundle: `~/Applications/Worktree Menu Bar.app`; executable `Contents/MacOS/WorktreeMenuBar`; bundle ID and LaunchAgent label `me.turley.worktree.menubar`; LaunchAgent at `~/Library/LaunchAgents/me.turley.worktree.menubar.plist`.
- `Info.plist` key `WorktreeSourceHash` holds the hex SHA-256 of the embedded app source.
- Reload countdown when the server is unreachable: 6 seconds, in both the web UI (`RELOAD_AFTER_SECONDS` in `ui/src/App.tsx`, today 10) and the app's native offline view. Blink frame: `BLINK_MS` = 600ms (`ui/src/lib/blinkTicker.ts`).
- The Swift side never computes unread; it only shows what the page sends.
- No copied Tasks/Activity JSX: the home page and the mini page call the same hook and components.
- Non-interactive setup never installs the app fresh; a rebuild happens only when the source hash differs; a rebuild never adds or removes the LaunchAgent.
- Frontend tests: `cd ui && npx vitest run <path>`; full: `make test-web`. Go: `go test ./internal/...`. Lint: `cd ui && npx eslint src` and `npx tsc --noEmit` (check `ui/package.json` for the script names before running).

## Review Focus

1. **Server restarts while the app runs** (`make install` stops `worktree ui`): the app must show the offline view and the disconnected icon, then recover without a click. Test: Task 2 `ServerUnreachable posts unreachable`; manual check in Task 8.
2. **App launched while the server is down**: the icon must start disconnected, never plain (plain says "nothing unread"). Task 5's Swift initial state is `.disconnected`; manual check in Task 5.
3. **`?task=` and `?home=` on `/mini`**: a task link must open the modal in place, and the home param must not push the URL out to the browser. Test: Task 2 `useMiniLocation keeps /mini query navigation in place`.
4. **cmux disabled or unavailable**: no switch button may render. Test: Task 1 `hides the switch button without cmux`.
5. **App bundle deleted by hand but LaunchAgent left behind**: setup must treat the app as not installed (offer install), and uninstall must still remove the stray plist. Test: Task 6 `decide: missing bundle is not installed`; Task 7 `uninstall removes a stray plist`.

---

### Task 1: "Switch cmux" button in workspace hover cards

Independent of the rest; lands first.

**Files:**
- Create: `ui/src/components/CmuxSwitchButton.tsx`
- Create: `ui/src/components/CmuxSwitchButton.test.tsx`
- Modify: `ui/src/components/tasks/LinkHoverCards.tsx` (`WorktreeDetails`, `Preview` doc comment)
- Modify: `ui/src/components/AllResourceRow.tsx` (`WorktreesLine`, `preview === false` branch)
- Modify: `ui/src/components/CmuxWorkspaceHeader.tsx`, `ui/src/components/CmuxWorkspaceSection.tsx` (use the shared hook)

**Interfaces:**
- Produces: `useCmuxSelect(): UseMutationResult<{ok:boolean; error?:string}, Error, string>` (in `CmuxSwitchButton.tsx`, mutation calling `api.cmuxSelect(ref)` and invalidating `["cmux"]` on success); `CmuxSwitchButton({ wsRef, title }: { wsRef: string; title: string })`.

- [ ] **Step 1: Write the failing tests** in `CmuxSwitchButton.test.tsx` (mock `../api/client` and `../api/cmux` the way `CmuxWorkspaceSection.test.tsx` does):
  - `switches cmux to the workspace`: render `WorktreeHoverCard` for a path whose `useCmuxMatches` returns `[{ref:"workspace:3", title:"api", color:"#f00"}]`, hover the target, click the button named `Switch cmux to api`; expect `api.cmuxSelect` called with `"workspace:3"`.
  - `does not trigger the card's target`: wrap the hover target in an element with an `onClick` spy; clicking the switch button leaves the spy uncalled.
  - `hides the switch button without cmux`: `useCmux` data `{available:false}` → no button named /Switch cmux/.
  - `shows the button in a resource hover card's worktree line`: render `AllResourceSummary` with `preview={false}` for a resource whose worktree matches a workspace → one switch button.
- [ ] **Step 2: Run** `cd ui && npx vitest run src/components/CmuxSwitchButton.test.tsx` — expect FAIL (module not found).
- [ ] **Step 3: Implement.** `CmuxSwitchButton` is a Mantine `ActionIcon` (`size="xs"`, `variant="subtle"`, `IconArrowRight` or similar), `aria-label={`Switch cmux to ${title}`}`, wrapped in a `Tooltip` with the same text, or the error message when the mutation failed (`color="red"`); shows `loading` while pending; calls `e.stopPropagation()` on click. In `WorktreeDetails` render it after each workspace title. In `WorktreesLine`, when `!preview`, render `<CmuxSwitchButton>` after each `WorktreeName` for its first workspace match (`useCmuxMatches(w.path)[0]`; extract a tiny `WorktreeLineItem` component so the hook isn't called in a loop). Replace the inline `useMutation(api.cmuxSelect)` in `CmuxWorkspaceHeader` and `CmuxWorkspaceSection` with `useCmuxSelect()`. Update `Preview`'s comment: hover cards now carry an action. Raise `closeDelay` only if a manual check shows the card closing while the mouse crosses into it.
- [ ] **Step 4: Run** the new test file plus `src/components/tasks src/components/CmuxWorkspace*` — expect PASS. Run `make test-web` — expect PASS.
- [ ] **Step 5: Manual check** (`make dev`, port 5175): hover a task's worktree chip, move into the card, click switch; cmux changes workspace. Turn off "Enable cmux features" in Settings; the button is gone.
- [ ] **Step 6: Commit** `feat(ui): switch cmux from a workspace's hover card`.

---

### Task 2: Mini-mode plumbing (route detection, bridge, router hook, stream, App shell)

**Files:**
- Create: `ui/src/lib/miniMode.ts`, `ui/src/lib/miniMode.test.ts`
- Create: `ui/src/lib/macBridge.ts`, `ui/src/lib/macBridge.test.ts`
- Create: `ui/src/hooks/useMacUnreadBridge.ts` (test in `macBridge.test.ts` or its own file)
- Create: `ui/src/MiniApp.tsx`
- Create: `ui/src/pages/MiniPage.tsx` (placeholder `<div data-testid="mini-page" />` here; filled in Task 4)
- Modify: `ui/src/App.tsx` (`AuthenticatedApp` branches to `MiniApp`; `ServerUnreachable` posts `unreachable`)
- Modify: `ui/src/hooks/useSSE.ts` (`streamUrl`)
- Modify: `ui/src/pages/LoginPage.tsx` (posts `login`)
- Modify: `ui/src/App.test.tsx`

**Interfaces:**
- Produces (`miniMode.ts`): `MINI_PATH = "/mini"`; `isMiniRoute(pathname = window.location.pathname): boolean`; `openExternal(url: string): void` (absolute URL via `new URL(url, window.location.origin)`; posts `{type:"open",url}` when the bridge exists, else `window.open(url, "_blank", "noopener")`); `useMiniLocation(): ReturnType<typeof useBrowserLocation>`.
- Produces (`macBridge.ts`): `type MacMessage = {type:"unread";unread:boolean;count:number} | {type:"open";url:string} | {type:"ready"} | {type:"login"} | {type:"unreachable"}`; `hasMacBridge(): boolean`; `postToMac(m: MacMessage): void` (no-op without the handler, never throws).
- Produces: `useMacUnreadBridge(): void` — posts `unread` from `unreadBadge(useWorktrees().data)` on mount and on every change.
- Produces: `MiniApp()` component.

Plan addition beyond the spec: `{type:"unreachable"}`, posted by `ServerUnreachable` inside the app, is how the app learns the server went away after the page loaded. The app only switches its icon to disconnected; the page's own 6s countdown does the reload.

- [ ] **Step 1: Write failing tests.**
  - `miniMode.test.ts`: `isMiniRoute("/mini")` true, `isMiniRoute("/")` and `isMiniRoute("/minified")` false. `useMiniLocation keeps /mini query navigation in place`: via `renderHook`, starting at `/mini`, `navigate("/mini?task=t1")` changes `window.location.search` to contain `task=t1` and posts nothing; `navigate("/worktree/%2Fx?resource=pr:1")` leaves `location.pathname` at `/mini` and posts `{type:"open", url:"http://localhost:3000/worktree/%2Fx?resource=pr:1"}` (use `window.location.origin` in the assertion). A navigate to `/mini?home=…` stays in place too.
  - `macBridge.test.ts`: `postToMac` with no `window.webkit` does not throw; with `window.webkit.messageHandlers.worktree.postMessage` stubbed it receives the message. `useMacUnreadBridge` posts `{type:"unread",unread:true,count:2}` for worktrees `[{has_unread:true,unread_count:2}]`, then `{unread:false,count:0}` when the data changes to none unread.
  - `App.test.tsx`: at `/mini` with a session, `sse` is called, `MiniPage` (mock it) renders, and no `POST /api/tabs/presence` request is made; `streamUrl()` at `/mini` has no `tab` param (`new URL(streamUrl(), origin).searchParams.has("tab")` false) and at `/` it does. `LoginPage posts login`: unauthenticated render with the bridge stubbed → `{type:"login"}` posted. `ServerUnreachable posts unreachable`: session error → `{type:"unreachable"}` posted. `ServerUnreachable reloads after 6 seconds`: with fake timers and `window.location.reload` stubbed, the text reads "Reloading the page in 6s…", no reload at 5s, one reload at 6s.
- [ ] **Step 2: Run** `cd ui && npx vitest run src/lib/miniMode.test.ts src/lib/macBridge.test.ts src/App.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement.**
  - `useMiniLocation` wraps `useBrowserLocation`: resolve `to` against `window.location.origin`; if its pathname is `MINI_PATH`, call the browser navigate with `to`; otherwise `openExternal(to)` and do not navigate. Leave `withHomeParam` out (the mini view has no home worktree).
  - `streamUrl()`: when `isMiniRoute()`, return `/api/stream` with no params (server then never registers the tab: `internal/webui/stream.go:25`).
  - `AuthenticatedApp` returns `isMiniRoute() ? <MiniApp /> : <FullApp />`, where `FullApp` is today's body unchanged. `MiniApp` calls `useSSE()`, `useMacUnreadBridge()`, `useTooltipLayer()` (not `useTabPresence`, `useUnreadFavicon`), and renders `<Router hook={useMiniLocation}><SettingsProvider><TaskModalProvider><Switch><Route path="/mini" component={MiniPage} /></Switch><TaskDetailModal /></TaskModalProvider></SettingsProvider></Router>` — no `UpdateBanner`, `HomeWorktreeBanner`, `CmuxFollower`.
  - `LoginPage` and `ServerUnreachable` each `useEffect(() => postToMac({type:…}), [])`.
  - `RELOAD_AFTER_SECONDS = 6` (applies to the full UI and `/mini` alike).
- [ ] **Step 4: Run** the same tests — expect PASS. Run `make test-web` and the type check — expect PASS.
- [ ] **Step 5: Commit** `feat(ui): add a /mini shell that keeps out of notifications and opens other routes externally`.

---

### Task 3: Extract `useActivityPanel` from `HomePage` (no behaviour change)

This commit must change no home page behaviour. Existing `HomePage.test.tsx` assertions stay as they are.

**Files:**
- Create: `ui/src/components/ActivityPanel.tsx`
- Modify: `ui/src/pages/HomePage.tsx`

**Interfaces:**
- Produces, in `ActivityPanel.tsx`:

```ts
export type EventSelectMode = "route" | "details"
export function useActivityPanel(opts: {
  unreadOnly: boolean
  /** Home page search; omitted on /mini. */
  search?: { terms: string[]; debouncedQ: string; queryText: string }
  /** "route" (home): a row opens its worktree, asking which when several follow it. "details" (mini): a row opens EventDetailsModal. */
  select: EventSelectMode
}): {
  controls: ReactNode            // RefreshWatchersButton, MarkAllReadButton (same hiding rule), ArchivedToggle
  render: (top?: ReactNode, headerStyle?: CSSProperties) => ReactNode  // today's timeline()
  modals: ReactNode              // EventDetailsModal + the event ChooseWorktreeModal
  events: TimelineEvent[]
  hasMore: boolean
  sources: string[]
  filtered: boolean              // today's activityFiltered
  clearFilters: () => void       // setSources([])
  pickEvent: (e: TimelineEvent) => void   // search suggestion's event handler
}
```

- [ ] **Step 1: Run** `cd ui && npx vitest run src/pages/HomePage.test.tsx` — record PASS as the baseline.
- [ ] **Step 2: Move code.** Into the hook: `archived` state, `useActivityFilter`, `useGlobalTimeline(archived, sources, unreadOnly, eventTypes, search?.debouncedQ ?? "")`, `pickedEvent`, the event `choosing` state, `openEventIn`, `selectEventResource`, `activityControls`, and `timeline()`, verbatim. `MarkAllReadButton` keeps `!search?.terms.length && !filtered`. In `"details"` mode, `onSelectResource` and `canSelectResource` become "open `EventDetailsModal` for this event" and "always true". `HomePage` keeps its own `ChooseWorktreeModal` for resource choices from search, and uses `activity.sources`, `activity.filtered`, `activity.clearFilters`, `activity.events`, `activity.hasMore`, `activity.pickEvent` where it used the moved locals.
- [ ] **Step 3: Run** `npx vitest run src/pages/HomePage.test.tsx` — expect the same PASS with no test edits. Run `make test-web`, the linter and the type check — expect PASS.
- [ ] **Step 4: Commit** `refactor(ui): move the home page's activity feed into useActivityPanel`.

---

### Task 4: The `MiniPage`

**Files:**
- Modify: `ui/src/pages/MiniPage.tsx`
- Create: `ui/src/pages/MiniPage.test.tsx`
- Modify: `ui/src/components/EventDetailsModal.tsx`, `ui/src/components/tasks/modal/TaskDetailModal.tsx` (`fullScreen={isMiniRoute()}`)
- Modify: `ui/src/components/settings/SettingsContext.tsx` (`?settings` deep link, used by the app's "More settings in web UI")
- Create: `ui/src/components/settings/SettingsContext.test.tsx`

**Interfaces:**
- Consumes: `useActivityPanel` (Task 3), `isMiniRoute`/`openExternal` (Task 2), `postToMac` (Task 2), `useUnreadOnly`, `UnreadOnlyToggle`, `unreadBadge`, `useWorktrees`, `TaskList`, `TaskListToolbar`, `useTaskListPrefs`.

Layout A: header row (`Group`): `Logo` small, spacer, `UnreadOnlyToggle`, `Button` "Open full UI ↗" → `openExternal("/")`. Then `Tabs` (`tasks` | `activity`, default `activity`), Activity tab label carries a `Badge` with the unread count when non-zero. Tasks tab: `TaskListToolbar` + `TaskList scope={{kind:"all"}}` with no `maxRows` and no `expand` (ignores the collapsed preference). Activity tab: `activity.render(activity.controls)`, plus `activity.modals` rendered once. Page `p="xs"`, no fixed width (the popover sizes it).

- [ ] **Step 1: Write failing tests** in `MiniPage.test.tsx` (mock the API the way `HomePage.test.tsx` does):
  - `renders Tasks and Activity tabs`: both tab names present; Activity selected by default.
  - `unreads only narrows the activity feed`: toggling it calls the timeline API with the unread-only parameter (assert on the request URL as `HomePage.test.tsx` does).
  - `tasks tab ignores collapsed`: with `setTaskListPrefs({collapsed:true})` beforehand, the Tasks tab still lists the mocked tasks.
  - `clicking an event opens its details in place`: click a feed row → `EventDetailsModal` content visible, nothing posted to the bridge.
  - `open full UI posts open`: bridge stubbed; click → `{type:"open", url: origin + "/"}`.
  - `posts ready on mount`.
  - In `SettingsContext.test.tsx` (mock `SettingsModal` to render its `opened` and `target.tab`): `opens Settings from ?settings` — start at `/?settings&home=x`; modal opened with no target tab, and `window.location.search` becomes `?home=x`. `opens a tab from ?settings=devices` — target tab `devices`. `ignores an unknown tab` — `?settings=bogus` opens at the default tab. No param → not opened.
- [ ] **Step 2: Run** `npx vitest run src/pages/MiniPage.test.tsx src/components/settings/SettingsContext.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** `MiniPage` as above; `useEffect(() => postToMac({type:"ready"}), [])`. Add `fullScreen={isMiniRoute()}` to both modals. In `SettingsProvider`, a mount-only effect: if `URLSearchParams(window.location.search).has("settings")`, call `open(valid tab ? {tab} : undefined)`, delete the param, and `history.replaceState(history.state, "", pathname + (rest ? "?" + rest : "") + hash)`.
- [ ] **Step 4: Run** the test files and `make test-web` — expect PASS.
- [ ] **Step 5: Manual check** in a browser at `http://localhost:5175/mini` with the window about 420px wide: tabs work, task modal opens via `?task=` and stays on `/mini`, a worktree link opens a new browser tab, tooltips and hover cards stay inside the window.
- [ ] **Step 6: Commit** `feat(ui): add the /mini page with Tasks and Activity, and a ?settings deep link`.

---

### Task 5: Native app source and the `internal/macapp` package

**Files:**
- Create: `internal/macapp/app/main.swift` (entry: `NSApplication`, `.accessory`, delegate)
- Create: `internal/macapp/app/AppDelegate.swift` (status item, popover, web view, bridge handler, navigation delegate, right-click menu)
- Create: `internal/macapp/app/StatusIcon.swift` (glyph drawing and the four states, blink timer)
- Create: `internal/macapp/app/OfflineView.swift` (native "isn't running" view + 6s reload countdown)
- Create: `internal/macapp/app/LoginItem.swift` (reads/writes/deletes the LaunchAgent plist)
- Create: `internal/macapp/app/Info.plist.tmpl`
- Create: `internal/macapp/macapp.go`, `internal/macapp/build.go`, `internal/macapp/launchagent.go`
- Create: `internal/macapp/macapp_test.go`
- Create: `internal/macapp/devbuild/main.go`
- Modify: `Makefile` (`macapp` target, add to `.PHONY`)

**Interfaces:**
- Produces (Go, package `macapp`):
  - `//go:embed app` → `var Source embed.FS` (sub-FS rooted at `app`).
  - `const BundleID = "me.turley.worktree.menubar"`, `const AppName = "Worktree Menu Bar.app"`, `const ExecName = "WorktreeMenuBar"`, `const ServerURL = "http://127.0.0.1:8475"` (build from `config.DefaultHTTPPort`).
  - `func SourceHash(fsys fs.FS) (string, error)` — SHA-256 over every file, sorted by path, each contributing `path + "\x00" + contents + "\x00"`; hex.
  - `type Paths struct { App, LaunchAgent string }`; `func DefaultPaths(home string) Paths` (`~/Applications/<AppName>`, `~/Library/LaunchAgents/<BundleID>.plist`).
  - `func InstalledHash(appPath string) (hash string, ok bool)` — reads `Contents/Info.plist`, extracts `<key>WorktreeSourceHash</key>` + `<string>…</string>`; ok=false if the bundle or key is missing.
  - `type Runner func(name string, args ...string) ([]byte, error)`.
  - `func Build(fsys fs.FS, appPath string, run Runner) error` — compiles every `*.swift` with `swiftc -O -o <staging>/Contents/MacOS/WorktreeMenuBar …` into a staging dir beside `appPath`, writes `Info.plist` from the template (`{{.BundleID}}`, `{{.ExecName}}`, `{{.ServerURL}}`, `{{.SourceHash}}`), then replaces `appPath` atomically (rename old away, rename staging in, remove old).
  - `func LaunchAgentPlist(appPath string) []byte` — keys `Label` (BundleID), `ProgramArguments` ([`<appPath>/Contents/MacOS/WorktreeMenuBar`]), `RunAtLoad` true. `LoginItem.swift` must write byte-identical content (copy the format; a comment in each points at the other).
- Swift behaviour:
  - Initial icon state `.disconnected`. States: `.resting` (template glyph), `.unread` (glyph + `systemBlue` dot, alternating with resting every 0.6s), `.disconnected` (glyph alpha 0.4 + slash), `.needsLogin` (glyph alpha 0.4 + `lock.fill` badge).
  - Web view loads `ServerURL + "/mini"` from `Info.plist` key `WorktreeServerURL` at launch and stays alive while the popover is closed. Popover `.transient`, content size 420×640.
  - Bridge `worktree`: `unread` → resting/unread; `ready` → resting (until next unread); `login` → needsLogin; `open` → `NSWorkspace.shared.open`; `unreachable` → icon disconnected only (the page's own 6s countdown reloads it; if that reload fails at the network level, the navigation delegate shows OfflineView).
  - `WKNavigationDelegate`: `decidePolicyFor` sends link-activated navigations and any main-frame navigation whose URL is not `ServerURL` + `/mini…` to the browser and cancels; `createWebViewWith` (`window.open`) opens in the browser and returns nil. `didFailProvisionalNavigation`/`didFail` → OfflineView.
  - OfflineView: title "The worktree UI isn't running", body "Start it with `worktree ui`.", footnote "Reloading in Ns…" counting down from 6 once a second. At zero, reload the web view (it stays hidden behind OfflineView). `didFinish` swaps the web view back in; another failure restarts the countdown.
  - Left click toggles the popover; right click (`sendAction(on: [.leftMouseUp, .rightMouseUp])`, check `NSApp.currentEvent?.type`) shows menu: "Open full UI" (opens `ServerURL`), "Reload", "Open at login" (checkmark = plist exists; toggles via LoginItem), "More settings in web UI" (opens `ServerURL + "/?settings"`), separator, "Quit".
  - `Info.plist.tmpl` includes `LSUIElement` true, `NSAppTransportSecurity` → `NSAllowsLocalNetworking` true, `CFBundleIdentifier`, `CFBundleExecutable`, `WorktreeServerURL`, `WorktreeSourceHash`.

- [ ] **Step 1: Write failing Go tests** in `macapp_test.go` (all `t.Parallel()`):
  - `TestSourceHashStable`: same `fstest.MapFS` twice → equal hashes, 64 hex chars.
  - `TestSourceHashChangesWithAnyFile`: changing one file's contents, adding a file, or renaming a file each changes the hash.
  - `TestSourceHashEmbedded`: `SourceHash(Source)` succeeds and covers `main.swift` (hash differs from a MapFS without it).
  - `TestInstalledHash`: temp bundle with an `Info.plist` containing the key → `(hash, true)`; no bundle → `("", false)`; plist without the key → `("", false)`.
  - `TestBuildRunsSwiftcAndWritesPlist`: fake `Runner` records args and creates the output file named after `-o`; after `Build`, `<app>/Contents/Info.plist` contains `me.turley.worktree.menubar`, `http://127.0.0.1:8475` and the hash; args start with `swiftc -O -o` and include every `.swift` file.
  - `TestBuildFailureKeepsOldApp`: existing app dir with a marker file; `Runner` returns an error → error returned, marker still present, no staging dir left.
  - `TestLaunchAgentPlist`: contains `<key>Label</key>` + `<string>me.turley.worktree.menubar</string>`, the executable path, `<key>RunAtLoad</key>` + `<true/>`.
- [ ] **Step 2: Run** `go test ./internal/macapp/` — expect FAIL.
- [ ] **Step 3: Implement** the Go files, then the Swift files per the behaviour list.
- [ ] **Step 4: Run** `go test ./internal/macapp/` — expect PASS.
- [ ] **Step 5: Add** `devbuild/main.go` (builds into `bin/Worktree Menu Bar.app` with an `exec.Command` runner) and Makefile target `macapp: ; go run ./internal/macapp/devbuild`. Run `make macapp` — expect the bundle; `codesign -dv "bin/Worktree Menu Bar.app" 2>&1 | grep Signature` → `Signature=adhoc`.
- [ ] **Step 6: Measure compile time — STOP and report.** Cold: `rm -rf "$(getconf DARWIN_USER_CACHE_DIR)/org.llvm.clang/ModuleCache" "$(getconf DARWIN_USER_CACHE_DIR)/clang/ModuleCache" ~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex 2>/dev/null; time make macapp`. Warm: `time make macapp` again. Report both to Mike. If cold is much over ~20s, stop the plan here for his decision (binary releases); otherwise continue.
- [ ] **Step 7: Manual check** with `open "bin/Worktree Menu Bar.app"`:
  - With `worktree ui` stopped: the icon is disconnected and the dropdown shows the offline view.
  - Start it: within ~6s the dropdown loads `/mini` (login once); the countdown visibly runs from 6.
  - Stop the server with the dropdown loaded: the page's "Reloading the page in 6s…" shows, the icon turns disconnected, then the native view takes over and counts down from 6; restart the server and it recovers.
  - Create unread activity (or mark something unread): the icon blinks; mark all read stops it.
  - Opening a task opens its modal inside; a worktree link opens the browser; GitHub links open the browser.
  - Right-click menu items work. Stop the server again: the app falls back to offline.
- [ ] **Step 8: Commit** `feat(macapp): add the menu bar app source and its embedded build`.

---

### Task 6: `worktree setup` installs and rebuilds the app

**Files:**
- Create: `internal/setup/macapp.go`, `internal/setup/macapp_test.go`
- Modify: `internal/setup/setup.go` (`Plan` field, `BuildPlan`, `Preview`, `HasWork`, `Execute`)
- Modify: `internal/ui/ui.go` (add `func NonInteractive() bool { return nonInteractive }`)

**Interfaces:**
- Consumes: `macapp.Source`, `SourceHash`, `DefaultPaths`, `InstalledHash`, `Build`, `LaunchAgentPlist`, `Runner` (Task 5).
- Produces:

```go
type MacAppAction int
const (
    MacAppNone MacAppAction = iota  // not macOS, or installed and current
    MacAppNoSwiftc                  // macOS, swiftc missing: preview a hint only
    MacAppOfferInstall              // interactive, not installed
    MacAppSkipUnattended            // non-interactive, not installed
    MacAppRebuild                   // installed, hash differs
)
type macAppState struct { GOOS string; HaveSwiftc, NonInteractive, Installed bool; InstalledHash, SourceHash string }
func decideMacApp(s macAppState) MacAppAction
type macAppDeps struct { Paths macapp.Paths; LookPath func(string) (string, error); Run macapp.Runner; Confirm func(string, bool) bool }
func defaultMacAppDeps() macAppDeps
func runMacAppStep(a MacAppAction, d macAppDeps) error
```

- [ ] **Step 1: Write failing tests** in `internal/setup/macapp_test.go`:
  - `TestDecideMacApp` table: linux → None; darwin no swiftc → NoSwiftc; darwin, not installed, interactive → OfferInstall; same non-interactive → SkipUnattended; installed, equal hash → None; installed, different hash → Rebuild (both interactive and not). `decide: missing bundle is not installed`: `Installed:false` with a stray plist still yields OfferInstall.
  - `TestRunMacAppInstallAsksLogin`: OfferInstall with Confirm answering yes, yes → `Build` ran, plist written with `LaunchAgentPlist` bytes, `open` run on the app. Yes, no → no plist, `open` still run. No → nothing built.
  - `TestRunMacAppRebuildKeepsLoginChoice`: Rebuild with no plist → still no plist after; with a plist whose contents are stale → rewritten to current bytes; with a current plist → unchanged; app "running" (fake `Run` answers `pgrep -x WorktreeMenuBar` with a PID) → quit via `osascript -e 'quit app id "me.turley.worktree.menubar"'` then `open`; not running → no `open`.
- [ ] **Step 2: Run** `go test ./internal/setup/ -run MacApp` — expect FAIL.
- [ ] **Step 3: Implement.** `BuildPlan` fills `Plan.MacApp` from `decideMacApp` (real `runtime.GOOS`, `exec.LookPath("swiftc")`, `ui.NonInteractive()`, `InstalledHash`, `SourceHash(macapp.Source)`). `HasWork` includes `MacApp == MacAppOfferInstall || MacApp == MacAppRebuild`. `Preview` lines: OfferInstall `  • Offer to install the menu bar app (~/Applications/Worktree Menu Bar.app)`; Rebuild `  • Rebuild the menu bar app (its source changed)`; NoSwiftc dim `  — Install the Xcode Command Line Tools (xcode-select --install) to add the menu bar app`; SkipUnattended dim `  — Menu bar app not installed; run worktree setup interactively to install it`. `Execute` calls `runMacAppStep` last; prompts `Install the worktree menu bar app?` (default yes) and `Start it at login?` (default yes); a build error prints a yellow `!` line and does not fail setup.
- [ ] **Step 4: Run** `go test ./internal/setup/ ./internal/ui/` — expect PASS.
- [ ] **Step 5: Manual check:** `make build && bin/worktree setup` → asked twice, app installed and running. `bin/worktree setup` again → no menu bar line under "will", no compile. Touch a Swift file's contents and rebuild the binary → setup says Rebuild and restarts the app. `NONINTERACTIVE=1`-style `bin/worktree setup --yes` on a machine without the app → only the dim hint.
- [ ] **Step 6: Commit** `feat(setup): offer to install the menu bar app and rebuild it when its source changes`.

---

### Task 7: Uninstall: `--uninstall` and `--uninstall-mac-app`

**Files:**
- Modify: `internal/setup/macapp.go` (add uninstall), `internal/setup/macapp_test.go`
- Modify: `internal/setup/setup.go` (`PreviewUninstall`, `ExecuteUninstall`)
- Modify: `cmd/setup.go` (flag and branch)

**Interfaces:**
- Produces: `func PreviewMacAppUninstall(p macapp.Paths) (any bool)` (prints `  • Remove the menu bar app: <path>` and `  • Remove its login item: <path>` for whichever exist; returns whether anything exists); `func UninstallMacApp(d macAppDeps) error` (quit the app as in Task 6, `launchctl bootout gui/<uid>/me.turley.worktree.menubar` ignoring errors, delete plist, delete app, delete `~/Library/WebKit/me.turley.worktree.menubar` if present).
- Flag: `--uninstall-mac-app` ("Remove only the macOS menu bar app"), mutually exclusive with `--uninstall`.

- [ ] **Step 1: Write failing tests:** `TestUninstallMacAppRemovesBoth` (temp paths, both deleted, `osascript` and `launchctl` invoked via fake `Run`); `uninstall removes a stray plist` (no app, plist present → plist deleted, no error); `TestUninstallMacAppNothingInstalled` (neither exists → `PreviewMacAppUninstall` false, `UninstallMacApp` nil error, `Run` never called).
- [ ] **Step 2: Run** `go test ./internal/setup/ -run Uninstall` — expect FAIL.
- [ ] **Step 3: Implement.** `PreviewUninstall`/`ExecuteUninstall` include the mac app on darwin. In `cmd/setup.go`, `--uninstall-mac-app`: on non-darwin print "The menu bar app is macOS only." and return nil; if `PreviewMacAppUninstall` reports nothing, print "The menu bar app is not installed." and return nil; otherwise `ui.Confirm("Proceed?")` unless `--yes`, then `UninstallMacApp`. Nothing else runs.
- [ ] **Step 4: Run** `go test ./internal/setup/ ./cmd/` — expect PASS.
- [ ] **Step 5: Manual check:** `bin/worktree setup --uninstall-mac-app` removes the app and plist and quits it; a second run says it is not installed.
- [ ] **Step 6: Commit** `feat(setup): remove the menu bar app with --uninstall or --uninstall-mac-app`.

---

### Task 8: Docs and the end-to-end check

**Files:**
- Modify: `README.md` (setup section: the menu bar app, `--uninstall-mac-app`, "Open at login")
- Modify: `docs/web-ui-architecture.md` (new "Mini view and menu bar app" section: `/mini`, `MiniApp`, `useMiniLocation`, the bridge messages, why the stream omits `tab`, `useActivityPanel`, switch-cmux buttons)
- Modify: `.claude/CLAUDE.md` (Project Structure entry for `internal/macapp`; `make macapp` under Build & Test)

- [ ] **Step 1: Write the docs** above.
- [ ] **Step 2: Full verification:** `make test` — expect PASS. `make build` — expect PASS.
- [ ] **Step 3: End-to-end manual check** (spec "Testing → Manual"): install via `make install` (interactive); a second `make install` does not recompile; log in once; the icon blinks and stops; task and event modals open inside; a worktree link opens the browser; the switch-cmux button works from the dropdown's hover cards; stop `worktree ui` → disconnected icon and message, start → recovers; toggle "Open at login" off and on (plist disappears/reappears); `worktree setup --uninstall-mac-app` removes everything.
- [ ] **Step 4: Commit** `docs: document the menu bar app and the /mini view`.
