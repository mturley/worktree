# macOS menu bar app: a mini view of Tasks and Activity — design

**Status:** Design (2026-10-29).

## Intent

Mike keeps a pinned browser tab on the worktree home page so he can stay aware of new unread activity and see his open tasks. That tab gets buried among his windows. Checking it means bringing up a window and, if the tab has wandered off the home page, navigating back. Notifications (cmux and browser) already announce new activity, but there is no always-visible "is anything unread?" signal and no quick glance at tasks.

The menu bar app is a **supplement** to the web UI, not a replacement for it. It does two things:

1. A menu bar icon that **blinks blue while anything is unread**, the same signal as the favicon, but somewhere that is never buried.
2. A **dropdown** with two tabs, Tasks and Activity, that shows the same views the home page shows. Task details and event details open as modals inside the dropdown. Anything else opens the full web UI in the default browser.

**Success:** Mike can see whether anything is unread from any app, and check his tasks or recent activity in one click, without finding the pinned tab.

## Goals

- **One source of truth for the views.** The dropdown renders the web UI's own Tasks and Activity components, served by the running `worktree ui`, at a new route `/mini`. A future change to the tasks view or the activity list shows up in both places with no extra work. This is the core requirement.
- **Unread icon** in the menu bar: the favicon's purple tile when nothing is unread, blinking to the web UI's unread blue when anything is unread (same definition and same rhythm as the favicon), a dimmed "disconnected" look when the server is not reachable, and a dimmed "needs login" look when the dropdown has no session.
- **Dropdown layout A** (chosen from mockups): a header with the logo, the home page's search bar (same query, suggestions and `/` and Esc keys), the "Unreads only" toggle and "Open full UI ↗"; then the Activity and Tasks tabs (Activity first and selected by default), with the active tab's controls at the tab bar's far end (refresh, Mark all read and Show archived; sort and Show completed); then the tab's content. About 600×640. *The search bar and tab order are Mike's later asks; a worktree or resource picked from the search opens in the browser, an event or task opens in place.*
- **"Switch cmux" buttons in hover cards, everywhere (not just the mini view).** Wherever a hover card shows a cmux workspace's colour bar and name, a small button beside the name switches cmux to that workspace, so Mike can move the mouse into the card and switch instead of opening a browser tab.
- **Modals stay inside the dropdown:** the task detail modal and the event details modal.
- **Everything else opens in the browser:** any navigation to another route (a worktree page, a resource, settings) opens the full web UI at that URL in the default browser. External links (GitHub, Jira, Slack) also open in the browser.
- **Graceful failure when the server is not running:** the dropdown shows "The worktree UI isn't running. Start it with `worktree ui`." It reloads itself every 6 seconds, like the web UI does, and shows `/mini` once the server answers. The icon shows the disconnected state meanwhile. The web UI's own reload countdown drops from 10 to 6 seconds too.
- **`worktree setup` offers to install it on macOS**, **`worktree setup --uninstall` removes it** along with the rest of setup, and **`worktree setup --uninstall-mac-app` removes only the app**. (There is no separate `worktree uninstall` command; uninstall is the `--uninstall` flag on setup.)
- **No interference with existing notifications.** The app must not change who receives cmux or browser notifications, or how they are delivered.

## Non-goals

- **Native notifications.** Out of scope for this pass (Mike may revisit). cmux and browser notifications stay the way you are notified.
- **Mini-view-specific filters or settings.** The dropdown uses the home page's filters and defaults as they are. Mike may tweak them for the mini view after using it.
- **A remembered "no" for the install prompt.** No new config key; see "Setup step".
- **A configurable UI port.** There is no config key for it today (only `worktree ui --port`), so the app always uses `config.DefaultHTTPPort` (8475).
- **A Resources tab, a worktree list, the search box, Settings or the cmux panel** in the dropdown.
- **Support for non-macOS platforms.** On Linux the setup step is simply absent.
- **Signed or notarised builds, or binary releases.** Not in this pass (see "Install" for when to reconsider).

## Anti-goals

- **A second copy of the Tasks or Activity UI.** Any fork of those components for the mini view defeats the point. Differences go through props or a mini-mode context, not copied JSX.
- **A second definition of "unread".** The icon uses the same `unreadBadge` computation the favicon uses, passed from the page to the app; the Swift side never computes unread itself.
- **Stealing notifications.** The dropdown must not register as a tab for notification delivery.
- **A heavy setup step.** If building the app turns out to take a long time, stop and reconsider before adding it to `worktree setup` (see "Install").
- **Nagging permission prompts.** The design needs no macOS permissions; if one becomes necessary, stop and discuss.

## How it works

### Architecture

```
menu bar icon ──click──► dropdown (NSPopover) ──► WKWebView ──► http://127.0.0.1:<port>/mini
     ▲                                                  │
     └──── {unread, count} via JS message bridge ◄──────┘
                                                        │
              navigation to any other route / external link ──► default browser
```

- **Native shell:** a small AppKit app in Swift (`NSStatusItem` + `NSPopover` containing a `WKWebView`), with no Xcode project, built with plain `swiftc`. A throwaway probe of this shape (status item, popover, web view, message bridge, link interception) was about 50 lines. *My call: AppKit over SwiftUI's `MenuBarExtra`, because the probe proved AppKit works with plain `swiftc` and gives direct control over the popover and the icon.*
- **The app is a dock-less accessory app** (`setActivationPolicy(.accessory)`): no Dock icon, no app menu.
- **The web view stays loaded while the dropdown is closed**, so its event stream keeps running and the icon stays current. Closing the dropdown hides it; it does not unload the page.
- **The URL is built in.** The port is fixed (see Non-goals), so the app's `Info.plist` template carries `http://127.0.0.1:8475` (from `config.DefaultHTTPPort`, substituted at build time). The app works the same however it was launched: at login, from `~/Applications`, or from Spotlight. It does not read worktree's config itself.
- **Right-clicking the icon** shows a small menu: "Open full UI", "Reload", "Reset dropdown to default size", "Open at login" (a checkmark item), "Use purple wt icon" and "Flash icon on unread activity" (checkmark items, on by default), "More settings in web UI", "Quit". *My call, except "Reset dropdown to default size", "Use purple wt icon", "Flash icon on unread activity", "Open at login" and "More settings in web UI", which Mike asked for.* The dropdown is 600×640 by default and resizable from a grip in its bottom-right corner (Mike's ask); double-clicking the grip also resets it. "More settings in web UI" opens `http://127.0.0.1:8475/?settings` in the browser: the full UI's home page with the Settings modal open. This needs a small web UI addition: `SettingsProvider` opens the modal when the page loads with a `settings` query parameter (optionally `settings=<tab>`, one of `SettingsTarget["tab"]`), then removes the parameter from the URL so a reload doesn't reopen it.
- **Starting at login is optional.** It is a LaunchAgent at `~/Library/LaunchAgents/<label>.plist` with `RunAtLoad`. The plist existing is the only record of the choice. There is no config key and no separate preference. "Open at login" in the right-click menu shows a checkmark when the plist exists. Clicking it writes or deletes the plist (no `launchctl` needed: deleting it just stops the next login start, and the running app keeps running). That needs no permission, since the folder is the user's own. macOS may also list the item under System Settings → General → Login Items; turning it off there is honoured by macOS but does not delete the plist, so the checkmark can disagree. That is acceptable for this pass.

### Frontend: the `/mini` route

A new route `/mini` in `ui/src/App.tsx` renders a `MiniPage`. It uses the same session cookie, event stream, React Query cache and providers (`SettingsProvider`, `TaskModalProvider`, `TaskDetailModal`) as every other page.

**Shared components, not copies.** The Activity tab's contents are currently assembled inline in `HomePage.tsx`: the controls (`RefreshWatchersButton`, `MarkAllReadButton`, `ArchivedToggle`), the `SourceFilter` and `EventTypeFilter`, `useActivityFilter`, `useGlobalTimeline`, `TimelineFeed`, the event details modal state (`pickedEvent`), `openEventIn`, `selectEventResource` and the choose-a-worktree flow. Extract these into a shared component (working name `ActivityPanel`) that both `HomePage` and `MiniPage` render. The home page's behaviour must not change; the extraction lands as its own commit with the existing `HomePage` tests passing unchanged. The Tasks tab uses `useTasksPanel(HOME_TASKS)` and `TaskList` the same way `HomePage` does; extract a shared component there too if the home page's assembly of it is more than a few lines.

The home page's search box narrows the feed today. The mini view has no search box, so the shared component must work with no search narrowing.

**Filters and settings** are the home page's: same defaults and same controls. Note that the filter state is plain React state (`useActivityFilter` uses `useState`), and the web view has its own cookie and storage separate from the browser, so nothing a user sets in one shows up in the other. That is expected.

**Header (layout A):** the "Unreads only" toggle and "Open full UI ↗". "Open full UI ↗" opens `/` in the browser. The Activity tab badge shows the unread count when there is one.

- **"Unreads only"** is the home page's toggle (`useUnreadOnly`, today rendered in `HomeHeader`), reused as is. It narrows the Activity tab exactly as it narrows the home page's feed, so `ActivityPanel` takes `unreadOnly` from its caller. The preference lives in the web view's own localStorage, independent of the browser's. On the home page, turning it on also collapses the task panel (`setTaskListPrefs`); in the dropdown, Tasks is its own tab, so the Tasks tab ignores the collapsed preference and always shows the list. *My call.*
- **"Mark all read"** stays where the home page has it: in the Activity tab's controls beside Refresh and Archived, inside `ActivityPanel`, hidden while a filter narrows the feed, exactly as today. *My call*: mockup A had it in the header, but there it would show on both tabs and could not follow the hiding rule without lifting the filter state out of the shared panel.

**What is turned off on `/mini`.** These are mounted app-wide in `App.tsx` today and must not run on `/mini`:

- `useTabPresence` (the dropdown must not be a notification delivery target; see "Notifications" below),
- `CmuxFollower` (it navigates on its own),
- `HomeWorktreeBanner` and `UpdateBanner`,
- `useUnreadFavicon`'s title and favicon writes are harmless in a web view, but it may simply be replaced on `/mini` by the bridge hook below.

`useSSE` and the providers stay on.

**Navigation out of the dropdown.** In-app navigation is client-side (wouter `pushState`), so the native side cannot see it. Intercept it in the router: `App.tsx` already passes a custom hook to `<Router hook={useHomeLocation}>`. On `/mini`, use a mini-mode location hook instead. Navigation that only changes the mini page's own query (`?task=<id>`, and whatever the event modal uses) applies in place. Navigation to any other path calls `openExternal(url)`, which opens the full web UI at that absolute URL in the browser. `openExternal` posts to the native bridge when it exists and falls back to `window.open` otherwise, so `/mini` also works in a normal browser tab for development. Plain `<a href>` links to external sites (GitHub, Jira, Slack) are caught natively (below).

The deep-link targets used by notifications (`notificationHref` in `ui/src/lib/browserNotify.ts`) show the URL shapes that matter: `/worktree/<path>`, `?resource=…`, `?task=…`. A task link inside the dropdown opens the task modal in place. A resource or worktree link opens the browser.

**Narrow layout.** The dropdown is about 600px wide. The task and event modals render full-screen inside it (Mantine `fullScreen` when on `/mini`, or below a width breakpoint). Hover cards and tooltips must not overflow the web view; check the ones in `TimelineFeed` rows and task rows.

### The native bridge

The page talks to the app through `window.webkit.messageHandlers.worktree.postMessage(...)`, wrapped in one small module (`ui/src/lib/macBridge.ts`) that is a no-op when the handler does not exist.

Messages from the page to the app:

| Message | When | App does |
|---|---|---|
| `{ type: "unread", unread: bool, count: number }` | on load and whenever `unreadBadge(useWorktrees().data)` changes | starts or stops blinking the dot |
| `{ type: "open", url: string }` | navigation leaving `/mini` (absolute URL) | opens the URL in the default browser |
| `{ type: "ready" }` | `/mini` rendered with a session | clears the disconnected and needs-login states |
| `{ type: "login" }` | the login page rendered inside the app | shows the needs-login icon |

The app also uses `WKNavigationDelegate` to send any link-activated navigation or `window.open` to a non-`/mini` URL to the default browser (`NSWorkspace.shared.open`). This catches external links without frontend changes.

The unread hook reuses `unreadBadge` from `ui/src/lib/unreadBadge.ts`, and it is mounted beside `useSSE` on `/mini`, exactly as `useUnreadFavicon` is mounted elsewhere, so it updates from the same `["worktrees"]` query the event stream already invalidates. The app owns the blink timer. It should match the favicon's rhythm (see `ui/src/lib/blinkTicker.ts`).

### Icon

- **Resting:** the favicon's tile: purple (#5b21b6) with a white monogram, drawn from favicon.svg's glyph path. A full colour image, so the blink is a whole tile changing colour and stays visible on a tinted menu bar. With "Use purple wt icon" off (kept in the app's defaults), the tile is a template image with the monogram cut out, white or black to follow the menu bar.
- **Unread:** the tile filled with the web UI's unread blue (Mantine blue-5, #339af0) with a white monogram, alternating with the resting tile on the favicon's rhythm. A steady blue dot sits on the tile's top-right corner through both frames, in a notch cut from each so it reads apart from the blue tile. With "Flash icon on unread activity" off there is no blink, just the resting tile with the dot; like the blue frame, it is not a template image, so it stays blue.
- **Disconnected:** the glyph dimmed with a slash.
- **Needs login:** the glyph dimmed, distinct from disconnected (for example a small lock or person badge instead of the slash). It must never look like the resting state, because "plain" would falsely say nothing is unread.

The glyph itself is the builder's call. A simplified version of the worktree logo (`ui/src/components/Logo.tsx`, `favicon.svg`) is the obvious starting point.

### Login and the server not running

- **Login:** the dropdown shows the existing `LoginPage` when there is no session, because `App.tsx` already does that for any route. The web view keeps its cookies across launches (default `WKWebsiteDataStore`). The session is a separate login from the browser's and shows up as its own entry under Settings → Devices. Sessions expire a fixed 30 days after login (`internal/uisession`), so this recurs about monthly; that is accepted. `LoginPage` posts `{ type: "login" }` through the bridge (a no-op outside the app), and the icon shows the needs-login state until `ready` arrives.
- **Server not running, and auto-reload:** the dropdown behaves like the full web UI, which reloads itself when it can't reach the server, because that happens on every reinstall while Mike develops. The countdown is **6 seconds in both places** (today the web UI's `RELOAD_AFTER_SECONDS` in `ui/src/App.tsx` is 10; change it to 6).
  - When the page has loaded and then loses the server (for example during `make install`'s restart), the page's own `ServerUnreachable` screen shows in the dropdown and reloads after 6s, exactly as in the browser. It also tells the app (`unreachable`), which shows the disconnected icon.
  - When a load fails at the network level (connection refused, so there is no page to show a countdown), the app shows its own native view: "The worktree UI server isn't running.", "Start it in a terminal with" over `worktree ui` in its own code box, "To enable cmux features, start it within a cmux terminal." and "Waiting for it to start…". It has no countdown (*Mike's later ask: the 6s countdown matters only in the web UI*): the app blanks the web view, so the failed page's scripts stop retrying behind it, and asks the server directly every 2s (`ServerWatch`). The first HTTP answer of any kind reloads the last /mini URL, and the page swaps back in.
  - The icon stays disconnected until the page sends `ready` or `login`.
- **Security checks:** the request-forgery guard (`internal/webui/middleware.go`) compares `Origin` against the request's host. The web view loads the page from the same origin, so this should pass as is, but test that writes (mark read, task edits) work from the dropdown. Loopback HTTP is allowed in a web view; the app may need `NSAllowsLocalNetworking` in its `Info.plist` for App Transport Security.

### Notifications

Out of scope, with one requirement. The server sends a browser notification to **one tab per login session** (`internal/webui/tabs.go`, `Deliver`), and the dropdown is a separate session. If it registered tab presence, the server would offer it every notification. The web view has no notification API, so it would decline each one: no duplicates, but extra round trips and a misleading Devices/tabs picture. So `/mini` does not call `useTabPresence` at all, **and its event stream URL omits the `tab` parameter**: the stream itself registers a tab when that parameter is present (`internal/webui/stream.go`, `streamUrl` in `ui/src/hooks/useSSE.ts`), so skipping the presence hook alone would not be enough.

If native notifications are wanted later, the bridge is the path: the page hands the notification to the app, and the server ranks the app below any browser tab. That is not designed here.

### Install, update and uninstall

**Build locally.** The worktree binary embeds the app's Swift source and `Info.plist` (`go:embed`). On macOS, `worktree setup` builds the app on the user's machine with `swiftc` into `~/Applications/Worktree Menu Bar.app` (name is my call). This works the same for `make install` and `go install` users. An app compiled locally carries no quarantine attribute, so Gatekeeper does not block it, and `swiftc` signs it ad hoc automatically on Apple Silicon (verified with the probe: `Signature=adhoc`). No Apple developer account, notarisation or permission prompt is involved.

**Compile time: measure first.** Mike does not want `worktree setup` to include a heavy compile. The probe took about 15.6s the first time on this machine, most of it a one-time build of Swift's system module cache, and about 0.9s after that. **As soon as the real app compiles, measure a cold build** (clear `~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex`, or the cache path `swiftc` reports) and a warm one, and report both to Mike before wiring the build into setup. If the cold build is much more than about 20s, stop: binary releases (prebuilt, ad-hoc signed, downloaded by setup, with the quarantine attribute removed) are the alternative, and Mike will decide.

**Setup step** (in `internal/setup`, alongside the existing steps in `BuildPlan`):

- Only on macOS (`runtime.GOOS == "darwin"`).
- If `swiftc` is not on `PATH`, show "Install the Xcode Command Line Tools (`xcode-select --install`) to add the menu bar app" and skip; this is not an error.
- **Not installed, interactive:** ask "Install the worktree menu bar app?" every run (default yes). A "no" is not remembered.
- **Not installed, non-interactive** (`--yes`, as `make install` runs it): never install. An unattended run must not start a compile nobody chose. Preview says how to install it (run `worktree setup` interactively).
- **Installed:** rebuild only when the **app source has changed**, not whenever the worktree binary changes. At Go build time nothing extra is needed: setup computes a SHA-256 over the embedded `macapp/` files (sorted paths plus contents) at runtime, writes it into the built bundle's `Info.plist` (for example under a `WorktreeSourceHash` key), and on later runs compares the installed bundle's hash against the embedded one. Equal: nothing to do, and the step does not appear as work. Different: rebuild without asking, in both interactive and non-interactive runs, since the user already chose to have the app. So most `make install` runs never invoke `swiftc`.
- **Starting at login:** on a fresh interactive install, ask a second question, "Start it at login?" (default yes), and write the LaunchAgent plist (label is the builder's call, for example `me.turley.worktree.menubar`) only on yes. Then launch the app (`open`) either way. On a rebuild, **never** add or remove the plist: that choice now belongs to the app's "Open at login" item. If the plist exists but its contents are outdated (for example the app path changed), rewrite it in place.
- **Restart after a rebuild:** if the app is running, quit it and relaunch the new build (for example `osascript -e 'quit app id "<bundle id>"'`, then `open`), so `make install` leaves the current build running. If it was not running, leave it stopped.
- Show the step in `Plan.Preview` like the other steps.

**Uninstall:** `launchctl bootout` the agent, delete the plist, and delete the `.app`. List both paths in the preview. The web view's cookies and storage under `~/Library/WebKit/<bundle id>` and `~/Library/Containers` (if any) may be removed too; the builder's call. Two entry points share one implementation:

- `worktree setup --uninstall` (`setup.PreviewUninstall` / `ExecuteUninstall`) includes it with everything else.
- `worktree setup --uninstall-mac-app` removes only the app: same preview and "Proceed?" confirmation pattern as `--uninstall` (skipped under `--yes`), and it touches nothing else. On a machine without the app it says so and exits 0. It is not offered on non-macOS. A later interactive `worktree setup` will offer to install it again, since a "no" is not remembered.

**Where the source lives:** a new top-level directory (for example `macapp/`) with the Swift source, `Info.plist` template and icon assets, plus a Go package that embeds them and does the build (for example `internal/macapp`). Add a `make` target that builds the app directly for development.

### "Switch cmux" in hover cards (all views)

In the dropdown, following a worktree link means opening a browser tab, and often what Mike actually wants is to jump cmux to that worktree's workspace. So every hover card that shows a cmux workspace's colour bar and name gets a small "switch cmux" button beside the name. This applies everywhere these hover cards appear, in the full UI as well as the mini view. It is independent of the menu bar app and can land first.

- **Where:** the hover cards in `ui/src/components/tasks/LinkHoverCards.tsx`. `WorktreeDetails` (inside `WorktreeHoverCard`, used by `WorktreeName`, task rows and the task modal's links) renders each workspace as `ColorBar` + title, and gets the button. `ResourceHoverCard` renders `AllResourceSummary` with `preview={false}`; if the worktree lines it shows include workspace names (`WorktreesLine`), those get the button too, but only inside a hover card, not in the Resources tab's own rows. The builder should search for any other hover card or tooltip that renders a workspace's colour and name and treat it the same way.
- **What it does:** `api.cmuxSelect(ws.ref)`, the same call `CmuxWorkspaceHeader` and `CmuxWorkspaceSection` already make, then invalidate `["cmux"]` as they do. Share that mutation through a small hook rather than writing a third copy.
- **Shown only when cmux is usable:** `useCmuxMatches` already returns nothing when cmux is unavailable, and the server's `/api/cmux` reports unavailable when the Settings modal's "Enable cmux features" toggle is off; confirm that, so the button never appears with cmux disabled.
- **Interaction:** a compact subtle icon button with a "Switch cmux to this workspace" tooltip or aria-label. The click must not reach what holds the hover card's target (use the existing `keepInside`), and the hover card must stay open while the mouse moves from the target into it; check `closeDelay` (100ms today) is long enough to cross the gap. The `Preview` comment says hover cards are "something to read, not use"; update it, since they now carry an action.
- **Feedback:** the button shows a loading state while the call runs and an error state (a tooltip with the error) if it fails. Success needs nothing more; cmux moving is the feedback.

### Testing

- **Frontend (vitest):** `MiniPage` renders the Tasks and Activity tabs with the shared components; the mini location hook applies `?task=` in place and calls `openExternal` for other paths; `/mini` does not call `useTabPresence`; the bridge module posts `unread` when the badge changes and is a no-op without the handler.
- **Unreads only and login:** the mini header's toggle narrows the Activity tab; the Tasks tab shows its list with the toggle on; `LoginPage` posts `login` through the bridge.
- **Switch cmux:** the hover card shows the button per workspace when cmux is available and not otherwise; clicking calls `cmuxSelect` with the workspace's ref and does not trigger the card's target (for example, does not open a task's modal).
- **Refactor safety:** the `ActivityPanel` extraction keeps every existing `HomePage` test passing without edits to their assertions.
- **Go:** the setup step's plan and preview on darwin vs. other platforms (inject `GOOS` and the `swiftc` lookup); interactive vs. non-interactive when not installed (non-interactive never installs); the source-hash comparison (equal → no work, different → rebuild); the hash is stable for the same files and changes when any embedded file changes; the LaunchAgent plist contents; the login question writes the plist only on yes, and a rebuild never adds or removes it; `--uninstall` and `--uninstall-mac-app` both remove the app and the plist (if present), and `--uninstall-mac-app` touches nothing else. Follow the repo's Go test rules (parallel by default; serial if a test sets env or package vars).
- **Manual:** install via setup; run `make install` again and confirm it does not recompile; log in once; icon blinks on new unread and stops on mark-read; task modal and event modal open inside the dropdown; a worktree or resource link opens the browser; stop `worktree ui` and confirm the disconnected icon and message, then start it and confirm it recovers; `make install` restarts the server and the app recovers; uninstall removes everything.

## Left to the builder

- The glyph design, exact sizes, and the blink implementation in Swift.
- The bundle ID, LaunchAgent label and app name (suggestions above).
- Whether the Tasks tab needs its own extracted component or just reuses `useTasksPanel` and `TaskList` directly.
- How the event details modal is driven on `/mini` (local state as on the home page is fine; it does not need a URL param). Decided in the plan: on the home page an event row opens its worktree; on `/mini` it opens the event details modal in the dropdown instead, and the modal's own buttons go to the browser.
- Commit boundaries, other than the `ActivityPanel` extraction landing on its own.

## Decisions marked as my calls

- AppKit with `NSStatusItem` and `NSPopover` rather than SwiftUI `MenuBarExtra`.
- Local build at setup time with `go:embed`ded source, rather than shipping a binary (pending the compile-time measurement).
- LaunchAgent for launch at login, rather than `SMAppService`; the plist's presence is the on/off state, toggled from the app's right-click menu.
- The URL is baked into the bundle rather than passed by the LaunchAgent, so the app runs correctly when launched by hand.
- `/mini` skips `useTabPresence` entirely.
- The right-click menu (Open full UI, Reload, Quit).
- App name `Worktree Menu Bar.app` in `~/Applications`.
- Port fixed at 8475 (no config key exists for it).
- "Mark all read" stays in the Activity tab's controls rather than the header.
- In the dropdown, "Unreads only" does not collapse the Tasks tab.
- The source hash is computed at runtime from the embedded files and stored in the bundle's `Info.plist`.
- "Switch cmux" buttons appear only inside hover cards, not in inline workspace labels on rows.

## Mike's answers to the builder check

- Install prompt: no remembered "no"; non-interactive runs never install fresh; an installed app is rebuilt only when its source changed.
- A monthly re-login is fine, with a distinct needs-login icon.
- Include "Unreads only" in the mini view.
- Add `worktree setup --uninstall-mac-app`.
- Add "switch cmux" buttons to hover cards that show a workspace, in all views.
- AppKit, not SwiftUI (after discussing why).
- Starting at login is optional, with an easy way to turn it off.
- "More settings in web UI" opens the full UI's Settings modal in the browser.
- The dropdown auto-reloads when it can't reach the server, like the web UI; both countdowns are 6 seconds.
