# Task work log, task event subfilters, and task unread surfaces

Date: 2026-11-10 · Branch: `task-log-work` · Status: approved for planning

## Intent

Mike uses tasks to track what he's doing, and he chases unread activity from
many places. This design has three goals:

1. **Log work on a task.** He can jot down a short note about what he's doing on
   a task. The note becomes a dated entry in the task's history and in the
   activity feeds. These are notes to himself. Agent work logging is a
   separate, later idea (see Non-goals).
2. **Filter task activity by kind**, the way GitHub and Jira activity already
   can be filtered.
3. **Use a task as an unread inbox.** He wants to open a task and see, and
   clear, everything unread about it: the task's own events *and* its linked
   PRs, Jira issues and Slack threads. In effect, the task modal becomes an
   activity list filtered to that task. Task rows show at a glance which tasks
   have something unread.

## Goals

- A **Log work** action in the task modal that records a `task_work_logged`
  event with Mike's text.
- Work log entries are **editable and deletable** from the event details
  modal, wherever that event is opened from.
- Rows in the task modal's Activity tab **open the event details modal**,
  stacked on top of the task modal.
- The Activity tab **loads older events on scroll** instead of stopping at
  200.
- Clicking a task event in any **other** activity list opens the task modal on
  its Activity tab, with that event's details stacked on top.
- **Subfilters under the Tasks source:** Progress, Blockers, Created / deleted.
- A **combined unread count** per task: the task's own unread events plus its
  linked resources' unread events. It is shown as:
  - an "N UNREADS" badge on the task modal's Activity tab;
  - a blue unread highlight on task rows in task lists, alongside the
    existing dot;
  - a **Mark all read** button in the task modal that opens the same
    mark-all-read confirm modal other activity lists use.

## Non-goals

- Agent work logging, including a `worktree tasks log` CLI command. Mike will
  revisit agent logging separately and may not tie it to tasks. Don't add a
  CLI write for work logs in this change.
- Making any task event other than `task_work_logged` editable or deletable.
- Saving the stacked event details modal in the URL. A refresh or shared link
  reopens the task, but not the details modal on top.
- Changing what counts as unread. The rule stays the same: only agent and
  system task events are unread, and the user's own never are
  (`internal/tasks/unread.go`). A work log Mike writes is therefore never
  unread.

## Anti-goals (failure even if it "works")

- A "Mark all read" that silently moves read cursors on linked resources. A
  resource's cursor is shared by every worktree that follows it, so clearing
  linked resources must always go through the confirm modal's checkboxes.
- A task row that stays blue after Mark all read, or a badge count that
  disagrees with what the Activity tab shows as unread. The count and the
  clear must cover the same set.
- Per-task N+1 queries to compute unread counts for a task list.

## Current state (for orientation)

- Task events: `internal/tasks/events.go` (types and `record`), the feed in
  `internal/tasks/feed.go`, and their timeline rendering in
  `internal/webui/task_timeline.go` (`taskEventTitles`, `taskEventLabels`).
  Frontend metadata is in `ui/src/lib/eventMeta.tsx`. The table is
  `task_events` (`internal/db/migrate.go`); `payload` is JSON.
- Undo deletes events and writes none (`internal/tasks/undo.go`).
- Subfilters: `ui/src/lib/eventTypeFilter.ts` (`EVENT_CATEGORIES.task` is one
  hidden "task" category today). The server side is in
  `internal/webui/timeline.go`: `eventTypeFilter`, `taskEventCategory`,
  `includesTasks`, `taskEventsSelected`, and `mergeTaskEvents`.
  `tasks.FeedQuery` has no type filter today.
- The task modal is in `ui/src/components/tasks/modal/`. `TaskDetailModal` is
  the shell with its Details and Activity tabs; `ActivityTab` has inert rows
  and link toggles; `TaskModalHeader` has the current "Mark read" button,
  which moves only the task cursor; `TaskSidebar` is the right-hand column.
  The URL and history contract is in `TaskModalProvider` (see
  `docs/web-ui-architecture.md` "Task detail modal"). An in-app navigation
  from inside the modal must drop `?task=`.
- Activity API: `GET /api/tasks/activity` (`tasks_detail_api.go`). `all` is
  the task's own events plus its resource links' events, at most
  `taskActivityLimit` (200) per resource and 200 merged, with no paging
  (Section 3a adds it).
- Unread: `/api/tasks` fills `unread_count` and `unread_through_ts` from
  `unread.TaskSummaries`, covering the task's own events only.
  `unreadIndex` (`internal/webui/unread.go`) already holds per-resource
  unread for every resource.
- `TaskRow.tsx` already shows `UnreadMarkerDot` when `unread_count > 0`.
- Event details: `ui/src/components/EventDetailsModal.tsx`. It has
  navigation actions (go to worktree, open in diff) and "Make task". In
  feeds, `EventRow` sends task events to `onOpenTask` instead of the details
  modal.
- Mark all read: `ui/src/components/MarkAllReadButton.tsx`. It takes
  `resources`, a preview `feed`, and a `taskScope` (all | worktree |
  resource), and its task rows come from `GET /api/task-unread`.

## Design

### 1. The work log event

- New type `tasks.EventTaskWorkLogged = "task_work_logged"`. Payload:
  `{"text": string, "edited_at"?: RFC3339}`.
- **Text:** trimmed, required (non-empty), with a sane maximum length (the
  builder picks one, e.g. a few thousand characters). Keep line breaks.
- **Writes**, all actor-stamped like other task writes, user only (no agent
  path in this change):
  - **Create:** records the event on the task with ts = now and bumps the
    task's `updated_at`.
  - **Edit:** replaces `text` and sets `edited_at`. The event's `ts` does not
    change, so the entry keeps its place in the feed. This is the first
    in-place change to a task event, and it is allowed **only** for
    `task_work_logged`. Any other type is refused.
  - **Delete:** removes the event row. Only `task_work_logged` may be
    deleted this way.
- **Rendering:** title `Worked on "<task title>"` (`taskEventTitles`), body =
  the text, type label "work logged". In `eventMeta.tsx`, use the task
  accent with a fitting icon. An edited entry shows "(edited)" near its
  time, wherever task event rows render.
- It flows into every place task events already go: the task modal's
  Activity tab, the home and worktree activity feeds when Tasks is shown,
  `worktree tasks show`'s recent history, and `worktree activity`. Each needs
  only the new title and label, not new plumbing.
- **API:** new routes beside the other task write routes, e.g.
  `POST /api/tasks/work-log` (`{id, text}`),
  `PATCH /api/tasks/work-log` (`{event_id, text}`),
  `DELETE /api/tasks/work-log` (`{event_id}`). The builder picks the exact
  shapes to match the existing task API conventions. All of them push the
  usual task-changed stream event, so open feeds refresh.
- **Undo:** creating a work log doesn't need an undo toast, since it is
  deletable. *(Builder's call; the existing undo machinery may be reused if
  that's simpler.)*

### 2. Log work button and popover

- A **Log work** button in `TaskSidebar`, directly under the State select.
  The sidebar is visible on both tabs, and logging work sits naturally next to
  state.
- Clicking it opens a **popover** anchored to the button, containing a text
  area (autofocused, a few rows, grows), **Save** and **Cancel** buttons, and
  ⌘/Ctrl+Enter to save. Esc closes the popover only, not the modal.
- On save, the popover closes and the Activity tab, if mounted, refreshes.
  The new entry appears in it and in any open feed. On failure, the text is
  kept and an error shows in the popover.

### 3. Activity tab rows open event details (stacked)

- In `ActivityTab`, clicking a row opens `EventDetailsModal` **over** the task
  modal. The link and unlink icons stay on the rows and keep their own
  behavior.
- Closing the details modal (Esc, close button) returns to the task modal
  only. Esc must not close both.
- The details modal keeps **all** its actions, including "go to worktree" and
  "open in diff". Mike may navigate away from a task while browsing its
  activity. Those navigations already change the path and drop `?task=`,
  which closes the task modal under the provider's contract. Back returns to
  the page with the task open again. The one exception is **Make task**,
  which is hidden when the details modal is opened from inside a task modal.
- Update the comment on `ActivityTab` (and the architecture doc) that says
  rows are inert.

### 3a. Activity tab pages on scroll

Today `GET /api/tasks/activity` returns one batch, at most
`taskActivityLimit` (200) merged rows, and `useTaskActivity` is a plain
`useQuery`. Older events can't be reached at all.

- **Server:** add a `before` cursor (exclusive ts) and a `limit`, and return
  `{events, next_cursor}`, matching the timeline endpoints. Each source (the
  task's own events, each linked resource, the event links) is read up to the
  page size **before the cursor**, the results are merged, and the page is cut
  at the limit. Handle same-second ties the way `mergeTaskEvents` does
  (overfill the boundary cluster), so a strict `before` never skips rows. Task
  ts values have one-second resolution.
- **Client:** `useTaskActivity` becomes a `useInfiniteQuery`, and the
  Activity tab loads the next page on scroll, the same way the main feeds do.
  Reuse their mechanism. Keep the `["tasks", "activity", …]` key prefix so
  `useSSE`'s throttled `refreshActivity` still applies.
- The Mark all read preview's task-activity source (Section 9) uses the same
  paged endpoint.

- Clicking a task event row in any other feed (home, worktree, a resource
  pane, mark-all-read previews) opens the **task modal on its Activity tab
  with that event's details stacked on top**. Closing the details modal leaves
  the task modal on its Activity tab. Closing that returns to the list.
- This applies to every task event type, so they all behave the same way.
- **Home page** *(Mike's decision)*: open everything **in place** over the
  home page. Today `ActivityPanel.pickTask` navigates task events to the
  task's worktree page (with `ChooseWorktreeModal` when there are several).
  For task event rows, that navigation and the chooser go away; the task
  modal opens over the home page, and closing it returns to the home list.
- Mechanism (builder's call): something like `open(id, { tab: "activity",
  event })` on the task modal context, passing the clicked `TimelineEvent`
  object in memory. Nothing is added to the URL. The modal opens the details
  modal with that object rather than looking the event up in the Activity
  list, which may be filtered or capped.
- Rows inside the task modal for **the same task** must not reopen the task
  modal. Section 3 applies there.
- **Deleted tasks** *(my call)*: the feeds already exclude events of
  soft-deleted tasks (`tasks.FeedEvents`), so this rarely comes up. If the
  task modal can't load the task anyway (it was deleted between render and
  click), open the event details modal on its own, with no Edit button.

### 5. Editing work logs in event details

- For `task_work_logged` events, `EventDetailsModal` shows an **Edit** button.
  Clicking it swaps the body for a text area with **Save**, **Cancel** and
  **Delete**. Delete asks inline first ("Delete? Yes / No"), as the task
  sidebar's Delete does.
- After a save, the open details modal shows the new text and "(edited)".
  After a delete, it closes. In both cases every feed and the task's Activity
  tab refresh.
- This works wherever the details modal opens a work log. Since Section 4
  routes every feed's task events through the task modal, that's always the
  stacked case, but the edit UI must not depend on that.

### 6. Tasks subfilters

Replace the single hidden `task` category in `EVENT_CATEGORIES.task` with:

| Key | Label | Event types |
|---|---|---|
| `progress` | Progress | `task_work_logged`, `task_state_changed`, `subtask_checked`, `subtask_unchecked` |
| `blockers` | Blockers | `task_blocker_resolved`, `task_blocker_unresolved` |
| `lifecycle` | Created / deleted | `task_created`, `task_deleted` |

- Icons and colors come from each category's first type, as for the other
  sources. All use the task accent.
- **Server:** `event_types` must be able to select task events by exact type.
  `includesTasks` becomes "empty filter, or the `task` category, or any exact
  `task_*` / `subtask_*` type". Those types are passed to the task side as a
  new `tasks.FeedQuery.Types` filter (SQL `e.type IN (...)`), so it is
  applied before `LIMIT`. Keep the `task` value working as "every task
  event" for any caller still sending it.
- New task event types added later should be put in a category on purpose.
  Note that next to the constants in `events.go`.

### 7. Combined unread count

- New field on the task DTO: **`combined_unread_count`** = the task's own
  `unread_count` + the unread counts of its **resource links** (PR, Jira,
  Slack), each resource counted once per task. Keep `unread_count` and
  `unread_through_ts` as they are, since they drive the task-cursor mark.
- This is exactly the set the Activity tab's **Everything** view shows: own
  events plus resource links' events. Individually linked events (the
  "Linked events" pill) are **not** added separately. *(My call, to keep
  count and view in agreement.)*
- **Resources no worktree follows** *(my call)*: a resource held only by a
  task's `task:<id>` subscription contributes **0**. This keeps the existing
  rule that what isn't followed isn't unread (`ErrNotFollowed`, no cursor
  seeded by task links). Don't change cursor seeding or `IsFollowed` here.
  Test that such a link adds nothing.
- **No cap to disagree with:** the Activity tab pages through the whole
  history (Section 3a), so every counted unread event can be reached by
  scrolling.
- **Computed once per request:** `/api/tasks` and the single-task endpoints
  build one `unreadIndex` (or reuse its loaders) and look up each task's
  linked resources in it. Don't run a query per task.
- **Freshness:** `useSSE` already refreshes `["tasks"]` on every new event and
  task change. Make sure every mark-read path (per-event, per-resource button,
  mark all read) also refreshes `["tasks"]`. `MarkAllReadButton` already does;
  check the per-resource "Mark read" on resource cards and the Slack thread's
  mark read.

### 8. Unread surfaces

- **Activity tab badge:** while `combined_unread_count > 0`, the Activity
  tab's label shows the existing `UnreadBadge` ("N UNREADS" style).
- **Task rows:** while `combined_unread_count > 0`, `TaskRow` gets the same
  blue unread border and tint the worktree cards use (`UNREAD_BOX_BORDER` /
  `lib/unread`), and its existing `UnreadMarkerDot` switches to the combined
  count. The dot's hover text should still read sensibly ("unread activity").
  This applies to every task list, including the home page, worktree page,
  resource panes and the mini view if it renders `TaskRow`.

### 9. Mark all read in the task modal

- The header's **Mark read** button becomes **Mark all read**, shown while
  `combined_unread_count > 0`. It is `MarkAllReadButton`, opening its confirm
  modal stacked over the task modal.
- **Inputs:**
  - `resources`: the task's resource links as `ResourceDTO`s carrying the
    unread fields the button needs (`unread_count`, `task_unread_count`,
    `unread_through_ts`, and for Slack `has_unread`, `updated_ts`,
    `last_read`). The builder decides how the modal gets them: a field on the
    task detail DTO, or a new read endpoint for a task's linked resources.
  - `taskScope`: a new **single-task scope** (`{kind: "task", id}`), with
    `GET /api/task-unread?scope=task&id=` returning just that task when it
    has unread events.
  - **Preview:** a new preview source that shows the task's activity feed
    (the Activity tab's Everything view) narrowed to the checked sources'
    unread events. Rows clicked there open event details stacked on top, as
    the button's previews already do.
- The checkboxes, counts, per-type exclusions, undo toast and failure
  handling work as they do on other lists. Linked resources are grouped by
  source (GitHub, Jira, Slack), and the task's own unread events appear as a
  task row.
- Since `task_unread_count` is already subtracted from resource counts by
  `toTarget`, task events aren't counted twice.

## Constraints

- Follow the repo's CLAUDE.md conventions: Go tests parallel by default with
  `testgit` fixtures; any schema change bumps `schemaVersion` (none is
  expected here, since the payload is JSON); new read logic goes in `Server`
  methods shared by handler and CLI.
- No new CLI writes (so `TestSkillNamesEveryWrite` is unaffected). If
  `worktree tasks show` or `worktree activity` print event titles, they must
  render `task_work_logged` properly.
- No watcher library change is expected. Everything here is worktree's own
  `task_events` and unread logic.
- Update `docs/web-ui-architecture.md`: Tasks, Task detail API, Task detail
  modal (stacking, rows no longer inert, Mark all read), Event details modal
  (work log editing, Make task hidden when stacked), Unread (the combined
  count), and the Activity subfilters.

## Left to the builder

- Exact API route shapes and DTO field placement for the work log writes and
  the task's linked-resource unread data.
- The work log text length limit and the event icon.
- How the task modal context carries "open on Activity with this event", and
  how Esc layering is enforced across the stacked modals.
- Whether creating a work log offers an undo toast.
