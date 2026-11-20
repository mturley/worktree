# Slack thread root event — design + plan

Approved in conversation 2026-11-20 (option A). Follows
`2026-11-19-slack-thread-backfill-design.md`.

## Why

A thread's first message lives only in the `watch_started` body, and
`watch_started` is hidden from every feed, from unread and from search.
Search reaches the first message only through the cached thread title,
which is cut to 60 runes. The first message should be an activity event
like any reply: visible, searchable in full, dated when it was sent.

## Approaches

- **A. A separate `slack_thread_root` event (chosen).** Dated at the
  root's send time, authored, full body. Unread and notifications need no
  change: the existing Slack rules already handle it.
- B. Show `watch_started` in the UI — rejected for this purpose: it is
  dated at follow time, so the first message would sit at the wrong point
  in history, and every PR and Jira issue would gain a row. Whether to
  show follow markers at all is a separate decision (reminder set).

## Design

### Library (`~/git/watcher`, release `v0.31.0`)

- `watcher.EventTypeSlackThreadRoot = "slack_thread_root"`, label
  "Slack thread starts". Not a bookkeeping type.
- First poll with backfill: emits the root event first, then replies,
  then `watch_started` last. The root event has the same shape as a
  reply event: `ts` = the root's send time, `external_ts` = the root ts,
  `author`/`author_id` = the root's author, title
  `Thread started: <60-rune title>`, body `Author: <full text>`. It is
  deduped on `external_ts`. Without backfill there is no root event.
- `BackfillThread` also emits the root event when it is missing, and
  rewrites its body under the same name-resolution guard as replies.
- `watch_started` keeps its body unchanged.

### worktree

- Re-pin `v0.31.0`.
- `slackEventTitle` (`internal/webui/timeline.go`): the root event gets
  `Thread started: <custom name or cached title>`.
- `slackKeyOf` (`internal/webui/tasks_detail_api.go`): the root event is
  a Slack message too, so a task made from the root in the thread view
  links to it.
- UI: `eventMeta.tsx` entry (grape, the thread icon, label "thread
  start"); `isSlackMessageEvent` includes it, so the row and the modal
  render it as Slack text.
- Unread, notifications and the activity filters need no change. Slack
  has no subfilters, and the unread queries exclude only `watch_started`
  and `watcher_error`.
- Docs: the "Polling model" paragraph.
- After install: re-run the catch-up (`BackfillThread`) over followed and
  archived threads to add root events. Same checks as before. Nothing is
  committed.

## Tasks

1. Library: type + label; first-poll root event; `BackfillThread` root.
   Tests: a backfill first poll records one root event at its send time,
   authored, full body, ordered before `watch_started`; a non-backfill
   first poll records none; `BackfillThread` adds a missing root once and
   rewrites a short root body; an unresolved author leaves the body
   alone. Commit, tag, ask Mike, push.
2. worktree: re-pin, `slackEventTitle`, `slackKeyOf`, UI meta and
   `isSlackMessageEvent`, docs; tests for each. `make test`. Commit.
3. Review, merge, install, catch-up, verify.
