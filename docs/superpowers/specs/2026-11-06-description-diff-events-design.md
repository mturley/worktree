# Description diffs for Jira and PR "description changed" events

Date: 2026-11-06
Status: approved 2026-11-06

## Why

When someone else edits a Jira issue's description, the feed shows
"RHOAIENG-79263 description changed" and nothing else. To learn what they
changed, Mike has to open Jira and compare versions in his head. He wants the
event's details modal to answer "what exactly did they change?" with a
code-style diff: changed lines highlighted, and inside each line the specific
words that changed.

PR descriptions get edited the same way and today produce no event at all. They
get the same treatment.

Most PR description edits are made by bots (coderabbitai rewriting its
auto-generated summary: 4 of 8 edits on odh-dashboard#10557). Those must be
visible but must not compete for attention.

## Goals

1. `jira_description_changed` events carry the full description before and
   after the edit.
2. A new `pr_description_changed` event, emitted for each edit of a followed
   PR's description, carrying the full text before and after.
3. The event details modal shows a diff for both: changed sections with a few
   lines of context, expand controls to reveal more, and word-level
   highlighting within changed lines.
4. Any event authored by a bot shows a robot icon before its title.
5. Bot description edits appear in feeds but are never unread, never notify,
   and never raise attention signals, unless the user explicitly marks one
   unread.
6. The details modal's action buttons move from the footer into the header
   area, for every event type.
7. The Jira poller stops re-fetching the full changelog and all comments for
   issues that have not changed since the last poll.

## Non-goals

- **No backfill.** Description events that already exist get no stored text
  and show "Diff not available for this edit." No extra polling or one-time
  migration to recover old edits. (Mike may later ask for a one-off manual fill
  of his own history; that is separate work, not part of this design.)
- No rendering of wiki markup or Markdown. Both are diffed as raw text.
- No change to how non-description bot events count as unread; only the robot
  icon is added for them.

## Anti-goals

- A diff that marks whole paragraphs changed because of a one-word edit, or
  every line changed because line endings flipped. Either makes the feature
  useless for the edits it exists for.
- Adding meaningful per-poll API cost to GitHub polling for PRs whose
  description has not changed.
- Event bodies or timeline payloads bloated with description text: the full
  text must not appear in the feed row, search, notifications, or the timeline
  list response.

## What we verified

**Jira** (RHOAIENG-79263, `GET /rest/api/3/issue/{key}/changelog`): every
`description` changelog item has `fromString`/`toString` holding the complete
description before and after, in Jira wiki markup (`h2. Problem`, `_italic_`,
`* bullet`). `from`/`to` are null; there is no ADF. Each edit's `fromString`
equals the previous edit's `toString` (253 → 288 → 333 → 2899 → 2908 chars);
no truncation at ~2.9 KB. The first edit has an empty `fromString` (the
description was added). The poller already reads these into
`ChangelogEntry.From`/`.To` (`~/git/watcher/jira/client.go`) and discards them
(`jira/poller.go`, `case "description"`, emits with a nil body).

**GitHub** (odh-dashboard #10571, #10557, #10538, GraphQL
`pullRequest.userContentEdits`): despite its name, each node's `diff` field is
the **complete body as of that version**, not a diff. Nodes come newest first.
The newest node equals the current `body`. The oldest node is the original
body, with `editedAt == pullRequest.createdAt` (GitHub records it once the
first edit happens; an never-edited PR has no nodes). Each node has `editedAt`
and `editor { __typename login }`; coderabbitai's `__typename` is `Bot`. Line
endings vary between versions: some use `\r\n`, some `\n`.
`pullRequest.lastEditedAt` gives the time of the latest edit.

**Diff rendering**: the UI already depends on `@pierre/diffs` 1.6.1 (used by
the Code tab via `ui/src/components/gitdiff/`). It provides
`parseDiffFromFile(oldFile, newFile)` to build a diff from two strings,
`lineDiffType` (`'word' | 'word-alt' | 'char' | …`) for intra-line
highlighting, collapsed context with expand controls, and a
`maxLineDiffLength` option that defaults to 1000 characters.

**Unread model**: own events (`selfid.NotMineSQL`) and in-progress CI
(`unread.NotPendingCISQL`) are excluded from unread entirely, and
`ErrNeverUnread` refuses marking them unread. Explicit marks live in
`event_read` (`NotMarkedReadSQL`, `MarkedUnreadSQL`), and unread is
`((past cursor AND not marked read) OR marked unread) AND not mine AND not
pending CI` (`internal/unread/unread.go`, `internal/webui/timeline.go`).

## Design

This is cross-repo work (see the repo CLAUDE.md "Watcher library"): watcher
changes first, released and tagged, then re-pinned here. The library is also
consumed by agent-handler; every library change must stay correct there.
Order: watcher (sections 1–3a) → worktree (sections 4–5) → agent-handler
(section 6, last).

### 1. Watcher library: storing the text

Store before/after text outside `watcher_events.body`, in a new table keyed by
event id, roughly:

```
watcher_event_text_change (
  event_id TEXT PRIMARY KEY REFERENCES watcher_events(id) ON DELETE CASCADE,
  old_text TEXT NOT NULL,   -- '' when there was none (description added)
  new_text TEXT NOT NULL    -- '' when cleared
)
```

*(My call: a side table rather than columns on `watcher_events`, so every
existing timeline query stays the same width and the text is only read on
demand.)* Written in the same transaction as the event insert. A read function
(`db.EventTextChange(conn, eventID)`) returns it, or "none" for events without
a row. This is a schema change: follow the library's migration and
schema-versioning conventions. Exact naming is left to the builder.

Store the text exactly as received; normalization happens at display time
(section 5). Exception: if the old and new texts are identical after
normalizing `\r\n` to `\n`, emit **no event** (an edit that only flipped line
endings has nothing to show). *(My call.)*

### 2. Watcher library: Jira

- In `processIssue`'s `case "description"`, write the text-change row with
  `entry.From` / `entry.To`. Title, dedup and author handling stay as they are.
- **Skip unchanged issues.** `FetchIssue` currently always pages through the
  whole changelog and all comments. Change the poll so it fetches the issue's
  fields first and compares `updated` with the `resource_updated_at` saved by
  the previous successful poll (`db.UpsertResourceState(..., issueData.UpdatedAt,
  ...)`). When they match, skip the changelog and comment fetches and the event
  processing, but still rewrite the cached state (fields and ranks may be
  needed fresh; the fields request was made anyway). Always do the full fetch
  when there is no saved state, on the first poll (empty cursor, including
  backfill), and after a failed poll (state is only written on success, so this
  holds as long as that stays true). The builder should confirm against a real
  issue that adding, editing and deleting a comment, and a changelog-producing
  edit, each move `updated`; if any does not, fall back to the full fetch for
  that case rather than missing events.
- Epic-link discovery runs inside `processIssue`; it must keep running for
  skipped issues, or move ahead of the skip. *(My call.)*
- agent-handler also runs this poller; the skip must be correct for it too.

### 3. Watcher library: GitHub `pr_description_changed`

- New event type `pr_description_changed` (source `github`), title
  `"<owner>/<repo>#<n> description changed"`, matching the Jira title's shape.
  No body.
- **Detecting edits cheaply.** Add `lastEditedAt` to the existing batched PR
  query (`buildBatchedPRQuery`). Keep the last value processed in the PR's
  cached state. Only when it is newer, run a separate per-PR query for
  `userContentEdits` (newest first, paged) until it reaches a node at or older
  than the event cursor, plus one more node to serve as the "before" text of
  the oldest new edit. PRs whose description did not change cost nothing
  beyond one extra scalar field.
- **Emitting.** For each node newer than the cursor, except the oldest node of
  the whole history (the original body, not an edit): emit one event with
  `external_ts = editedAt`, author = editor login, `author_type` from the
  editor's `__typename` (existing `authorType()`), `author_id` = the editor's
  `databaseId` (so the user's own edits are excluded via `selfid`, as for every
  other GitHub event). Old text = the next older node's `diff`; new text = this
  node's `diff`. Dedup on `(type, external_ts)` like the other GitHub events.
- **No past edits.** The existing cursor rules already prevent this: the first
  poll of a newly followed PR emits only `watch_started`, and edits at or
  before the cursor are skipped. A PR already followed when this ships starts
  emitting from its current cursor, so edits made between its last event and
  the upgrade may appear once. That is acceptable.
- The builder decides how many nodes to request per page and how to handle a
  deleted editor account (`editor` null: author empty, `author_type` "user").
- If the per-PR edit query fails, the saved `lastEditedAt` is not advanced, so
  the next poll retries. *(My call.)*
- A revision whose `diff` is null (history entry deleted) gets no text row; its
  event, or the event it would have been the "before" of, shows "Diff not
  available for this edit." *(My call.)*

### 3a. Watcher library: dropping bot description edits on request

Add a poller option that makes the library **not emit** description-change
events authored by bots (`author_type = "bot"`): `pr_description_changed`, and
for consistency `jira_description_changed` from `jira.bot_usernames` accounts
*(my call)*. Off by default, so existing consumers' behavior only changes when
they opt in. worktree leaves it **off**: it wants these events in its feeds and
handles them with the unread rules in section 4. agent-handler turns it **on**
(section 6). How the option is passed (a field on an options/config struct, a
new `Poll` variant) is the builder's call; it must not break the existing
`Poll` signatures for current callers.

### 4. worktree backend

- Re-pin the watcher release. Follow "Config files ↔ Settings modal" if the
  re-pin changes config structs (it should not).
- **Timeline DTO** gets `author_type` (`"user"`, `"bot"`, or empty) on every
  event, read from `watcher_events.author_type`.
- **Text endpoint**: `GET /api/event-text-change?id=<event id>` returns
  `{old_text, new_text}`, or 404 when the event has no stored text. Reads the
  DB only; it contacts no service, so it does not need a watcher-toggle gate.
  Follow the existing API conventions (auth, JSON shape, `schema_version` if it
  is also exposed through the CLI). Whether a CLI read command is added is the
  builder's call; if one is, classify it for the agent skill as the repo
  CLAUDE.md requires.
- **Bot description edits are never unread unless marked.** Add a condition
  alongside `NotPendingCISQL`, e.g. `NotBotDescriptionEditSQL` =
  "not (`author_type = 'bot'` and type in (`jira_description_changed`,
  `pr_description_changed`))", plus its Go twin. Unlike the own-event and
  pending-CI rules, it applies **only to the cursor branch**:

  ```
  ((past cursor AND not marked read AND not bot description edit) OR marked unread)
  AND not mine AND not pending CI
  ```

  so an explicit "Mark unread" still works. `ErrNeverUnread` must **not**
  refuse these events, and the modal must offer "Mark unread" for them. Apply
  it everywhere the unread condition is assembled: `internal/unread`
  (counts, summaries, per-event flags), `internal/webui/timeline.go`
  (unread-only filter), `internal/webui/unread.go` (the Go twins), the app
  unread total used by the menu bar app, and anything else that assembles the
  same condition. When a bot description edit has been marked unread and then
  "Mark all read" moves the cursor, the existing rule that a cursor move clears
  unread marks at or before it applies unchanged.
- **Notifications**: bot description edits never notify, marked or not
  (`notify_scan.go`). Human `pr_description_changed` events notify under the
  same rules and toggles as `jira_description_changed` do today.
- **Attention**: bot description edits never contribute to any attention
  signal. `pr_description_changed` from a human gets the same attention
  treatment as `jira_description_changed` (today: none, unless the builder
  finds otherwise; do not add a new signal).
- Jira events from accounts listed in `jira.bot_usernames` already get
  `author_type = "bot"`, so the bot rule covers Jira description edits too.
  The list is empty today, so this changes nothing yet.

### 5. worktree frontend

**Diff in the details modal** (`EventDetailsModal.tsx`): for
`jira_description_changed` and `pr_description_changed`, fetch the text on
open (react-query, keyed by event id) and render it in place of the plain body:

- Build the diff with `@pierre/diffs` from the two strings, reusing the Code
  tab's rendering components and styling where they fit
  (`ui/src/components/gitdiff/`) rather than a second diff renderer.
- Normalize `\r\n` → `\n` on both sides before diffing.
- Show changed hunks with a few lines of context and expand controls for the
  rest (the library's collapsed-context behavior, as in the Code tab). Unified
  view only *(my call: the modal is too narrow for split)*.
- Word-level intra-line highlighting (`lineDiffType: 'word'` or `'word-alt'`,
  builder's choice after seeing both). Raise `maxLineDiffLength` well above
  1000 (descriptions often have single-line paragraphs longer than that), with
  a cap the builder chooses so a pathological line cannot hang the modal.
- No syntax highlighting; plain text. *(My call.)*
- An empty old text (description added) or new text (description cleared)
  renders as all additions / all deletions.
- Loading state while fetching; on 404, a one-line "Diff not available for this
  edit." On other errors, an inline error. The modal must work with the rest
  of its content while the diff loads.

**Modal action buttons move up** (all event types). Today "Go to comment in
diff view", "Mark read" / "Mark unread" and "Make task" sit in a right-aligned
group at the bottom of the modal body. Move that group onto the worktree-chip
row, right-aligned, so it sits directly under the resource row's
`ResourceActions` ("Open in Jira/GitHub", cmux, etc.). Worktree chips stay on
the left and wrap as they do now. When the event has no worktree row (e.g.
archived resource), the button group gets a row of its own in the same
position, right-aligned. Approved mockup:
`.superpowers/brainstorm/30785-1793999503/content/modal-header.html`.
Button set, conditions and behavior are unchanged; only placement moves.
Narrow / full-screen layout: the builder makes the row wrap sensibly (buttons
drop below the chips rather than overflowing).

**Robot icon.** When `author_type === "bot"`, prefix the title with a small
robot icon everywhere the UI renders an event's title: `EventRow` (feed rows,
including the mini view), `EventDetailsModal`, and the task modal's
linked-event and activity lists. Applies to every event type. In the web UI
this is an **icon component, never an emoji**: Tabler `IconRobot`, sized to
the title text, wrapped in a Mantine `Tooltip` (e.g. "Bot" or "From a bot",
builder's wording) and carrying an accessible label.

**Robot emoji in notifications.** Notifications delivered outside the web UI
(Telegram and macOS, from `internal/webui`'s notifier) prefix the event title
with the 🤖 emoji when the event's author is a bot, for every event type that
notifies. (Bot description edits never notify, per section 4, so in practice
this shows on things like coderabbitai reviews.) If a delivery batches several
events under one headline, prefix each bot event's line rather than the
headline; the builder decides the exact placement within the existing message
format.

**Event type plumbing.** Add `pr_description_changed` to `lib/eventMeta.tsx`
(same look as `jira_description_changed`), to the "Edits" group in
`lib/eventTypeFilter.ts`, and anywhere else event types are enumerated
(search suggestions, notification type toggles if per-type), so it is
filterable and labeled like its Jira counterpart.

### 6. agent-handler adoption (last, separately)

agent-handler (`~/git/agent-handler`) pins an old watcher release and has not
been re-pinned in a while, so it receives none of these changes until it is
upgraded. Deferring it is safe.

Do this as the **final phase of the plan**, after the watcher release and the
worktree work are done and verified, because the upgrade may surface unrelated
breakage from the versions it skips:

1. Re-pin watcher in agent-handler to the new release; get its build and tests
   green, fixing whatever the skipped versions require. If that turns into
   substantial work unrelated to this feature, stop and check in with Mike
   before continuing.
2. Turn on the drop-bot-description-edits option (section 3a).
3. Add `pr_description_changed` to the PR event-type list in
   `cmd/statusline.go`'s `prUnread` (around line 892) and anywhere else handler
   enumerates PR event types, so human description edits count as PR activity.

## Testing expectations

- Library: Jira description event writes the text row; unchanged-issue skip
  (fields-only request when `updated` matches; full fetch when it moves, on
  first poll, and with no saved state); GitHub edit detection only when
  `lastEditedAt` moves; correct before/after pairing across pages; original
  body never emitted as an edit; line-ending-only edits emit nothing; bot
  `author_type`; the drop-bot-edits option suppresses bot description events
  when on and changes nothing when off. Use synthetic fixtures, no real issue
  or PR content.
- worktree: unread counts/flags/timeline filter exclude bot description edits
  unless marked unread; marking one unread works and is not refused; bot
  description edits never notify; `author_type` in the DTO; text endpoint 200 /
  404. New `internal/webui` tests follow the parallel-test rules in the repo
  CLAUDE.md.
- UI: modal renders a diff, the 404 fallback and loading state; buttons render
  in the header row, with and without worktree chips; robot icon (with tooltip)
  appears for bot events only.
- Notifications: bot events' titles carry the 🤖 prefix; others do not.

## Left to the builder

Table and function names; migration mechanics; GraphQL paging sizes; where the
"last processed `lastEditedAt`" is kept in cached state; exact
`lineDiffType` and line-length cap; whether to add a CLI command for the text;
component structure for the diff and the header row; responsive wrapping.
