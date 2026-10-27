# Tasks — design

Date: 2026-10-21
Status: agreed in brainstorming, builder-checked, approved

Decisions Mike made are stated plainly. Decisions the brainstorm settled
without asking him are marked **(my call)** so he can check them while
reading. Mockups from the brainstorm live (gitignored) under
`.superpowers/brainstorm/*/content/` in the `tasks` worktree:
`home-pinned.html`, `task-modal.html`, `worktree-detail-v2.html`.

## Phases

This section is the progress tracker for the whole effort. Update it when a
phase's status changes. Each phase ships working software on its own. Each
phase's plan is written only after the previous phase lands, so it reflects
the real code.

| # | Phase | Scope | Plan | Status |
|---|---|---|---|---|
| 1 | Core + CLI | `internal/tasks` (schema, links Focus/Related, master order, subtasks, actor-stamped task events, membership + archived) and the `worktree tasks` CLI | `docs/superpowers/plans/2026-10-21-tasks-phase1-core-cli.md` | done |
| 2 | Task lists in the UI | web API; task lists (first as Tasks tabs with pinning, now the always-shown task panel; Links get a Details tab); rows, quick add, sort/filter, starred group, drag reorder (incl. star/priority by drag), badges, search | `docs/superpowers/plans/2026-10-21-tasks-phase2-ui-lists.md` | done |
| 3 | Detail modal | Details/Activity tabs and sidebar, link editing, subtask editing, linked events (with snapshots), "＋ task" from events and Slack messages | `docs/superpowers/plans/2026-10-21-tasks-phase3-detail-modal.md` | done |
| 4 | Activity integration | task events in feeds + "Tasks" source filter, per-task read cursors, unread counts, mark-read (and its undo), notifications for agent events | `docs/superpowers/plans/2026-10-22-tasks-phase4-activity.md` | done |
| 5 | Blockers | task / resource / other blockers, `task:` subscription holds + subscriber audit, status_category from cached state (watcher v0.16.0), Unblocked events + notifications, "blocks N tasks" | `docs/superpowers/plans/2026-10-22-tasks-phase5-blockers.md` | done |
| 6 | Undo | state / subtask / delete undo with CAS and cascades, delayed Unblocked notifications, soft-delete purge sweep | `docs/superpowers/plans/2026-10-23-tasks-phase6-undo.md` | done |

## Why

Users need one place that answers "what is the next most important thing to
do?", and somewhere to drop new to-dos so they are not lost. Today they end
up scattered: Slack "save for later" for things tied to a message, Obsidian for
open-ended notes, and most recently markdown checkboxes in a worktree's Notes
field. Notes came closest because the to-do sat next to the work, but it
could not be reordered, could not hold detail, and could not point at a
specific PR, Jira issue or Slack thread.

Tasks are to-do items that live in the worktree UI, attached to the
worktrees and resources they are about, ordered by hand, and visible to
Claude agent sessions through the CLI.

## Goals

- A single ordered list of to-dos, viewable whole (home page), per worktree,
  and per resource, always in a consistent order.
- Tasks attach to nothing, to worktrees, and/or to resources, and can be
  re-attached later.
- Fast capture: type a title, press Enter.
- Enough detail per task (description, subtasks, blockers, due date, linked
  events) to replace Obsidian notes and Slack save-for-later.
- Task activity is part of the activity feeds, with history per task.
- Agents can read and change everything a human can, through the CLI.
- Accidental state changes and deletes can be undone.

## Non-goals

- Snooze / "hide until". Users can deprioritise, re-date, or move
  a task down.
- Tags, effort estimates, recurring tasks, comment threads on tasks.
- Due-date notifications (the chip colour is enough).
- Due times — due dates are dates only.
- A separate "Recently completed" view beyond what is described below
  (one may be added later).

## Anti-goals

- Tasks that look different, or are in a different order, depending on
  where you view them. One order, everywhere.
- Tasks silently disappearing: an open task whose worktree or resource goes
  away must still show up somewhere, marked as orphaned.
- Any change to agent-handler's data. Tasks are worktree-only; agent-handler
  reaches them only through the `worktree` CLI.

## The task

| Field | Notes |
|---|---|
| Title | required, one line |
| State | `not_started`, `in_progress`, `done` |
| Description | optional, markdown (rendered with the existing `NotesMarkdown`) **(my call)** |
| Starred | boolean |
| Priority | `high`, `medium`, `low`, `none` |
| Due date | optional, date only |
| Subtasks | optional, ordered list of plain checkbox items (text + checked). Not linked to anything, no state beyond checked. Drag to reorder. |
| Blockers | list; see "Blockers" |
| Links | worktrees and resources, each Focus or Related, ordered; see "Links" |
| Linked events | zero or more specific activity events; see "Linked events" |
| `created_at`, `updated_at` | |
| `started_at` | set when state first becomes `in_progress` (or `done`, if it skipped straight there) **(my call)**; cleared if returned to `not_started` **(my call)** |
| `completed_at` | set on entering `done`, cleared on leaving it |
| Position | the task's place in the one master order; see "Ordering" |

## Links

A task has a set of explicit **links**. Each link points at either a
**resource** (type + id, e.g. `pr` + `opendatahub-io/odh-dashboard#4521`) or
a **worktree** (its registry path, canonicalised the same way the rest of the
DB does). A task with no links is **global**.

Links are associated with the *resource itself*, not "this resource in this
worktree". If two worktrees follow the same PR, a task linked to that PR
shows up in both.

A task linked to a resource is **implicitly** in every worktree that follows
that resource. Implicit worktree membership is computed at read time, never
stored, so it cannot go stale.

**Focus and Related.** Each link is Focus or Related, mirroring a worktree's
resources. The DB says `primary`/`related` and the UI says Focus/Related,
following the existing convention ("Focus vs primary" in
`docs/web-ui-architecture.md`). Any number of links may be Focus, including
none. Links are user-ordered within their group, and dragging between the
groups changes a link's group, exactly as resource cards do in a worktree
("Resource card ordering").

- A task created from inside a context (a worktree, a resource) gets that
  context as a Focus link.
- Links added later (modal, CLI) default to Related **(my call)**.
- Removing a Focus link promotes nothing; zero Focus is valid.

**The link chip** on a task row is the same everywhere: the **first Focus
link**, plus "+N" counting all other links. A task with links but no Focus
shows a neutral "🔗 N linked" chip; hovering it lists them **(my call)**. On a
resource's own task list the chip is omitted when it would just name that
resource **(my call)**. Clicking a resource chip opens that resource in a
worktree that follows it, using the existing `ChooseWorktreeModal` when there
are several; a worktree chip opens the worktree page.

## Where tasks show up

| Place | Shows |
|---|---|
| Home page | every task |
| Worktree page, nothing selected | tasks linked to this worktree directly **or** through any resource it follows |
| Worktree page, a resource selected | tasks linked to that resource |

**Orphaned links ("archived").** A resource link is archived when no live
worktree follows that resource; a worktree link is archived when the
worktree is gone from the registry.

- An **open** task whose resource links are all archived still shows in the
  worktrees that last followed those resources **(my call: "last followed"
  means worktrees whose subscription to the resource is a soft-deleted
  tombstone, which `watcher_subscriptions` already keeps)**. If those
  worktrees are gone too, or the task only had worktree links that are gone,
  it falls back to the home page only.
- The chip for an archived link is dashed and says "archived".
- A **completed** task with archived parents is hidden unless "Show
  completed" **and** its sub-toggle "Include archived" are on.

A resource held only by a task blocker (see "Blockers") is not "followed"
for this purpose. It doesn't appear in any worktree or in the home
Resources tab.

## Ordering

**One master order.** Every task has a single position. Every list is that
master list filtered, in master order, so any two tasks appear in the same
relative order wherever both are visible. Per-scope orders were rejected
because a task can be in several worktrees and resources at once, and
separate orders would contradict each other.

**Dragging in a filtered view** moves the task in the master order to sit
immediately after the visible task it was dropped below (or before the
visible task it was dropped above, when dropped at the top). Hidden tasks keep
their positions. Store the position as a fractional-index sort key so a move
rewrites only the moved row **(my call)**. The existing declarative
"state the whole list" reorder used for resource cards doesn't work here,
because a view only ever sees a subset.

**Grouping and sorting.**

- **Starred tasks are grouped at the top** of every combined list, whatever
  the sort. Dragging a task into the starred group stars it, and dragging it
  out unstars it.
- **Sort: Custom** (default): master order.
- **Sort: Priority**: groups High / Medium / Low / None, each in master order.
  Dragging within a group reorders it. Dragging into another group changes the
  task's priority and places it at the drop point. Starred is split the same
  way (starred High … starred None, all above the unstarred groups), so the
  starred tasks are sorted by priority too, and a drop into a starred group
  stars the task and sets that priority, while a drop of a starred task into
  an unstarred group unstars it and sets that priority.
- **Other sorts** (due date, recently updated **(my call on the list)**):
  dragging is disabled, with a hint that it works only in Custom or Priority.
- **Completed group.** With "Show completed" on, completed tasks sit in a
  Completed group at the bottom, newest `completed_at` first, not draggable.
  This group is the "recently completed" view.
- New tasks from quick add go at the bottom of the current view, i.e. just
  after the last visible task **(my call)**.

## Blockers

"Blocked by" and "externally blocked" are one concept. A task has a list of
**blockers**, and each one is:

- **a task.** It resolves when that task is `done`.
- **a resource.** You choose from resources followed by the task's
  worktrees, directly or implicitly; for a global task, any followed resource
  **(my call)**. A PR resolves when merged or closed. A Jira issue resolves
  when its status category is Done. Slack threads and links have no natural
  end, so they resolve by hand like "other" **(my call)**.
- **other**: free text ("waiting on PM sign-off"), resolved by hand.

A task is **blocked** while any blocker is unresolved. Blocked rows show one
red "⛔ blocked" chip, and hovering it lists the blockers. Resolved blockers
stay listed in the modal, dimmed with a check, and are never shown in red.
The reverse is shown too: a task lists the tasks it blocks ("Blocks: …"),
and a resource card shows "⛔ blocks N tasks".

**When a blocker resolves on its own** (task completed, PR merged, Jira
done), the task gets an "Unblocked: …" event and the user gets a **notification**
through the existing notification delivery (cmux or browser). These
notifications ignore the per-worktree and per-resource notify switches and
obey only the global ones, since the user asked for them outright **(my call)**.
The notification targets the worktree of the task's first Focus link, or
otherwise the first worktree the task appears in, or otherwise none (the
home page) **(my call)**. This is a new path into the notifier, which today
scans only `watcher_events`.

**A blocking resource holds a subscription.** The poll loop polls every
resource with at least one active `watcher_subscriptions` row
(`watcherdb.ActiveResources`). A resource blocker adds a subscription row of
its own, with a task-specific subscriber key (e.g. `task:<id>`), so the
resource keeps being polled even if every worktree unfollows it, and its
resolution is still noticed. The hold is released when the blocker is
removed, or the task is completed or deleted, and re-acquired if the task
is reopened. It is *not* released when the blocker resolves, because a
closed PR can be reopened **(my call)**. The subscription itself needs no
watcher library change. *As built: link blockers hold nothing, since a link
is never polled for a status; the hold carries the URL a blocker was pasted
from, else the resource's known URL.*

**Jira "Done" comes from the status category.** Do not guess Done from
status names **(my call)**. *As built (changed 2026-10-23 after review):
watcher v0.16.0 adds `status_category` to the cached Jira state
(`buildJiraStateJSON`), and a Jira blocker resolves from that cached state,
as a PR blocker does, with no Jira search (see `docs/web-ui-architecture.md`
"Blockers"). Phases 5–6 first worked around the library with a poll-time
`key in (…)` search; that is gone.*

**Builder warning:** code that assumes every subscriber is a worktree will
now see `task:` subscribers. That includes the archived logic, the home
Resources tab, timeline `worktree_paths`, unread and notification queries,
`resources.Load` and the CLI listings. Each must explicitly filter to worktree
subscribers. Audit every query on `watcher_subscriptions`.

## Linked events

A task can link to specific events: a particular Slack message, PR review
comment, or Jira comment. This replaces Slack "save for later".

- In the modal's Activity tab, every event from a linked resource has a
  🔗 link/unlink toggle. There is no separate picker.
- Linked events show on the Details tab as ordinary event rows.
- **"＋ task"** on an event row (on hover, in any feed) creates a task linked
  to that event's resource (Focus) and to the event, with the title pre-filled
  from the event. **(my call:** the same action on Slack messages in the
  thread view, linking that message.**)**
- A link stores the event's identity **and a snapshot** (type, title, author,
  body excerpt, URL, timestamp) taken when it is linked. The watcher rewrites
  some rows in place (CI bundles), and old events may be pruned, so the row
  renders from the snapshot whenever the live event is gone or has changed
  type **(my call)**. Slack messages must be linkable even if the poller
  hasn't stored that message as its own event. The snapshot makes that
  possible, and the builder decides the details.

## Task activity

Task events are stored in a worktree-owned table, **not** `watcher_events`
**(my call)**. They aren't watcher data, and agent-handler shares that
schema. The timeline queries merge them in.

Event types are deliberately few, and only these are recorded: `task_created`,
`task_state_changed`, `task_deleted`, `task_blocker_resolved` and
`task_blocker_unresolved` ("Unblocked" and its reversal), and `subtask_checked`
/ `subtask_unchecked`. **Edits record no event**: title, description,
priority, due date, star, subtask text or order, links and their order,
linked events, and adding or removing a blocker all save (and bump
`updated_at`) without writing to the history, and reorders record no event
either, so the feeds only show things that happened to the task, not
housekeeping.
`migrate` deletes any existing rows of the eleven dropped types on every
start.

- Each event records **who**: `user` or `agent`, plus an optional session
  name. The web UI always writes `user`. A CLI write is `agent` when it runs
  under an agent, i.e. Claude Code's `CLAUDECODE` env var is set, or
  `HANDLER_SESSION_ID` is (which also supplies the session name), or
  `--as-agent` is passed. Otherwise it is `user`, so the user running the CLI
  by hand is still the user **(my call)**. No agent-handler change is needed.
- **In feeds:** task events appear in the home feed, the feed of every
  worktree the task is in, and each linked resource's feed. Their dot uses
  the task accent colour. The home and worktree source filters gain a "Tasks"
  option.
- **Unread:** task events not made by the user (i.e. made by agents through the
  CLI) are unread. Each task has a read cursor in `resource_read_cursor`
  with `resource_type = 'task'` **(my call)**. Unread task events count toward
  the existing unread badges for the home page, worktree and linked resources,
  and are cleared by the same Mark all read (with its undo). A task with
  unread events shows the blue unread dot on its row. Opening the modal
  doesn't mark it read.
- **Clearing (my call):** a mark-read clears exactly the events in the feed
  it was pressed on. Marking a PR's feed read therefore advances the cursors
  of the tasks whose events appear in that feed, which also clears them
  everywhere else they're counted, since the cursor is per task. The undo
  payload carries the before/after values of those task cursors alongside
  the resource cursors. The modal also has its own "Mark read" for one task.
- Whether agent task events also trigger notifications through the
  per-worktree "Notify on all" switch: **(my call: yes, the same as any
  other non-self event on a notifying worktree.)**

## Undo

Use the existing undo mechanism (`ui/src/components/UndoToast.tsx`, "Undo"
in `docs/web-ui-architecture.md`) for:

- task state changes (from the checkbox menu, the modal header or the
  sidebar)
- subtask check / uncheck
- task deletion

As with mark-read, the write responds with the before and after values, and
undo posts both back. The server applies the undo only if the task still
holds the "after" value, and otherwise returns 409. A write that changed
nothing offers no undo. Undoing a state change also restores `started_at` and
`completed_at`. Undo **deletes** the event it reverses, instead of adding a
"reverted" event, so an accidental click leaves no history **(my call)**.

**Cascades (my call).** A state change and everything it sets off happen in
one transaction: releasing blocker holds, and resolving this task as a
blocker on other tasks, with their "Unblocked" events. Undo reverses the
whole set: it deletes those events and restores the holds. "Unblocked"
notifications caused by a task being completed wait out the undo window
before they are sent, and are dropped if it is undone.

**Deletes are soft** for the undo window: the task is marked deleted, hidden
everywhere, and purged once the window has passed **(my call: purge on a
later sweep, not exactly at 10s)**. Undo un-marks it. Deleting a task also
releases its blocker holds, and does so permanently only on purge.

## UI

### Visual identity

- Accent colour: **electric lime** (`#a3e635`) for now. The plan is to compare
  yellow (`#facc15`) and orange (`#fb923c`) in the real UI later, so keep it
  one token. Blue is not an option: it already means "unread".
- Task panels: faint lime background, lime border, 3px lime left edge.
- Count badges: lime with dark text.

### The task row (compact)

Left to right: drag grip (shown on hover) · state checkbox · star · priority
marker (`!!!` red / `!!` amber / `!` grey / blank) · title (one line,
ellipsised) · chips: due, blocked, subtask progress (`2/5`), unread dot, link
chip. Rows have no padding before the grip, in every sort, so it lines up
with the panel's edge and the full-width Show all button. The checkbox, star and priority mark show a hover background, as
does the panel's summary toggle. In the state and priority
menus, each option's checkbox or mark sits at its left, at the row's size.

- **State checkbox**: empty = not started, **diagonally half-filled** =
  in progress, filled ✓ = done. Clicking opens a small menu of the three
  states and changes nothing until one is picked, so an in-progress task can
  go back to not started without passing through done. Each menu option draws
  its own checkbox, and the current one keeps its ✓ column.
- **Priority mark** is a menu too: clicking it opens High / Medium / Low /
  None, each drawn with its mark (`!!!` red, `!!` amber, `!` grey, blank for
  None) and the current one ticked. A pick saves at once. A task with no
  priority shows a faint `!` placeholder as the click target: hidden at rest,
  shown at opacity 0.35 on row hover or focus-within, and always shown where
  `(hover: none)`. Clicks in either menu never open the detail modal.
- **Due chip** is relative: "Due today", "Due tomorrow", "3 days left",
  "Overdue 2 days". The absolute date is on hover. Overdue is red, today is
  amber, and everything else is neutral.
- Clicking the row (outside the controls) opens the detail modal.

### The list

- Toolbar: "Sort:" (Custom / Priority / Due date / Updated), its closed
  dropdown just wide enough for the option it shows, and "Show completed" with its "Include
  archived" sub-toggle. There is no priority filter: Priority sort groups the
  list by priority. There is no Pin
  button. The toolbar sits right-aligned in the task panel's header (see
  "The task panel").
- Starred group at the top (in Priority order, one starred group per
  priority), then the rest (in Priority order, one group per
  priority), then (if shown) Completed. **No section has a header**, in any
  sort. A section with no tasks is not rendered at all, so there are **no
  drop strips**; an empty priority group is hidden. Dropping onto a
  non-empty section still works.
- While a drag is on, each section it can land in shows as a faint band
  with a small tag naming it (`★ Starred`, `Tasks`, `★ High` … `★ No
  priority`, `!!! High` … `No priority`), drawn without moving any row.
  Over a section other than the dragged task's own, the band is outlined
  and a line marks where it lands, and the dragged task itself carries a
  hint just above its top-left corner saying what the drop changes:
  "Star" / "Unstar", "Set priority: High" / "Remove priority", or both
  ("Star · Set priority: Medium"). The band tags stay as labels.
- The existing search box narrows task lists too, matching title and
  description **(my call; it follows "search is a filter" from the Search
  design)**.
- **Quick add** at the bottom: just an input until it's focused or has text.
  Then a star toggle and a priority picker appear to its **left**, and
  "↵ Add" and "Add & open" appear to its right. Enter adds and keeps focus for
  the next one, while "Add & open" creates the task and opens its modal. The
  new task is linked to the current context (none on home, the worktree,
  or the selected resource) as Focus.

### Tabs

There is **no Tasks tab** anywhere. Tasks is the task panel (below), so the
tab bars are the ones each place already had:

| Place | Tab bar |
|---|---|
| Home (wide, right column) | Activity · Resources |
| Home (narrow) | Worktrees · Activity · Resources |
| Worktree page, nothing selected (wide, right column) | Activity |
| Worktree page, nothing selected (narrow) | Resources · Activity |
| PR / Jira selected | Activity · Linked Resources |
| Slack thread selected | Thread · Linked Resources |
| Link selected | **Details** (today's link pane content) |

A URL with `?tab=tasks` falls back to the pane's first tab.

### The task panel

The panel is always shown, just above
the tab bar. On the home page that is the top of the right column. With a
resource selected it's between the resource card and its tab bar. Its header
reads "Tasks (all | this worktree | this PR | this issue | this thread |
this link)", with the unread dot and the list toolbar. It has
three levels:

- **Normal** (the default): the list is capped at `min(8 rows, 25dvh)` and
  scrolls inside itself, so it doesn't push the feed off-screen. When the
  capped list overflows, a full-width **Show all (N)** button sits directly under the
  list, above quick add, where N is the number of tasks the list shows. A
  list that fits offers no Show all.
- **Collapsed**: the panel shrinks to its one-line summary, which then adds
  " · 2 in progress, 8 not started" (a state with none is left out; "none
  open" when nothing is). The summary itself (a chevron, "Tasks (…)" and the unread
  dot, at the left of the header, with a generous click area) cycles the
  levels: normal → expanded (as Show all) → collapsed → normal. A list that
  fits skips expanded: normal goes straight to collapsed. The toolbar, list and quick
  add are hidden. Collapsed is **one global saved
  setting**: `collapsed` (default `false`) in localStorage key
  `worktree.taskList`.
- **Expanded**: Show all removes the cap, and the button becomes **Show
  less**. Expanded is **never saved**: a change of path, or of the panel's
  scope (selecting a different resource on the worktree page), resets it to
  normal. Changing a tab does not.

The panel is never pinned: it scrolls with the content, in every level.
The tab bar beneath it (with whatever already sticks with the tab bar, such
as the activity filters on the home and worktree pages) sticks once it is
scrolled to. With a resource selected, the card and the panel scroll away
and only the tab bar sticks.

### Badges elsewhere

- Worktree cards (home page) get a lime open-task count ("3 tasks", "1 task") next to the blue
  unread badge.
- Resource cards (worktree page) get a lime open-task count, and "⛔ blocks N
  tasks" when they block any.

### Task detail modal

Header: state checkbox (the same three-state menu) · star · editable title ·
close. Two tabs, with a properties **sidebar** that stays visible on both.

- **Sidebar**: state, priority, due date, starred, blockers ("Blocked by",
  with add for task / resource / other), created / started / updated /
  completed timestamps, Delete.
- **Details tab**: description, subtasks (with add, check, drag to reorder),
  **Linked to** (Focus and Related groups, draggable within and between, each
  link removable, "+ link resource or worktree", plus the implicit worktrees
  shown dashed and read-only with the reason "via #4521"), **Linked events**
  (event rows), **Blocks** (tasks this one blocks).
- **Activity tab**: the task's own events merged with every event from its
  linked resources, newest first, with filter pills: Everything / This task
  only / Linked events / one pill per linked resource. Each resource event
  carries the link/unlink toggle.

## CLI

`worktree tasks …`, so agents can do everything the UI can, including
reading links, Focus/Related, blockers and linked events. Every command
takes `--json`.

- `list`: defaults to the current worktree when run inside one, which means
  direct and implicit tasks. Flags for `--all`, `--worktree`, `--resource
  <url|type:id>`, state, priority, starred, and include completed / archived.
- `show <id>`
- `add <title>` with priority, star, due, description, and links (`--focus`,
  `--related`; by default it Focus-links the current worktree when run inside
  one **(my call)**)
- `edit`, `state <id> <state>`, `star` / `unstar`, `delete`
- `link` / `unlink` (resource, worktree or event, with Focus/Related), `focus`
  / `unfocus`
- `subtask add|check|uncheck|remove|move`
- `block <id> --task|--resource|--other …`, `unblock`, `resolve` (the manual
  resolve for "other" blockers and for Slack/link blockers)
- `move <id> --after <id>|--before <id>|--top|--bottom` for reordering

Task IDs: short, stable, human-typeable IDs so agents and users can refer to
tasks in conversation **(my call; the format is the builder's)**.

The web API and the CLI go through one Go package (say `internal/tasks`),
so both produce identical task events and enforce the same rules.

## What's left to the builder

- Table layout, the fractional-index library or implementation, the task ID
  format.
- How Slack messages that aren't stored as their own `watcher_events` rows
  become linkable events (beyond the snapshot rule above).
- Blocker cycles (refusing them at write time is the obvious answer).
- The exact SQL for implicit membership and for the archived fallback.
- Which other sort options to offer beyond Custom, Priority and due date.
- How the timeline merges task events into the existing paged feed queries.
- The audit of every `watcher_subscriptions` query for the new `task:`
  subscribers (required, not optional).
- Following the repo's existing rules: Settings modal sync, if any config
  key is added; watcher toggles (a disabled service is never contacted, which
  also applies to polling blocker resources); docs in
  `docs/web-ui-architecture.md`.
