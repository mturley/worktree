# Slack thread backfill on follow — design

## Intent

Following a Slack thread today records only a `watch_started` event; replies
sent before the follow never become `watcher_events`, so search (which runs
over events) can't find them. Following a thread should instead record its
earlier replies, so they are searchable without search ever calling Slack.

## Goals

- Following a Slack thread records every earlier reply as a `slack_reply`
  event (up to the 200 messages `conversations.replies` already returns).
- Each backfilled event's `ts` is the message's own send time, so it sits at
  the right point in the activity history instead of at the top.
- Unread state matches Slack's: a backfilled reply at or before Slack's
  `last_read` reads as read, one after it as unread. This already falls out
  of the existing mirror (`unread.SlackNewerSQL`, `slackTSGreater`), which
  compares `external_ts` (the Slack message ts, unchanged) against the cached
  `last_read`.
- The follow itself still shows as a `watch_started` event at follow time.
- Threads already followed get the same history, via a one-off catch-up run
  in the implementing session.

## Non-goals / anti-goals

- No search call to the Slack API.
- No paging past 200 messages.
- No upgrade migration, hidden command or shipped code for catching up
  existing threads.
- No change to agent-handler's behavior (it never sets the flag).
- GitHub/Jira backfill paths, which have the same "dated now" flaw, are left
  alone — nothing turns them on.
- Anti-goal: making replies look unread that Slack has read (or the reverse).

## Approaches

- **A. worktree sets the library's existing `SubscribeOpts.Backfill` for
  Slack threads; the library's Slack backfill path is fixed (chosen).** The
  flag was designed for exactly this in watcher `05bb14e` and is checked by
  every poller but set by no consumer. Library change + release + re-pin.
- B. Library always backfills Slack, no flag — rejected: changes
  agent-handler's behavior and ignores the per-subscription option.
- C. worktree fetches and writes the events itself on follow — rejected:
  duplicates poller logic in worktree, which the project's rules forbid.

## Design

### Library (`~/git/watcher/slack`)

- When the cursor is empty and backfill is on, the poller emits
  `watch_started` (ts now, `external_ts` = latest thread ts, as today) **and**
  a `slack_reply` per reply, deduped as today.
- Backfilled replies get `ts` = the Slack ts converted to RFC3339 UTC (whole
  seconds). Live replies (cursor non-empty) keep wall-clock `ts`, as today.
- The backfill step is an exported function taking a DB, a `Client` and a
  resource (name left to the builder), so a throwaway program can run it
  against an already-followed thread: it emits any reply not already
  recorded (dedup by `external_ts`), regardless of cursor, without emitting a
  second `watch_started`.
- Tests: backfill emits watch_started + one event per reply; backfilled `ts`
  equals the message time; live replies unchanged; re-running the exported
  function emits nothing new.
- Release a new minor tag; push main + tag.

### worktree

- Re-pin the library.
- `resources.Add` passes `Backfill: true` when the resource is a Slack
  thread (Subscribe refreshes the flag on an existing row too).
- Test that a Slack add sets the flag and a PR/Jira add does not.
- Update `docs/web-ui-architecture.md` where it describes what following a
  Slack thread records.

### Catch-up of already-followed threads (in-session, not shipped)

A throwaway Go program in the session scratchpad, using worktree's DB
(`~/.local/share/worktree/worktree.db`) and Slack credentials
(`watcher-auth.yaml`), calls the exported backfill function for each live
`worktree:` Slack subscription. Back up the DB first; run while `worktree ui`
keeps polling (dedup makes overlap safe).

## Accepted edge

The notifier re-reads the last 30 s of `ts`, so a reply sent under 30 s
before the follow can notify once. Left as is.

## Left to the builder

Function names, how the converted ts handles an unparseable Slack ts (fall
back to wall clock), and test fixture shapes (synthetic only).
