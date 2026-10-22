# Tasks — decisions made autonomously

On 2026-10-21 Mike asked Claude to finish all six phases without stopping for
approval, and to log here every question it would otherwise have asked, with
the answer it chose. Read this at the end and flag anything you disagree with.
The newest entries are at the bottom of each phase.

Format: **Q:** the question · **A:** what was done · **Why** · **To change:** what to edit if you disagree.

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
  **A:** It overlays the row's top-right corner on hover or focus, so it can cover the end of a long title. Only watcher events and Slack messages get it; task events and snapshot rows do not. Errors are a toast. To change: `components/EventRow.tsx`, `components/slack/Message.tsx`, `components/tasks/useMakeTask.ts`.
- **Q:** What title and body does a task made from a Slack message keep?
  **A:** The title is the first non-blank line of the raw mrkdwn (so `<@U…>` and `<url|label>` stay unrendered), up to 120 characters. The snapshot body is the raw text too. To change: `lib/taskEventKey.ts` (`slackMessageSnapshot`) and the `from-event` handler in `internal/webui/tasks_detail_api.go`.
- **Q:** Are Activity tab rows interactive?
  **A:** No, they are inert, so a long clamped body can't be expanded there. To change: `modal/ActivityTab.tsx`.
- **Q:** What does `from-event`'s `path` do?
  **A:** It adds the worktree the user acted in as a Focus link, but only if that worktree doesn't already follow the event's resource. To change: `internal/webui/tasks_detail_api.go`.
- **Q:** Is making a task from an event atomic?
  **A:** No. It runs in two transactions (create, then link the event), so a failure between them leaves a task without the link. To change: the `from-event` handler in `internal/webui/tasks_detail_api.go`.
- **Q:** What is in the Activity feed?
  **A:** The task's own events plus every watcher event of its linked resources (full history per resource, newest 200). A Slack thread event shows as linked when its `slack:` key is linked. To change: `handleTaskActivity` in `internal/webui/tasks_detail_api.go`.
- **Q:** What if a linked `ev:` event is pruned or its type changes?
  **A:** The UI renders the stored snapshot. The server ignores a client-sent snapshot for `ev:` keys but trusts one for `slack:` keys. To change: `internal/webui/tasks_detail_api.go`.

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
