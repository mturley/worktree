# Header watcher buttons — design

## Intent

Watcher controls are scattered: refresh sits beside three different activity
lists, Settings is only on the home page, and the watcher log is buried in a
Settings tab. Put them in one consistent place: three icon buttons at the top
right of every page header — refresh watchers, watcher logs, settings — and
refresh + logs in the mini view (menu bar app).

## Goals

- Every page header (home, worktree) ends with, left to right:
  **Refresh watchers** → **Watcher logs** → **Settings**.
- Watcher logs is its own modal (the current `LogsPanel` content: "Watcher
  log" and "Resource status" sub-tabs), no longer a Settings tab.
- The logs icon becomes a warning icon (red) while any watcher is failing.
- Mini view: refresh and logs (not settings) to the left of "Open full UI ↗".

## Non-goals

- No change to what refresh does, the log content, or the server.
- The per-watcher error marks (source filter, resource "Updated …" line)
  stay as they are.

## Approach

One sensible way (approved): reuse `RefreshWatchersButton`, add a
`WatcherLogsButton` + `WatcherLogsModal`, and a small `HeaderActions` group
rendering the trio, placed in `HomeHeader` and the worktree page header.

- **Removed** `RefreshWatchersButton` from `ActivityPanel`,
  `WorktreeDetailPage`'s activity controls, and `ResourceDetailPane`'s
  Activity tab (its "Updated …" text and `WatcherErrorMark` stay).
- **Settings:** the Logs tab, `"logs"` target and `?settings=logs` deep link
  go away; Settings' footer logic no longer special-cases logs.
- **Warning state:** any watcher in `/api/watchers` with `has_error` (failing
  now). A disabled watcher is not an error. Tooltip names the failing
  watchers.
- **Mini view:** the logs modal opens full-screen (the popover is small).
- **Worktree page:** the trio sits at the right end of the header's title
  row, at both widths.

## Left to the builder

Exact icons (`IconFileText`-style for logs, `IconAlertTriangleFilled` for
the warning), tooltip text, and test updates.
