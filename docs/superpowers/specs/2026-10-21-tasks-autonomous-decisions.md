# Tasks — decisions made autonomously

On 2026-10-21 Mike asked Claude to finish all six phases without stopping for
approval, and to log here every question it would otherwise have asked, with
the answer it chose. Read this at the end and flag anything you disagree with.
The newest entries are at the bottom of each phase.

Format: **Q:** the question · **A:** what was done · **Why** · **To change:** what to edit if you disagree.

## May reconsider after further testing

Mike's review on 2026-10-23 kept these as built for now. He'll use them for a
while before deciding. Each one links back to the full entry below.

- **In-app navigation from the modal** (Phase 3, "Can you navigate in-app from
  inside the modal?"). Today resource titles and event "Open" links open a new
  tab. Mike may want in-app navigation instead, because new tabs can get
  messy. The way to do it is to close the modal first, then navigate, so
  `close()`'s `history.back()` doesn't undo the push. Files:
  `modal/LinksSection.tsx`, `modal/LinkedEventsSection.tsx`.
- **The modal closes before a delete finishes** (Phase 3, "What happens on
  delete?"). Today it closes at once and reopens with a red notice if the
  delete fails. Mike tends to prefer that a modal stays open with a spinner
  until an action that can fail is done, then closes. Files:
  `modal/TaskDetailModal.tsx` (delete-failure logic), `modal/TaskSidebar.tsx`
  (the control), `modal/TaskModalProvider.tsx` (`open(id, { error })`).
### Changed after review

- **Delete asks first again** (was Phase 6, "How does deleting a task work
  now?"). Mike: deleting a task can be a big deal. The sidebar's inline
  "Delete? Yes / No" is back, and Yes still offers the Undo toast.
  `/api/tasks/delete` keeps its 200 `{undo_event_id}`. Files:
  `DeleteControl` in `modal/TaskSidebar.tsx`.
- **Z undoes only the newest toast** (was Phase 6 final review fixes, "Does Z
  undo while the task modal is open?"). Mike: one Z undoing several things at
  once is risky. Only the newest undo toast on screen binds Z and shows its
  hint, for mark-read and task toasts alike. Older toasts keep their Undo
  button, and each one takes over Z once every newer toast has closed. It
  reads Mantine's `notificationsStore` rather than which toasts are mounted,
  because a hidden toast stays mounted through its exit transition. Files:
  `newestUndoID` in `ui/src/components/UndoToast.tsx`.
- **The watcher library owns what Tasks worked around** (Phase 3 final
  review fixes; Phase 5, Jira blockers and hold URLs). watcher v0.16.0 adds
  Jira `status_category` to cached state, lists each resource once in
  `ActiveResources`, and adds `RecentEventsForResource`, `GetEvent`,
  `EventByExternalTS` and `ResourceURL`. Jira blockers now resolve from
  cached state with no Jira search at all; holds record their blocker's
  URL; the event and URL reads go through the library. The `ev:` fallback
  for Slack-message links is gone too (see below). Each entry is rewritten
  in place.

**Backward compatibility:** none is needed with earlier phases of this work.
All six phases ship together, and nothing from them has been used for real.
For example, `ev:` links to Slack messages don't need migrating (Phase 3 final
review fixes).

## Phase 2 — task lists in the UI

- **Q:** The real-browser check can't run in this sandbox, because pointing the binary at a throwaway config (XDG_CONFIG_HOME) is refused. Do I work around that?
  **A:** No. Drag, pin and live refresh are covered by unit and component tests, plus a keyboard-driven drag test, but nobody has seen them working in a real browser.
  **Why:** Getting around a sandbox refusal isn't my call to make.
  **To change:** Run the check yourself. The command is in the "Browser check" section at the end of this file.
- **Q:** The pinned task panel inside a resource's sticky header took up 70–80% of an 800px-tall window. How should it be capped?
  **A:** The pinned list is capped at min(8 rows, 25% of the viewport height), and it scrolls inside that.
  **Why:** That keeps the feed usable even at the 720px "tall" threshold.
  **To change:** The cap is in `TasksSection.tsx` / `TaskList.tsx`.
- **Q:** Starting a drag made rows jump about 70px, because empty drop zones and section labels appeared mid-gesture. What's the fix?
  **A:** In draggable sorts, a slim "drag here to star" strip and the empty priority groups are now always visible, and section labels no longer depend on whether a drag is under way. A DragOverlay was added too.
  **Why:** A stable layout is the only reliable fix. The cost is a thin, always-visible strip while there are no starred tasks.
  **To change:** `TaskList.tsx`.
- **Q:** If a priority filter is on, what priority should quick add give a new task?
  **A:** The filtered priority. Otherwise the new task would vanish the moment it was added.
- **Q:** What should a task's row show in the detail card at the top of a resource's pane?
  **A:** No badge. That pane already has its own Tasks tab or pinned panel.
- **Q:** On a narrow worktree page, if you pin the list while the Tasks tab is open, which tab should it fall back to?
  **A:** The first tab, Resources. On the home page it's Activity, the first tab there.
- **Q:** Row clicks do nothing in Phase 2. Is that OK?
  **A:** Yes. Phase 3 adds the modal. "Add & open" also waits for Phase 3.
- **Q:** When a CLI or agent changes which resources a worktree follows, the task lists don't refresh until the next feed refresh. Is that OK?
  **A:** Yes. Task writes signal right away, and membership changes made from the UI refresh the lists immediately.

- **Q:** How should the state menu mark the current state?
  **A:** With `aria-current` and a ✓. Mantine's Menu forces `role="menuitem"`, so `menuitemradio` wasn't possible.
- **Q:** Which tasks count toward the badges?
  **A:** Only open tasks. Worktree cards, resource cards, and rows on the home page's Resources tab all show a lime count; none of them count completed tasks.

## Phase 3 — detail modal

- **Q:** Should the modal be linkable?
  **A:** Yes. Opening it sets `?task=<id>`, and Back closes it.
- **Q:** What title does a task made from a Slack message get?
  **A:** The first line of the message, trimmed to 120 characters.
- **Q:** Should delete ask for confirmation?
  **A:** Yes, with an inline "Delete? Yes / No" until Phase 6 adds undo.
- **Q:** A Phase 3 table had to be added to the database. Should that have needed sign-off?
  **A:** No. It's `task_event_links`, which stores a snapshot of each linked event so the link survives the watcher pruning that event.
- **Q:** Can you navigate in-app from inside the modal?
  **A:** No. Resource titles and event "Open" links open a new tab, worktree titles are plain text, and linked-event rows are inert. An in-app push would break `close()`'s `history.back()`. To change: `modal/LinksSection.tsx`, `modal/LinkedEventsSection.tsx` (close the modal first, then navigate).
- **Q:** What does Back do after closing the modal?
  **A:** It leaves the page as it was. `close()` calls `history.back()` when `open()` pushed the entry, and replaces the URL for deep links. To change: `modal/TaskModalProvider.tsx`.
- **Q:** What happens on delete?
  **A:** The modal closes first. If the delete fails, the task reopens with a red notice. To change: `ui/src/components/tasks/modal/TaskDetailModal.tsx` (delete-failure logic), `ui/src/components/tasks/modal/TaskSidebar.tsx` (the control), `modal/TaskModalProvider.tsx` (`open(id, { error })`).
- **Q:** What is "Add & open"?
  **A:** A subtle button beside Add in quick add: it creates, clears the input, opens the modal, and does not refocus the input. Enter and Add still add and stay. To change: `tasks/TaskQuickAdd.tsx`.
- **Q:** How do the header and sidebar edit controls behave?
  **A:** State is a select in the sidebar (the header has the checkbox menu). Starred is both the header star and a sidebar checkbox. Clearing a due date needs the Clear button, since clearing the native input by keyboard is ignored. To change: `modal/TaskSidebar.tsx`.
- **Q:** How are links removed and moved between Focus and Related?
  **A:** The ✕ is inline on every link row; "Make Focus/Related" is in the grip's hover menu (no keyboard path, but keyboard dragging between groups does the same). Dragging shows no preview; the link changes group on drop. To change: `modal/LinksSection.tsx`.
- **Q:** What does "global task" mean in the link picker?
  **A:** A task with no direct worktree link and no implicit worktree. Its suggestions come from all resources; otherwise they are scoped to its worktrees. Suggestions are capped at 50. To change: `modal/linkTargets.ts`, `modal/LinkPicker.tsx`.
- **Q:** Do the Details sections share one error alert?
  **A:** No, each shows its own inline alert. The description saves without optimism, so a failed save keeps the text. To change: `modal/sectionAction.tsx`, `modal/DescriptionSection.tsx`.
- **Q:** Which task rows open the modal?
  **A:** Any click on the row except the grip, star, state checkbox (and its portalled menu) and link chip. The due and subtask badges open it, and the row has no text-selection guard, so finishing a selection drag on it opens the modal. To change: `tasks/TaskRow.tsx`.
- **Q:** Where does "＋ task" sit, and which events get it?
  **A:** It overlays the row's top-right corner on hover or focus (always, on touch screens; see "Phase 3 final review fixes"), so it can cover the end of a long title. Only watcher events and Slack messages get it; task events and snapshot rows do not. Errors are a toast. To change: `components/EventRow.tsx`, `components/slack/Message.tsx`, `components/tasks/useMakeTask.ts`.
- **Q:** What title and body does a task made from a Slack message keep?
  **A:** (Title superseded by "Phase 3 final review fixes": it is now plain text.) The title is the first non-blank line of the raw mrkdwn (so `<@U…>` and `<url|label>` stay unrendered), up to 120 characters. The snapshot body is the raw text too. To change: `lib/taskEventKey.ts` (`slackMessageSnapshot`) and the `from-event` handler in `internal/webui/tasks_detail_api.go`.
- **Q:** Are Activity tab rows interactive?
  **A:** No, they are inert, so a long clamped body can't be expanded there. To change: `modal/ActivityTab.tsx`.
- **Q:** What does `from-event`'s `path` do?
  **A:** It adds the worktree the user acted in as a Focus link, but only if that worktree doesn't already follow the event's resource. To change: `internal/webui/tasks_detail_api.go`.
- **Q:** Is making a task from an event atomic?
  **A:** (Superseded by "Phase 3 final review fixes": it is now one transaction, `tasks.CreateFromEvent`.) No. It runs in two transactions (create, then link the event), so a failure between them leaves a task without the link. To change: the `from-event` handler in `internal/webui/tasks_detail_api.go`.
- **Q:** What is in the Activity feed?
  **A:** (Superseded by "Phase 3 final review fixes": each resource is now read with a limited query.) The task's own events plus every watcher event of its linked resources (full history per resource, newest 200). A Slack thread event shows as linked when its `slack:` key is linked. To change: `handleTaskActivity` in `internal/webui/tasks_detail_api.go`.
- **Q:** What if a linked `ev:` event is pruned or its type changes?
  **A:** The UI renders the stored snapshot. The server ignores a client-sent snapshot for `ev:` keys but trusts one for `slack:` keys (now validated; see "Phase 3 final review fixes"). To change: `internal/webui/tasks_detail_api.go`.

### Phase 3 final review fixes

- **Q:** The activity feed loaded each linked resource's full event history on every SSE refresh. Fix it in the watcher library (a paged `EventsForResource`) or here?
  **A:** *(Changed 2026-10-23 after Mike's review: library owns it, watcher v0.16.0.)* In the library. The feed reads each resource with `watcherdb.RecentEventsForResource` (newest first, at most 200, bookkeeping excluded); the local `recentResourceEvents` query is gone, as are the local reads of one event (`watcherdb.GetEvent`), a Slack message's event by ts (`watcherdb.EventByExternalTS`) and a resource's URL (`watcherdb.ResourceURL`). `useTaskActivity` has a 5 s `staleTime`, and because `invalidateQueries` refetches fresh queries anyway, `useSSE` also holds back the refresh of a feed fetched within the last 5 s until that window ends. (Before: a direct query here, because this run pushed no library release.)
  **Why:** Queries over the library's schema belong in the library, which agent-handler shares.
  **To change:** `handleTaskActivity` and `liveEvent` in `internal/webui/tasks_detail_api.go`. The SSE throttle is `refreshActivity` in `ui/src/hooks/useSSE.ts`; the window is `TASK_ACTIVITY_STALE_MS` in `ui/src/hooks/useTaskDetail.ts`.
- **Q:** A Slack message could be linked under two keys, `slack:<channel>:<ts>` from the thread view and `ev:<id>` from a feed. Which is its identity?
  **A:** `slack:<channel>:<ts>`. Linking a Slack thread event's `ev:` key (through `events/link` or `from-event`) stores it under the `slack:` key with the server-built snapshot, which overwrites a client snapshot the key already had (`tasks.LinkEventReplace`). A feed row reports the key it is linked under as `linked_key` (a live Slack row's `slack:` key, which the client can't derive from its id), and the Activity tab unlinks by that. `filter=linked` renders every link, from its live event (an `ev:` key's while the type matches, a `slack:` key's by `external_ts`) or else from its snapshot. *(Changed 2026-10-23 after Mike's review: no backward compatibility.)* Links stored under a Slack message's `ev:` key before this are no longer recognised: `linkedKeyOf` matches a Slack message by its `slack:` key only.
  **Why:** One key per message means one link, one "linked" state, and no client-side guessing between keys.
  **To change:** `resolveEventLink`, `liveEvent` and `linkedKeyOf` in `internal/webui/tasks_detail_api.go`; `ActivityTab.tsx`.
- **Q:** What does the server accept as a client snapshot for a `slack:` key?
  **A:** Only a snapshot for a Slack thread in the key's channel (`resource_type` `slack`, `resource_id` `<channel>:<thread ts>`), with a title or body and an empty or `http(s)` URL; the key needs a non-empty channel and ts. The server sets `source`/`type` itself and cuts the title to 200 runes. Anything else is a 400.
  **To change:** `validSlackSnapshot` in `internal/webui/tasks_detail_api.go`.
- **Q:** Unsaved description edits were lost on an outside click or Back. Block Back too?
  **A:** No; an SPA can't cleanly block Back. An outside click no longer closes the modal while the description is dirty, and the close button or Esc asks "Discard unsaved description?" (`window.confirm`). Back still closes it, but the draft is kept in `sessionStorage` per task, and reopening the task restores it into the editor with an "Unsaved draft restored" note. Save, Cancel, discarding and deleting the task clear it.
  **Why:** Losing the open modal on Back is acceptable once the text itself survives.
  **To change:** `modal/DescriptionSection.tsx` (dirty flag, storage) and `modal/TaskDetailModal.tsx` (guarded close, `closeOnClickOutside`). Use a Mantine confirm modal instead of `window.confirm` there if you want it styled.
- **Q:** Should titles made from Slack messages keep the raw mrkdwn?
  **A:** No. They are plain text: `<@U…|name>` → `@name` (the display name in the thread view, else `@user`), `<#C…|name>` → `#name`, `<url|label>` → `label`, `<url>` → `url`, and `&lt;`/`&gt;`/`&amp;` unescaped. Formatting marks like `*bold*` are left alone. The snapshot body stays raw. The server (from-event titles) and the client (`slackMessageSnapshot` titles) do the same, with table tests on both.
  **To change:** `slackPlain` in `internal/webui/slackplain.go` and `mrkdwnToPlain` in `ui/src/lib/mrkdwnPlain.ts`; keep them in step.
- **Q:** The hidden "＋ task" button could be tapped on a touch screen. Fix?
  **A:** While hidden it has `pointer-events: none`, and where nothing can hover it is always shown. To change: `components/EventRow.tsx`.
- **Q:** What names the modal for screen readers?
  **A:** The task's title, through Mantine's `Modal.Title` in the header, instead of the fixed "Task details" label (which landed on the modal's root, not the dialog). To change: `ModalTitleText` in `modal/TaskModalHeader.tsx`.

## Phase 4 — activity, unread and notifications

- **Q:** Which task events count as unread?
  **A:** Only agent events (`actor = 'agent'`) past the task's own cursor. Your own events never do.
  **Why:** Unread means "something happened that you didn't do", the same as the user-is-never-unread rule for PRs and Jira.
  **To change:** the unread-actors list in `internal/tasks/unread.go` (`CountsAsUnread`, `UnreadActorSQL`: the rule's one source); the cursor comparison is `TaskSummaries` in `internal/unread/unread.go`.
- **Q:** A task with no cursor row yet: read or unread?
  **A:** Unread. A missing cursor reads as `''`, so everything an agent did counts until you first mark the task read. Resources do the opposite (seeded at their newest event).
  **Why:** Tasks are created by agents as often as by you, and their first activity should be seen.
  **To change:** `TaskSummaries` in `internal/unread/unread.go`, or seed a cursor where tasks are created in `internal/tasks`.
- **Q:** Paging the merged feed: same-second events at a page boundary can be skipped. Is that OK?
  **A:** No (revised in the final review: the frontend does page with `next_cursor`, through Load more, and task ts values have one-second resolution). The cursor stays a plain strict `before`, but every page is OVERFILLED with every remaining row, from either source, sharing the last kept row's ts, so no cluster is split. The frontend treats only a short page as the end, so an overfull page is safe.
  **Why:** It fixes the loss without a compound cursor.
  **To change:** `mergeTaskEvents` and the two handlers in `internal/webui/timeline.go`, and `FeedQuery.AtTS` in `internal/tasks/feed.go`.
- **Q:** Does a Slack thread's `has_unread` include task unread?
  **A:** No. `has_unread` stays Slack's own verdict, because Mark all read uses it to decide whether to write to Slack. Task unread is a separate `task_unread_count`, folded into `unread_count`, the dot and the badges.
  **To change:** `resourceHasUnread` in `internal/webui/unread.go`, and `hasUnread()` in `ui/src/lib/unread.ts`.
- **Q:** Should the "Task activity" category get a filter bar?
  **A:** No. A one-category bar is hidden, as for Slack, and under the Tasks source every event is task activity anyway. `event_types=task` still works through the API.
  **To change:** `categoriesFor` in `ui/src/lib/eventTypeFilter.ts`.
- **Q:** Does the Tasks source filter narrow resource lists and worktree cards?
  **A:** No, only the feed. No resource has type `task`, so narrowing them would empty the pages.
  **To change:** `ui/src/hooks/useActivityFilter.ts` and the lists that consume it.
- **Q:** Who is notified of task events?
  **A:** Agent events only. A worktree is notified when the task is in its scope and it has "Notify on all", or "Notify on new events" on a resource the task links AND the worktree tracks. A global task notifies nobody, and only registered worktrees are notified.
  **Why:** A global task belongs to no worktree, so there is nowhere to send the banner.
  **To change:** `notifyTaskBatches` in `internal/webui/notify_scan.go`.
- **Q:** Clicking a worktree-wide notification while a resource is selected or a task modal is open?
  **A:** It clears the selection and closes the modal, going to the bare worktree. Resource and task notifications change only their own URL param.
  **To change:** `openNotificationTarget` in `ui/src/lib/browserNotify.ts`.
- **Q:** Does a global task's unread count toward the browser tab's badge and favicon?
  **A:** No. The tab badge sums the worktree list (`lib/unreadBadge.ts`), and a global task (one in no worktree's scope) belongs to no worktree. Its unread shows on the task's row, in the home feed and in Mark all read on the home page, but not in the tab title or favicon.
  **Why:** The badge's one source is `["worktrees"]`, the query the stream already invalidates; adding global tasks would mean another source to fetch and keep in step for an edge case.
  **To change:** `ui/src/hooks/useUnreadFavicon.ts` and `ui/src/lib/unreadBadge.ts` (fold in `GET /api/task-unread?scope=all`, or a global count on the worktree list response).
- **Q:** When does the unread divider show in a feed mixing task events?
  **A:** Only when the unread rows are one contiguous run at the top. Task events have their own cursors, so otherwise a single divider line would be wrong; the per-row marks still show.
  **To change:** `ui/src/components/TimelineFeed.tsx`.
- **Q:** What does a task's Mark read clear?
  **A:** Exactly what was counted: it marks through `unread_through_ts` from the same summary as the count. Events arriving after render stay unread. When nothing would move it says "Already read" with no undo.
  **To change:** `useMarkTaskRead` in `ui/src/components/tasks/modal/`, and `taskDTO` in `internal/webui/tasks_api.go`.
- **Q:** Mark all read with tasks?
  **A:** Every form also lists and clears the unread tasks of its scope (checked by default in the modal, via `GET /api/task-unread`). A resource's line counts only its own unread, so a Slack thread with only task unread isn't marked in Slack. One failure reports all failed undos in a single toast, each named.
  **To change:** `ui/src/components/MarkAllReadButton.tsx`.
- **Q:** Cost of the extra request?
  **A:** Each Mark all read button fetches `GET /api/task-unread` on mount and on task invalidations. It is cheap and the failure is silent.
  **To change:** the query in `MarkAllReadButton.tsx`.

## Phase 5 — blockers

- **Q:** How is a Jira blocker found to be Done?
  **A:** *(Changed 2026-10-23 after Mike's review: library owns it, watcher v0.16.0.)* From its cached state, as a PR's is: the task's `task:` hold keeps the issue polled, and the Jira poller caches `status_category`. Done iff it is `done`; the reason is the cached `status` name. No state, or a row cached before v0.16.0 without the category (until the next poll rewrites it), is unknown, and the blocker keeps its last state. (Before: a poll-time `key in (...)` Jira search with an in-memory status cache, a key-by-key retry on HTTP 400 and an hour-long bad-key memory, all now deleted.)
  **Why:** The hold already polls the issue; a second Jira read was only needed while the cache lacked the category.
  **To change:** `jiraBlockerStatus` in `internal/webui/blocker_status.go`.
- **Q:** Can a Jira resolution lag?
  **A:** *(Changed 2026-10-23 after Mike's review: library owns it, watcher v0.16.0.)* Yes, by up to one poll interval, like a PR's: resolution reads only cached state. The poll loop runs a resolution pass after every poll, so a state it just cached resolves at once; task writes run one too.
  **Why:** A request should never wait on a network service.
  **To change:** `resolvePass` and `afterTaskWrite` in `internal/webui/blocker_status.go`, and the call in `safePollAll` (`internal/webui/poller.go`).
- **Q:** May any request search Jira?
  **A:** *(Changed 2026-10-23 after Mike's review: library owns it, watcher v0.16.0.)* For blockers, no request contacts Jira at all, the poll-on-view route included. Only the watcher library's poller reads Jira.
  **To change:** `blockerStatusLookup` in `internal/webui/blocker_status.go`.
- **Q:** Do Slack-thread blockers keep a `task:<id>` hold?
  **A:** Yes, like every resource blocker but a link, though Slack threads never resolve themselves. It keeps the cached title and status fresh for the label, at the cost of one `conversations.replies` call per Slack blocker per poll.
  **To change:** `ReconcileHolds` in `internal/tasks/holds.go`.
- **Q:** Can two tasks block each other?
  **A:** Adding a blocker that would form a cycle is refused (400). But an automatic unresolve (a PR reopened) may re-form a mutual block, and that is accepted: blocking never prevents completion, so both tasks just show blocked until one resolves.
  **To change:** `wouldCycle` in `internal/tasks/blockers.go` and `ResolveBlockers` in `internal/tasks/resolve.go`.
- **Q:** How late is an Unblocked notification, and which toggles apply?
  **A:** (Hold length superseded by Phase 6, "When does "Unblocked" notify?": the hold is now 15s, `UNDO_WINDOW_MS` + the 5s scan. The rest stands.) About 10-15s after the resolution: each event is held for 10s from the notifier pass that finds it (on top of the 5s scan), then re-checked: the event must still exist, its task must not be deleted, and its blocker must still exist and still be resolved. Phase 6 aligns the hold with the undo window. Only the global "Enable notifications" switch, the delivery mode and the custom command apply; the per-worktree and per-resource toggles are ignored. Automatic unresolves never notify. Held items do not survive a restart, and a resolution the CLI makes notifies only while `worktree ui` is running (its cursor starts at the newest event).
  **Why:** Phase 6's undo deletes the events it cascades, and a notification for an undone action would be wrong.
  **To change:** `unblockHoldDefault` and `unblockStillStands` in `internal/webui/notify_unblock.go`.
- **Q:** Where does an Unblocked notification go?
  **A:** To the worktree of the task's first Focus link (a registered worktree, or the first follower of a Focus resource), else the first worktree whose scope holds the task, else untargeted. An untargeted one opens the task over the home page (`/?task=<id>`; cmux: the UI server's own workspace).
  **To change:** `unblockTargeter` in `internal/webui/notify_unblock.go` and `ui/src/lib/browserNotify.ts`.
- **Q:** Are system events unread?
  **A:** Yes. An event is unread when its actor is not you: `agent` or `system`. System blocker events do not notify through the per-worktree task path (they are dropped or go through the Unblocked path).
  **To change:** `unreadActors` in `internal/tasks/unread.go`; the skip in `readNewTaskEvents` (`internal/webui/notify_scan.go`).
- **Q:** Who is the author of a system event?
  **A:** "worktree", shown in the timeline and in search.
  **To change:** the author mapping in `internal/webui/task_timeline.go`.
- **Q:** How are blocker states labelled?
  **A:** A task's state shows as "Not started", "In progress" or "Done" everywhere, from one map; a deleted task shows "deleted" and a resolved Slack, link or other blocker "resolved". A resolved blocker also shows its reason ("merged", "closed", a status name) when it adds to the status.
  **To change:** `TASK_STATE_LABEL` in `ui/src/components/tasks/TaskStateCheckbox.tsx`; `status_label` in `internal/webui/tasks_blockers_api.go`.
- **Q:** What can the blocker pickers choose?
  **A:** Tasks: not done, not this task, not a task it blocks, not one already blocking it. Resources: from the task's scope plus a pasted URL, minus those already blockers. Other: free text.
  **To change:** `ui/src/components/tasks/modal/BlockerPicker.tsx`.
- **Q:** What does the resource badge say?
  **A:** "⛔ blocks N" on list cards and Resources rows (the full "Blocks N open tasks" on hover), not on the detail card, whose aside is already full.
  **To change:** `BlocksBadge` in `ui/src/components/tasks/TaskCountBadge.tsx`.
- **Q:** Who can mark a blocker resolved?
  **A:** You, only for free-text, Slack and link blockers. PR, Jira and task blockers resolve themselves and can't be ticked.
  **To change:** `ManuallyResolvable` in `internal/tasks/blockers.go`.
- **Q:** What blocker commands does the CLI have?
  **A:** `tasks block <id> (--task <id> | --resource <ref> | --other <text>)`, which prints the blocker's id; `tasks unblock <blocker-id>`; and `tasks resolve <blocker-id> [--unresolve]`, for Slack, link and free-text blockers only. Each takes `--json`. `list --json` and `show --json` carry `blocked`, `blocker_count` and `blocker_labels` (the web DTO's names), and `show` adds `blockers` and `blocks`. A task blocker resolves at once from the CLI; PR and Jira blockers wait for `worktree ui`'s next pass, since only it looks them up. CLI labels are the event labels ("T4 Ship it", "pr:o/r#4498"), not the UI's display titles.
  **Why:** Thin wrappers over `internal/tasks`, like the other `tasks` commands; the CLI has no network status lookup.
  **To change:** `cmd/tasks_blockers.go`.
- **Q:** Does adding an already-satisfied blocker notify?
  **A:** No. A blocker the same request resolves (a merged PR added in the web UI, or a task blocker whose task is already done, from either side) is resolved with `on_add: true` in its event payload, and the Unblocked path skips it. Only that blocker is marked; any other blocker the same pass happens to resolve still notifies. A later resolution of the same blocker notifies as usual.
  **Why:** The user just clicked it; there is nothing to tell them.
  **To change:** `ResolveOptions.OnAddBlocker` in `internal/tasks/resolve.go`, `afterBlockerAdd` in `internal/webui/blocker_status.go` and `isUnblockEvent` in `internal/webui/notify_unblock.go`.
- **Q:** And an already-satisfied PR or Jira blocker added from the CLI?
  **A:** The CLI can't look resources up, so the next `worktree ui` pass resolves it, and that resolution does notify: the `on_add` suppression covers only a resolution made in the same request as the add (a web add, or any task blocker whose task is already done).
  **To change:** `runTasksBlock` in `cmd/tasks_blockers.go`.
- **Q:** Do link blockers hold a subscription?
  **A:** No. Nothing ever polls a link for a status, so a hold would keep nothing fresh; existing link holds are released by the next reconcile. Every other resource blocker still holds one. *(Changed 2026-10-23 after Mike's review: library owns it, watcher v0.16.0.)* A hold records the lexically first URL its resource's blockers were pasted from, else the URL the DB knows (`watcherdb.ResourceURL`). `ActiveResources` now lists each resource once, so a hold no longer copies other subscriptions' URL to avoid double polling.
  **To change:** the wanted query and `holdURL` in `internal/tasks/holds.go`.
- **Q:** Can a done task show as blocked?
  **A:** No. `blocked` is false and `blocker_count` 0 for a done task, and its row shows no chip, even while a blocker is unresolved. The blockers stay listed in the modal, and the task is blocked again if it is reopened.
  **Why:** A finished task has nothing left to wait on.
  **To change:** `loadBlockerCounts` in `internal/tasks/list.go` and the chip in `ui/src/components/tasks/TaskRow.tsx`.
- **Q:** What stops two resolution passes in one process from fighting?
  **A:** `resolveMu` on the server holds for the `resolvePass` lookup, resolve and reconcile, so a web write's pass that looked a PR up as open can't unresolve what the poll just resolved as merged. *(Changed 2026-10-23 after Mike's review: library owns it, watcher v0.16.0.)* The pass contacts no service, so nothing it holds the lock across can wait on the network.
  **To change:** `resolvePass` in `internal/webui/blocker_status.go`.

## Phase 6 — undo

- **Q:** How does deleting a task work now?
  **A:** One click, with an Undo toast. The old inline "Delete? Yes / No" is gone. `/api/tasks/delete` answers 200 `{undo_event_id}` instead of 204.
  **Why:** Undo makes the confirmation redundant.
  **To change:** `onDelete` in `ui/src/components/tasks/modal/TaskDetailModal.tsx`, `handleDeleteTask` in `internal/webui/tasks_detail_api.go`.
- **Q:** When is a deleted task really gone?
  **A:** A sweep every 5 minutes removes tasks deleted more than 1 hour ago, with their events, read cursor and holds. Another task's blocker on it stays and labels "T<id> (deleted)".
  **To change:** `taskPurgeInterval`, `taskPurgeAfter` in `internal/webui/poller.go`; `internal/tasks/purge.go`.
- **Q:** Does an undo leave a trace?
  **A:** No. It deletes the undone event and its cascade events and writes no "reverted" event.
  **Why:** History stays truthful about what stands, and no second "Unblocked" can fire for a completion that was undone.
  **To change:** `internal/tasks/undo.go`.
- **Q:** What can be undone?
  **A:** Only the newest change (compare-and-swap on the event and the current value). If an agent changed the task in between, the answer is 409 and nothing changes.
  **To change:** the CAS checks in `internal/tasks/undo.go`.
- **Q:** What about the CLI?
  **A:** `worktree tasks undo <event-id>` prints "Undone." and exits non-zero on a conflict. `state`, `delete` and subtask `check`/`uncheck` with `--json` carry `undo_event_id`.
  **To change:** `cmd/tasks.go`, `cmd/tasks_json.go`.
- **Q:** What happened to the after-commit blocker resolver for tasks?
  **A:** It is kept as a safety net and runs after every undo and each poll, but `SetState`, `Delete` and `AddBlocker` now settle task-kind blockers in their own transaction, so undo can reverse them exactly (`resolved_event_id`).
  **To change:** `settleTaskBlockersTx` in `internal/tasks/resolve.go`.
- **Q:** What does undoing an event that no longer exists return?
  **A:** 409 if the id was issued once (at or below `sqlite_sequence`; undone or purged), 404 only for an id never issued.
  **Why:** "Already undone" is a conflict, not a mistake.
  **To change:** `loadUndoEvent` in `internal/tasks/undo.go`.
- **Q:** How long does the toast last?
  **A:** A fixed 10s deadline; hovering no longer extends it. This applies to the mark-read toasts too.
  **To change:** `ui/src/components/UndoToast.tsx`.
- **Q:** When does "Unblocked" notify?
  **A:** 15s after the notifier sees the event (`UNDO_WINDOW_MS` + the 5s scan), so an undo through the toast always lands first.
  **To change:** `unblockHoldDefault` in `internal/webui/notify_unblock.go`.

### Phase 6 final review fixes

- **Q:** Who may undo what?
  **A:** The user may undo any undoable event. An agent may undo only an event whose actor is `agent`; otherwise `ErrUndoForbidden` ("only the user can undo the user's changes"), a 409 on the web (which always acts as the user, so it never sees it) and exit 1 in the CLI. No `actor_session` match is required between agents.
  **Why:** An undo writes no event, so without this an agent could change the user's work with no trace, no unread mark and no notification.
  **To change:** `checkUndoActor` in `internal/tasks/undo.go`; `writeTaskError` in `internal/webui/tasks_api.go`.
- **Q:** What does an undo return when the task was deleted or the subtask removed since?
  **A:** 409 (`ErrUndoConflict`), not 404. 404 is only for an event id never issued. A subtask check undo now loads the event before the subtask, so an unknown id is still a 404. A purged task's events are purged with it, so its undo is a 409 as well.
  **Why:** The event was issued and the thing changed since, the same rule as "already undone".
  **To change:** `UndoStateChange`, `UndoSubtaskCheck` and `UndoDelete` in `internal/tasks/undo.go`.
- **Q:** Can an undo set off an "Unblocked" notification?
  **A:** No. An undo settles the restored task's task-kind blockers in its own transaction (`settleTaskBlockersTx` with `markOnUndo`). A resolution it writes carries `"on_undo": true`, which the notifier skips like `on_add`. An unresolve of a blocker whose resolution was an earlier undo's `on_undo` one deletes that event and clears the row instead of writing an unresolve. So "X blocked by W; delete X; delete W; undo X's delete; undo W's delete" leaves X's history as it was. This is also true for undoing a completion whose own blocker's blocking task finished meanwhile: the blocker resolves quietly, because the undo is the user's own action. The after-commit resolver still runs after every undo as a safety net, and finds nothing.
  **Why:** An undo puts back the user's own earlier state, and that is not news. Without this, the reported ordering wrote "Unblocked" and then "blocked again", and notified if the second undo came more than 15s later.
  **To change:** `settleTaskBlockersTx` and `withdrawUndoResolutionTx` in `internal/tasks/resolve.go`; `isUnblockEvent` in `internal/webui/notify_unblock.go`.
- **Q:** Does Z undo while the task modal is open?
  **A:** Yes. `useButtonHotkey` takes an opt-in `aboveOverlays`, which the undo toast passes, so its Z is not ignored for being outside the open dialog. Typing still never triggers it. No other caller changes. With several undo toasts open, Z still presses all of them, as it already did for mark-read (pre-existing).
  **To change:** `ui/src/hooks/useButtonHotkey.ts`, `ui/src/components/UndoToast.tsx`.
- **Q:** How does a failed `tasks undo` print?
  **A:** The error, once, on stderr, exit 1, with no usage block. Only the undo command sets `SilenceUsage` and `SilenceErrors`; other commands keep cobra's behaviour (error, usage, error), unchanged.
  **Why:** Undo is the first command meant to fail routinely, for agents that parse its output. Silencing on root would also drop the usage block from argument errors on every command, which is a wider change than this phase needs.
  **To change:** `tasksUndoCmd` in `cmd/tasks.go` (or `rootCmd` in `cmd/root.go` to apply it everywhere).
- **Q:** What does a task blocker read as when the blocking tasks can't be read?
  **A:** A neutral "T<id>" with no status. "T<id> (deleted)" is only for an id with no row (purged), after a successful read. A soft-deleted, not yet purged, task keeps "T<id> <title>" with status "deleted".
  **To change:** `blockerLabeler` in `internal/webui/tasks_blockers_api.go`.

## Browser check (run this yourself)

A throwaway config, with a throwaway UI password, watchers and cmux off, is at
`~/tmp/tasks-phase2-xdg/worktree/config.yaml`. From the worktree, run:

```
make build
XDG_CONFIG_HOME=~/tmp/tasks-phase2-xdg WATCHER_HOME=~/tmp/tasks-phase2-watcher WORKTREE_DB=~/tmp/tasks-phase2-smoke.db \
  env -u CMUX_SOCKET_PATH ./bin/worktree ui --port 4090 --local-only --no-open
```

Open http://127.0.0.1:4090 and log in with the password from that config file. Then check each of these:

1. On the home page, add three tasks, star one, drag another into Starred, and confirm the row doesn't jump when the drag starts.
2. Switch to Priority sort and drag a task into a different priority group, including an empty one.
3. Pin the list. It should sit above the tab bar and stay there while the feed scrolls. Unpin it.
4. With the same env vars set, run `./bin/worktree tasks add x --global` in another shell. The task should appear within about 5s, with no reload.
5. On a narrow window and on your phone over HTTPS, the drag handle should be visible.

Stop the server with Ctrl-C when you're done.
