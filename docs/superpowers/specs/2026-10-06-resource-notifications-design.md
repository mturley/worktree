# Resource notifications — design

Date: 2026-10-06
Status: approved; implemented (see plan 2026-10-06-resource-notifications.md)

## Goal

Let the user opt in to a desktop notification whenever the watchers record
new events for a resource, without having to keep the web UI in view.

- Under cmux (the primary setup), notifications are sent by the server via
  `cmux notify`. Clicking one switches cmux to the worktree's workspace.
  Browser notifications are unusable there: the cmux browser has no
  Notification API and cmux puts tabs to sleep aggressively.
- Without cmux, the browser shows the notification, from exactly one tab per
  device. Clicking it brings that tab forward.

Findings from the spike that this design relies on:

- `cmux notify --workspace <ref>` shows a macOS banner, and clicking it
  selects that workspace.
- `osascript display notification` works, but it can't have buttons or a
  click action. `terminal-notifier` 2.0 has no action buttons either. So
  the notification has no buttons; the click action is the only action.
- The `Notification` API works in a normal browser on the plain-HTTP
  `localhost` listener, which counts as a secure context.

## Scope

In scope:

- Two kinds of toggle, both scoped to a worktree:
  - **worktree-wide** ("Notify on all"), which covers every resource the
    worktree tracks, including resources added later;
  - **per-resource** ("Notify on new events"), stored per (worktree,
    resource).
- A server-side notifier that turns new events into one notification per
  (worktree, resource) per pass.
- Two delivery paths: cmux, or a single browser tab per login session.
- A test notification whenever a toggle is turned on.
- Bell indicators on the worktree detail page and the home page.
- Renaming the unread toggle from "Show unread only" to "Unreads only".

Out of scope (YAGNI):

- Action buttons on notifications, and a helper `.app` built on
  `UNUserNotificationCenter`. Revisit if click-to-switch proves too little.
- Suppressing the user's own events, or events for a resource already on
  screen.
- Web Push or service workers, which would deliver with no tab open.
- Per-event-type notification preferences.

## Event filter

These events never notify:

- `watch_started` and `watcher_error`, the same exclusion `internal/unread`
  and the timeline apply (see `internal/unread/unread.go`).
- `ci_pending` and `ci_workflows_pending`, which are low-signal CI churn.

Every other event type notifies. That includes events the user authored.

## Data model — `internal/notifyprefs`

A new package that owns a worktree-owned table. It follows the
`internal/notes` pattern: the table is not in the watcher library, so no
cross-repo change is needed.

```sql
CREATE TABLE worktree_notify (
  subscriber    TEXT NOT NULL,   -- wdb.Subscriber(path), never a raw concat
  resource_type TEXT NOT NULL,   -- '' for the worktree-wide row
  resource_id   TEXT NOT NULL,   -- '' for the worktree-wide row
  created_at    TEXT NOT NULL,
  PRIMARY KEY (subscriber, resource_type, resource_id)
);
```

- A row means "on". Turning a toggle off deletes its row.
- The worktree-wide row and per-resource rows are independent. While the
  worktree-wide toggle is on, per-resource rows stay where they are, so
  turning it off restores the user's per-resource choices.
- API: `Get(conn, path) (Prefs, error)` returns `{All bool, Resources
  []Key}`; `SetAll(conn, path, on)`; `SetResource(conn, path, type, id,
  on)`; `RemoveResource(conn, path, type, id)`; `RemoveAll(conn, path)`.
- Cleanup:
  - `resources.Remove` also drops that resource's row;
  - `resources.RemoveAll` drops every row for the worktree. (Every
    `registry.Unregister` caller also calls `RemoveAll`, so Unregister
    needs no hook of its own.)

  These rows are settings, not history. Unlike subscription tombstones,
  nothing needs them after the worktree is gone.
- The schema migration lives with the other worktree-owned tables in
  `internal/db`.

## Notifier — `internal/webui/notifier.go`

A goroutine started by `worktree ui` next to the poll loop. It runs every
5 seconds, the same cadence as `/api/stream`'s event check.

1. **Cursor.** An in-memory `ts` cursor over `watcher_events`, initialized
   to `MAX(ts)` when the server starts, so a restart never replays a
   backlog. Each pass reads `ts > cursor` and then moves the cursor to the
   highest `ts` it read, whatever happens to delivery. A failed delivery is
   dropped, never retried.
2. **Match.** It joins new events through `watcher_event_resources` to the
   live `watcher_subscriptions` (subscriber = `wdb.Subscriber(path)`), then
   to `worktree_notify`. An event matches a subscription when the worktree
   has the worktree-wide row, or a row for that exact resource.
3. **Filter.** It applies the event filter above.
4. **Batch.** It groups matches by (worktree path, resource). Each batch
   carries:
   - the resource's display name: its custom name, else its cached title,
     else its ID;
   - the worktree's display name;
   - the event count;
   - the newest event's title;
   - the resource URL;
   - the newest event `ts`.
5. **Deliver.** It hands each batch to the active delivery path.
6. **Never flood.** If the cursor failed to initialise, passes retry the
   initialisation and read nothing until it succeeds. If one pass would
   fire more than 5 notifications, it fires a single summary instead:
   title "New activity", body "N resources have new events", targeting
   the worktree when every batch shares one, otherwise none (cmux
   untargeted; the browser click goes to the home page).

Text of a notification:

- **Title:** the resource's display name, e.g. `PR #123: Fix foo`.
- **Subtitle:** the worktree's name. cmux has a separate subtitle field;
  in the browser it is the first line of the body.
- **Body:** the newest event's title, plus "(+N more)" when the batch
  holds more than one event.

The notifier depends on a small `Transport` interface (`Deliver(batch)`),
so tests can run it without cmux or HTTP.

### Choosing the delivery path

At startup: if `cmux.IsAvailable()` the server uses cmux delivery,
otherwise browser delivery. One mode per server process; the two never
both fire. The mode is exposed on the session response
(`notify_mode: "cmux" | "browser"`) so the UI can adapt its permission UX.

`IsAvailable`, not `InPane`, is the right check: the server drives cmux
from wherever it runs (see the `internal/cmux` notes in CLAUDE.md).

### cmux delivery

- It looks up the worktree's workspace with `cmux.ListWorkspaces()` plus
  `cmux.Match`, then runs
  `cmux notify --workspace <ref> --title … --subtitle … --body …`.
- **No matching workspace:** it sends the notification without
  `--workspace`. Clicking then lands on the UI server's own workspace.
- **`cmux notify` fails:** it logs the error and drops the batch.
- It goes through the package's stubbable `cmuxCmd`, by adding
  `cmux.Notify(opts)` to `internal/cmux`.

### Browser delivery: one tab per session

**Tab registry.** An in-memory registry in `internal/webui`.

- Each tab makes a random tab ID when it mounts, and opens
  `/api/stream?tab=<id>&route=<path>&visible=1|0`. The initial presence
  rides on the stream URL because a presence POST racing the stream's
  registration would be refused as an unknown tab.
- Opening the stream registers `{tabID, sessionHandle, route, visible,
  lastActive, sendCh}`. The entry is removed when the stream closes.
- The stream only goes from server to tab. The tab reports its state with
  `POST /api/tabs/presence` `{tab, route, visible}` whenever:
  - the route changes;
  - `visibilitychange` fires;
  - `focus` fires.

  A `focus` or a change to visible also updates `lastActive`.
- `route` is the app path (`/` or `/worktree/<path>`). The server derives
  the worktree path from it.
- The tab ID must belong to the request's session, or the request gets a
  404.

**Choosing a tab.** For each batch, and separately for each login session
with at least one open tab, the server orders the candidates:

1. tabs on that worktree's detail page;
2. tabs on the home page;
3. all other tabs.

Within each group, visible tabs come first, then by `lastActive`, newest
first.

**Sending and the ack.** The server sends `event: notification` to the
first candidate only. The payload holds:

- a notification ID;
- the title, subtitle, body;
- the worktree path, the resource type and ID;
- the `tag`.

The tab replies with `POST /api/tabs/ack` `{tab, notification_id, shown:
bool}`:

- `shown: true` once `new Notification(...)` has run;
- `shown: false` when `Notification.permission !== "granted"` or the API
  is missing.

If the ack is `shown: false`, or no ack arrives within 5 seconds, the
server moves on to the next candidate. After the last candidate the batch
is dropped for that session.

The 5-second timeout covers tabs the browser has frozen: their connection
stays open, but they never run the handler.

**Duplicate guard.** `tag` = `worktree:<path>|<type>:<id>`. If a
duplicate slips through a fallback race, the browser replaces the first
notification with the second instead of showing both.

**Click.**

- `window.focus()`.
- If the tab isn't already on that worktree with that resource selected,
  it navigates there.
- `notification.close()`.

## Test notification

When `POST /api/notify` turns a toggle on, the server delivers a synthetic
batch through the active path:

- **Title:** "Notifications on".
- **Body:** "You'll be notified about new events for `<resource name>`",
  or "…for all resources in `<worktree name>`".

In browser mode the request carries the caller's tab ID, and the test goes
to that tab first. In cmux mode it targets the worktree's workspace, as
any batch does.

## HTTP API

All of these sit behind the existing session guard, Host allowlist and
forgery guard.

| Route | Purpose |
|---|---|
| `POST /api/notify` | Body `{path, type?, id?, on: bool, tab?}`; no type/id means the worktree-wide toggle. `tab` targets the test. Sends a test notification when a toggle turns on. Links are refused (400). |
| `POST /api/tabs/presence` | `{tab, route, visible}` presence update. |
| `POST /api/tabs/ack` | `{tab, notification_id, shown}`. |
| `GET /api/stream?tab=<id>&route=…&visible=…` | Existing stream, now registering the tab. A stream without `tab` still works but is never chosen as a target. |

Additions to existing data:

- the session DTO gains `notify_mode`;
- the worktree list and detail DTOs gain `notify_all: bool`;
- each resource DTO gains `notify: bool`, the explicit per-resource flag.
  The UI works out the effective state as `notify_all || notify`.

## UI

- **`UnreadOnlyToggle`:** the label becomes "Unreads only". It is shared by
  the home page and the detail page.
- **Worktree detail page header:** a "Notify on all" switch next to
  "Unreads only", with the tooltip "Notify on new events for all resources
  in this worktree".
- **`ResourceDetailPane` header:** a "Notify on new events" switch.
  Link resources get no switch and no bell anywhere: links are never
  polled, so they never have events.
  - While `notify_all` is on, it shows checked and disabled, with the
    tooltip "Notifications are enabled for all resources in the worktree".
- **Browser mode permission UX.** Turning a switch on is a click, so
  `Notification.requestPermission()` is called right before the `POST`.
  - **Permission denied:** the setting still saves, and an inline warning
    under the switch reads "This browser is blocking notifications. Allow
    them in the site settings to receive them here."
  - **Switch on but permission `default`:** this happens when the switch
    was turned on from another device. The same spot shows "Notifications
    aren't enabled in this browser" with an "Allow" button.
  - In cmux mode none of this renders.
- **Bells on the detail page resource cards**, at the top right. They show
  whenever `notify_all || notify`.
  - **Explicit** (`notify && !notify_all`): a filled bell. Tooltip:
    "Notifications are on for this resource".
  - **Implicit** (`notify_all`): an outlined, dimmed bell with a small
    stacked badge. Tooltip: "Notifications are on for all resources in
    this worktree. Turn off 'Notify on all' at the top of this page to
    change it". The implicit style wins when both apply.
- **Bells on home page worktree cards.**
  - **`notify_all`:** an implicit-style bell at the top right of the
    worktree card, and no per-resource bells.
  - **Otherwise:** an explicit bell at the end of the first line of each
    resource line with `notify`.
- **Stream handler.** It lives in `useSSE`, which is mounted app-wide, so
  it works on every route. It handles `notification` by showing it and
  acking, and still invalidates on `events_new`. A new `useTabPresence`
  hook, also mounted in `AuthenticatedApp`, owns the tab ID and the
  presence posts.
- **After `POST /api/notify`:** the `worktrees`, `resources` and `session`
  queries are invalidated.

Icons come from Tabler (`@tabler/icons-react`, already a dependency):
`IconBellFilled` for explicit bells, `IconBell` plus a badge for implicit
ones.

## Failure modes

| Situation | Behavior |
|---|---|
| Server restart | The cursor starts at `MAX(ts)`. Events written while the server was down don't notify. |
| cmux notify fails | Logged; batch dropped. |
| Worktree has no cmux workspace | Untargeted `cmux notify`, with the worktree name in the subtitle. |
| No tabs open (browser mode) | Nothing is delivered. A browser can't notify without a page. |
| Every candidate tab declines or times out | Batch dropped for that session. |
| Resource removed or worktree deleted | Its `worktree_notify` rows are deleted, so nothing matches. |
| Stream reconnects with a new connection | Same tab ID, re-registered. Any in-flight ack wait times out and falls through. |

## Testing

Go:

- **`notifyprefs`:** CRUD; the worktree-wide and per-resource rows are
  independent; cleanup through `resources.Remove`, `RemoveAll` and
  `Unregister`; subscriber canonicalization on symlinked paths.
- **Notifier, with a fake `Transport` and a seeded DB:**
  - the cursor starts at `MAX(ts)`;
  - the filter excludes the four types;
  - batching, one per (worktree, resource);
  - worktree-wide vs per-resource matching;
  - an untracked resource never matches;
  - the cursor advances even when delivery fails.
- **Tab selection and acks, with a fake clock:**
  - ordering across the three groups and the tie-breaks;
  - one target per session;
  - `shown: false` falls through immediately, a timeout falls through
    after 5s, and the batch is dropped after the last candidate;
  - a tab ID used from another session is rejected.
- **cmux transport, with `cmuxCmd` stubbed:** the arguments, with and
  without a matched workspace; errors are logged, not retried.
- **`POST /api/notify`:** writes the rows; the test notification goes
  through the transport; DTOs expose `notify_all`, `notify` and
  `notify_mode`.

Frontend (Vitest):

- the "Unreads only" label;
- the worktree-wide switch, and the per-resource switch's disabled state
  and tooltip;
- the permission prompt on enable; the denied and default warnings;
  nothing renders in cmux mode;
- explicit and implicit bells on detail cards, and the home page bell
  placement rules;
- the `notification` stream handler shows the notification and acks
  `shown: true`; it acks `shown: false` without permission; clicking
  navigates to the resource.

## Docs

- Add a "Notifications" section to `docs/web-ui-architecture.md`: the
  notifier, the delivery modes, the tab registry and the ack protocol.
- Add `internal/notifyprefs` to the package list in `CLAUDE.md`.
