# Description Diff Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jira and PR "description changed" events carry the full before/after text and the event modal shows a word-level diff; bot events get a robot marker; bot description edits never count as unread; modal actions move to the header; unchanged Jira issues skip the changelog/comment fetch.

**Architecture:** Three repos, in order. The watcher library (`~/git/watcher`) stores the text in a new side table written with the event, emits the new `pr_description_changed` event from GitHub's `userContentEdits`, and gets a drop-bot-edits option; released as `v0.23.0`. worktree (`~/git/worktree`) re-pins, exposes `author_type` and a text endpoint, adds the bot rule to unread, and renders the diff with `@pierre/diffs`. agent-handler (`~/git/agent-handler`) re-pins last and turns the option on.

**Tech Stack:** Go (SQLite via `database/sql`, GitHub GraphQL, Jira REST v3), React + Mantine + react-query, `@pierre/diffs` 1.6.1.

**Spec:** `docs/superpowers/specs/2026-11-06-description-diff-events-design.md` (in `~/git/worktree`). Read it before starting any task.

## Global Constraints

- Order: watcher Tasks 1–5 → worktree Tasks 6–10 → agent-handler Task 11. Never patch around a library limitation in worktree.
- Watcher release tag: `v0.23.0` (current latest is `v0.22.0`). Schema version goes from `6` to `7`.
- New event type string: `pr_description_changed`; display name `"description changes"` (same as Jira's).
- PR event title: `"<owner>/<repo>#<n> description changed"`. Jira title unchanged.
- Text is stored exactly as received; `\r\n`→`\n` normalization only for the "identical" check and for display.
- An edit whose old and new text are equal after normalization emits no event.
- worktree leaves the drop-bot option **off**; agent-handler turns it **on**.
- Web UI bot marker: Tabler `IconRobot` in a Mantine `Tooltip`, never an emoji. Notification text bot marker: `🤖 ` prefix.
- Diff: unified view, no syntax highlighting, word-level intra-line highlights, `maxLineDiffLength` raised from the 1000 default to `20000`.
- 404 fallback copy: `Diff not available for this edit.`
- Pushing commits or tags, merging to `main`, and force pushing need Mike's explicit approval every time (the plan's commit approval does not cover them).
- All commits use `--signoff`. Never `git add -A`/`.`.
- New `internal/webui` tests call `t.Parallel()` first unless they hit the serial cases in the repo CLAUDE.md "Writing Go tests".
- Test fixtures are synthetic: no real issue, PR, or person content.

## Review Focus

1. **A bot description edit the user marked unread, then "Mark all read".** Expect it to read as read afterwards (the existing cursor-move rule clears unread marks at or before the cursor) and not reappear as unread. Test: Task 7 `TestBotDescriptionEdit_MarkUnreadThenMarkAllRead`.
2. **A PR edited many times between polls, across a GraphQL page boundary.** Expect every new edit emitted once, each paired with its true predecessor, and the original body never emitted as an edit. Test: Task 4 `TestDescriptionEdits_PagesAndPairing`.
3. **A Jira issue commented on with no field change.** Expect `updated` to move and the comment event to arrive; if the skip compared the wrong timestamp the comment would be lost. Test: Task 3 `TestPoll_SkipsHistoryOnlyWhenUpdatedUnchanged` (the comment case).
4. **A very long single-paragraph description.** Expect word highlights still shown (line > 1000 chars) and the modal staying responsive. Test: Task 9 `renders word highlights on a 3000-char line`.
5. **The modal opened on an event with no worktree chips (archived resource) on a narrow screen.** Expect the action buttons on their own right-aligned row, not overflowing. Test: Task 10 `places actions on their own row without worktrees`.

---

## Part A: watcher library (`~/git/watcher`)

Work directly on `main` in `~/git/watcher` (Mike approved this). Run `go test ./...` there.

### Task 1: Store before/after text with an event

**Files:**
- Modify: `watcher.go` (Event struct; add `TextChange`, `SameText`)
- Modify: `db/schema.go` (`CurrentSchemaVersion`, version comment, `managedTables`, `managedColumns`, `schemaDDL`)
- Modify: `db/events.go` (`InsertEvent`, new `EventTextChange`)
- Test: `db/events_test.go`, `watcher_test.go` (create if absent), `db/migrate_test.go`

**Interfaces:**
- Produces:
  - `type TextChange struct { Old, New string }` in package `watcher`
  - `Event.TextChange *TextChange` (nil = no text stored)
  - `func SameText(a, b string) bool` — true when equal after replacing `"\r\n"` with `"\n"`
  - `func EventTextChange(conn *sql.DB, eventID string) (*watcher.TextChange, error)` in package `db` — `(nil, nil)` when the event has no row
  - Table `watcher_event_text_change(event_id TEXT PRIMARY KEY, old_text TEXT NOT NULL, new_text TEXT NOT NULL)` (no foreign key: the DB does not enable `foreign_keys`, and events are never deleted)

- [ ] **Step 1: Write failing tests**
  - `TestInsertEvent_WritesTextChange`: insert an event with `TextChange{Old: "a\nb", New: "a\nc"}`; `EventTextChange(conn, id)` returns exactly those strings.
  - `TestInsertEvent_NoTextChange`: event with nil `TextChange`; `EventTextChange` returns `nil, nil`; no row in `watcher_event_text_change`.
  - `TestSameText`: `SameText("a\r\nb", "a\nb") == true`, `SameText("a", "b") == false`, `SameText("", "") == true`.
  - `TestMigrate_V6ToV7AddsTextChangeTable`: a DB at v6 migrates to `7` and the table exists; follow the existing version-upgrade tests in `db/migrate_test.go`.
- [ ] **Step 2: Run** `go test ./... -run 'TextChange|SameText|V6ToV7'` — Expected: FAIL (undefined).
- [ ] **Step 3: Implement.** Bump `CurrentSchemaVersion` to `7` with a comment in the existing per-version style ("v7 adds watcher_event_text_change … purely additive"). Add the table to `schemaDDL`, `managedTables`, `managedColumns`. In `InsertEvent`, insert the text row inside the same transaction when `e.TextChange != nil`.
- [ ] **Step 4: Run** `go test ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): store before/after text for an event`.

### Task 2: Jira description text, no-op skip, drop-bot option

**Files:**
- Modify: `jira/poller.go` (`JiraAuth`, `emitEvent`, `case "description"`)
- Test: `jira/poller_test.go`

**Interfaces:**
- Consumes: Task 1 `watcher.TextChange`, `watcher.SameText`, `db.EventTextChange`.
- Produces: `JiraAuth.DropBotDescriptionEdits bool` (zero value keeps current behavior).

- [ ] **Step 1: Write failing tests** (use `processIssue` like the existing `TestProcessIssue_*` tests):
  - `TestProcessIssue_DescriptionStoresText`: changelog entry `{Field: "description", From: "old", To: "new"}` → one `jira_description_changed` event whose `EventTextChange` is `{Old: "old", New: "new"}`.
  - `TestProcessIssue_DescriptionAdded`: `From: ""`, `To: "x"` → event with `{Old: "", New: "x"}`.
  - `TestProcessIssue_DescriptionLineEndingsOnly`: `From: "a\r\nb"`, `To: "a\nb"` → no event.
  - `TestProcessIssue_DropBotDescriptionEdits`: author in `BotUsernames`; with `DropBotDescriptionEdits: true` → no event; with `false` → event with `author_type = "bot"`. A non-description bot event (e.g. status change) is still emitted with the option on.
- [ ] **Step 2: Run** `go test ./jira/ -run Description` — Expected: FAIL.
- [ ] **Step 3: Implement.** `processIssue` already receives `cfg JiraAuth`. Give `emitEvent` a trailing `tc *watcher.TextChange` parameter (nil at every other call site). In `case "description"`: skip when `SameText(entry.From, entry.To)`; skip when `cfg.DropBotDescriptionEdits` and the author type is `"bot"`; otherwise emit with `&watcher.TextChange{Old: entry.From, New: entry.To}`.
- [ ] **Step 4: Run** `go test ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(jira): keep description text on description-changed events`.

### Task 3: Skip changelog and comments for unchanged Jira issues

**Files:**
- Modify: `jira/client.go` (split `FetchIssue`)
- Modify: `jira/poller.go` (`Poll` loop)
- Test: `jira/client_test.go`, `jira/poller_test.go`

**Interfaces:**
- Produces:
  - `func (c *Client) FetchIssueFields(issueKey string, customFieldIDs map[string]string) (*IssueData, error)` — fields only, `Comments`/`Changelog` nil
  - `func (c *Client) FetchIssueHistory(issueKey string, issue *IssueData) error` — fills `issue.Comments` and `issue.Changelog` via the existing paginated fetchers
  - `FetchIssue` keeps its signature and becomes `FetchIssueFields` + `FetchIssueHistory`.

- [ ] **Step 1: Write failing tests** with an `httptest` server that counts hits per path (pattern in `jira/client_test.go`):
  - `TestPoll_SkipsHistoryOnlyWhenUpdatedUnchanged`, table-driven, two polls each:
    - `updated` unchanged between polls → second poll makes **no** `/changelog` or `/comment` requests, emits nothing, still rewrites resource state (`watcher_updated_at` moves).
    - `updated` moved and a new comment present (no changelog change) → second poll fetches history and emits the `jira_comment`.
    - `updated` moved with a new description changelog entry → emits it.
  - `TestPoll_FullFetchWithoutSavedState`: no `watcher_resource_state` row but non-empty cursor → full fetch.
  - `TestPoll_FullFetchOnFirstPoll`: empty cursor → full fetch (and `watch_started` as today).
  - `TestPoll_SkippedIssueStillLinksEpic`: epic custom field set, `updated` unchanged → the epic relationship is recorded.
- [ ] **Step 2: Run** `go test ./jira/ -run 'Poll_'` — Expected: FAIL.
- [ ] **Step 3: Implement.** In `Poll`, after `FetchIssueFields`: read `db.GetResourceState(conn, "jira", key)` and the cursor. Fetch history unless all hold: state exists, `state.ResourceUpdatedAt == issueData.UpdatedAt`, `issueData.UpdatedAt != ""`, cursor non-empty. When skipping, still call `processIssue` with the empty history: it links the epic and emits nothing, because the cursor is non-empty and the loops are empty. State is still upserted as today. A history fetch error is handled like today's fetch error.
- [ ] **Step 4: Run** `go test ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `perf(jira): skip changelog and comment fetches for unchanged issues`.

Already verified against real Jira (2026-11-06, read-only), so no live check is needed. Across 112 issues, `fields.updated` exactly equals the newest activity: a changelog entry, a comment's `created` (16 issues), or a comment edit's `updated` (4 issues). No comment is ever newer than the issue's `updated`. Comment deletion was not observable read-only, but it does not matter: the poller emits no event for deleted or edited comments.

### Task 4: GitHub `pr_description_changed`

**Files:**
- Modify: `eventtype.go` (constant + display name)
- Modify: `github/graphql.go` (`lastEditedAt` in `buildBatchedPRQuery`/`prNode`/`PRData`; new edits fetcher)
- Modify: `github/poller.go` (`PollOptions`, `PollWithOptions`, `processPRWith`, `buildPRStateJSON`)
- Test: `github/poller_test.go`, `github/graphql_test.go`

**Interfaces:**
- Consumes: Task 1 `TextChange`, `SameText`; existing `authorNode`, `authorType()`, `db.IsDuplicate`, `ghHTTP`.
- Produces:
  - `const EventTypePRDescChanged EventType = "pr_description_changed"`, display name `"description changes"`
  - `PRData.LastEditedAt string` (RFC3339; `""` if never edited)
  - `type PollOptions struct { DropBotDescriptionEdits bool }`
  - `func PollWithOptions(conn *sql.DB, token string, resources []watcher.Resource, logger *log.Logger, opts PollOptions) error`; `Poll` calls it with `PollOptions{}`
  - `type DescriptionEdit struct { EditedAt string; Body *string; Editor authorNode }` (unexported fields are fine)
  - `func fetchDescriptionEdits(h ghHTTP, token, owner, repo string, number int, stopAt string) ([]DescriptionEdit, error)`, newest first. It pages `userContentEdits(first: 50)` and stops after the page containing a node with `editedAt <= stopAt`, or at the last page.
  - PR cached state key `"description_edited_at"`: the `LastEditedAt` last processed successfully.

- [ ] **Step 1: Write failing tests** (httptest GraphQL server; follow `fetchRemainingCheckContexts` tests):
  - `TestDescriptionEdits_PagesAndPairing`: 5 versions V0(original)…V4 over two pages (page size forced small via the server), cursor between V1 and V2 → emits exactly 3 events (V2, V3, V4), each `TextChange{Old: V(i-1), New: V(i)}`, `external_ts = editedAt`, title `"o/r#1 description changed"`.
  - `TestDescriptionEdits_OriginalNeverEmitted`: backfill (cursor `""`) with V0..V2 → 2 events, none for V0.
  - `TestDescriptionEdits_OnlyWhenLastEditedAtMoves`: second poll with unchanged `lastEditedAt` makes no edits query.
  - `TestDescriptionEdits_FailureDoesNotAdvance`: edits query returns 500 → no events, state's `description_edited_at` unchanged; next poll retries.
  - `TestDescriptionEdits_LineEndingsOnly`: V1 differs from V0 only by `\r\n` → no event.
  - `TestDescriptionEdits_NullDiff`: predecessor `diff` null → event emitted with nil `TextChange`.
  - `TestDescriptionEdits_BotAuthor`: editor `__typename: "Bot"` → `author_type = "bot"`, `author_id` = databaseId; with `PollOptions{DropBotDescriptionEdits: true}` → no event, but `description_edited_at` still advances.
  - `TestDescriptionEdits_Dedup`: re-running the same poll emits nothing new.
- [ ] **Step 2: Run** `go test ./github/ -run DescriptionEdits` — Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Query: `userContentEdits(first:50, after:$after){pageInfo{hasNextPage endCursor} nodes{editedAt diff editor{__typename login ... on User{databaseId} ... on Bot{databaseId}}}}`. Use `h` (the poll's logged HTTP client) the way `fetchRemainingCheckContexts` does.
  - In `processPRWith`, after the cursor/first-poll early return: when `prData.LastEditedAt > prev["description_edited_at"]`, fetch edits with `stopAt = cursor`. For each index `i` with `edits[i].EditedAt > cursor` and an `edits[i+1]`: skip if `SameText`, skip if the option is set and the editor is a bot, skip if duplicate (`IsDuplicate` on type + `external_ts`), otherwise emit. Use `TextChange{Old: *edits[i+1].Body, New: *edits[i].Body}` only when both are non-nil. A null editor gives an empty author and `author_type` "user". The last node never gets an event, because it has no predecessor. On fetch error, log it and keep the previous `description_edited_at`.
  - `buildPRStateJSON(prData, mergeable, descriptionEditedAt string)` writes `"description_edited_at"`.
  - Thread `opts PollOptions` through `pollWith` → `processPRWith`; `processPR` passes `PollOptions{}`.
- [ ] **Step 4: Run** `go test ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(github): emit pr_description_changed with before/after text`.

### Task 5: Document and release `v0.23.0`

**Files:**
- Modify: `docs/superpowers/specs/2026-07-31-watcher-library-design.md`: add the `pr_description_changed` row next to `jira_description_changed` (line ~248); document `watcher_event_text_change`, the `description_edited_at` state key, `PollOptions`/`JiraAuth.DropBotDescriptionEdits`, and the Jira skip-unchanged rule.

- [ ] **Step 1:** Update the doc; run `go vet ./... && go test ./...` — Expected: PASS.
- [ ] **Step 2: Commit** `docs: description text, pr_description_changed, drop-bot option`.
- [ ] **Step 3:** Tag `v0.23.0` on `main`. **Ask Mike before pushing.** After approval: `git push origin main && git push origin v0.23.0`.

---

## Part B: worktree (`~/git/worktree`)

Work on a feature branch. Backend: `make test`. Frontend: the `ui/package.json` scripts (look there before running vitest/eslint directly).

### Task 6: Re-pin; `author_type` in the timeline; text endpoint

**Files:**
- Modify: `go.mod`/`go.sum` (`go get github.com/mturley/watcher@v0.23.0 && go mod tidy`)
- Modify: `internal/webui/timeline.go` (`TimelineEvent.AuthorType`, select `COALESCE(e.author_type,'')` beside `e.author` ~line 297)
- Create: `internal/webui/event_text_api.go`; register `{"GET /api/event-text-change", s.handleEventTextChange}` in `internal/webui/server.go`'s route table
- Modify: `.claude/CLAUDE.md` (watcher version floor note where `attention` mentions "Needs watcher >= v0.22.0": add `v0.23.0` for description text)
- Test: `internal/webui/timeline_test.go`, `internal/webui/event_text_api_test.go`

**Interfaces:**
- Consumes: `wdb.EventTextChange` (Task 1).
- Produces:
  - JSON `author_type` on every timeline event (`"user"`, `"bot"`, or omitted when empty).
  - `GET /api/event-text-change?id=<id>` → `200 {"old_text": string, "new_text": string}`; `404` when no row; `400` when `id` missing. No CLI command.
  - `func (s *Server) EventTextChange(id string) (*watcher.TextChange, error)` (handler calls it).

- [ ] **Step 1: Write failing tests:** `TestTimeline_AuthorType` (a bot event gives `author_type: "bot"`); `TestEventTextChange_OK`, `_NotFound`, `_MissingID`, `_RequiresSession` (follow existing auth test helpers). `t.Parallel()` first.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run 'AuthorType|EventTextChange'` — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. Run `settings_keys_test.go`, since the re-pin must not change config structs; if it does, follow "Config files ↔ Settings modal".
- [ ] **Step 4: Run** `make test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(webui): author_type on events and description text endpoint`.

### Task 7: Bot description edits are never unread unless marked; notifications

**Files:**
- Modify: `internal/unread/unread.go` (new SQL const + Go twin; `Summaries` and every cursor-branch query)
- Modify: `internal/unread/event_read.go` (`LoadEvent`'s struct gains `AuthorType`)
- Modify: `internal/webui/timeline.go` (unread-only filter ~line 220-235), `internal/webui/unread.go` (`IsUnread`), its callers in `timeline.go`, `pr_comments_api.go`, `event_read.go`
- Modify: `internal/webui/notify_scan.go` (`readNewEvents`)
- Test: `internal/unread/unread_test.go`, `internal/webui/unread_test.go`, `internal/webui/notify_scan_test.go`

**Interfaces:**
- Produces:
  - `const NotBotDescriptionEditSQL = "NOT (COALESCE(e.author_type,'') = 'bot' AND e.type IN ('jira_description_changed','pr_description_changed'))"` in `internal/unread`
  - `func IsBotDescriptionEdit(eventType, authorType string) bool`
  - `(*unreadIndex).IsUnread(eventID, resType, id, ts, externalTS, eventType, source, authorID, authorType string) bool` (new trailing param)
- Rule (verbatim from spec): `((past cursor AND not marked read AND not bot description edit) OR marked unread) AND not mine AND not pending CI`. `canMarkUnread` is unchanged, so bot edits stay markable.

- [ ] **Step 1: Write failing tests:**
  - `TestSummaries_BotDescriptionEditNotCounted`: a bot `pr_description_changed` past the cursor → count 0; a human one → 1; a bot `pr_review` → 1 (other bot events unaffected).
  - `TestSummaries_BotDescriptionEditMarkedUnread`: same bot event with an unread mark → count 1.
  - `TestBotDescriptionEdit_MarkUnreadThenMarkAllRead`: mark unread, then move the cursor past it → count 0.
  - `TestIsUnread_BotDescriptionEdit` (Go twin agrees with SQL for the four combinations bot/human × marked/unmarked).
  - `TestMarkEventUnread_BotDescriptionEditAllowed`: `MarkEventUnread` succeeds (no `ErrNeverUnread`), and timeline `can_mark_unread` is true.
  - `TestTimeline_UnreadOnlyExcludesBotDescriptionEdit`.
  - `TestReadNewEvents_SkipsBotDescriptionEdits` (even when marked unread) and `TestReadNewEvents_BotTitlePrefixed`: a bot `pr_review` comes back with title `"🤖 " + title`; a human one is unchanged.
- [ ] **Step 2: Run** the new tests — Expected: FAIL.
- [ ] **Step 3: Implement.** Put `NotBotDescriptionEditSQL` inside the cursor branch of every condition that already combines `last_read_ts` with `MarkedUnreadSQL`: `unread.Summaries`, the timeline unread-only filter, and any other the builder finds with `grep -rn MarkedUnreadSQL internal`. Slack queries are untouched: Slack events are never description edits. In `IsUnread`, compute `pastCursor && !unread.IsBotDescriptionEdit(eventType, authorType)` before `EventUnread`. In `readNewEvents`, select `COALESCE(e.author_type,'')`, add `AND ` + `unread.NotBotDescriptionEditSQL` to the WHERE, and prefix `"🤖 "` to `title` for bot rows. Attention needs no change: it reads unread events through `Timeline`.
- [ ] **Step 4: Run** `make test` and `go test -race ./internal/webui/` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(unread): bot description edits only unread when marked; 🤖 in notifications`.

### Task 8: Event type plumbing and the robot icon

**Files:**
- Modify: `ui/src/api/types.ts` (`TimelineEvent.author_type?: string`)
- Create: `ui/src/components/BotMark.tsx`
- Modify: `ui/src/components/EventRow.tsx` (~line 200), `ui/src/components/EventDetailsModal.tsx` (title ~line 179), `ui/src/components/tasks/modal/LinkedEventsSection.tsx`, `ui/src/components/tasks/modal/ActivityTab.tsx`
- Modify: `ui/src/lib/eventMeta.tsx` (`pr_description_changed`: same entry as `jira_description_changed`), `ui/src/lib/eventTypeFilter.ts` ("Edits" group), `ui/src/components/search/suggestions.ts` if it enumerates types
- Test: `ui/src/components/BotMark.test.tsx`, `ui/src/components/EventRow.test.tsx`

**Interfaces:**
- Produces: `export function BotMark({ authorType, author }: { authorType?: string; author?: string }): JSX.Element | null`. It renders `IconRobot` (size matching the adjacent title text) inside `Tooltip label={author ? `From a bot: ${author}` : "From a bot"}` with `aria-label="Bot"`, and nothing unless `authorType === "bot"`.

- [ ] **Step 1: Write failing tests:** `BotMark` renders an element labelled "Bot" for `"bot"` and nothing for `"user"`/undefined; the tooltip text appears on hover; `EventRow` shows the mark for a bot event and not for a user event; `eventTypeFilter` "Edits" includes `pr_description_changed`.
- [ ] **Step 2: Run** the UI test script for these files — Expected: FAIL.
- [ ] **Step 3: Implement**; place `<BotMark>` immediately before the title text in each listed component.
- [ ] **Step 4: Run** UI tests and lint/typecheck scripts — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): robot mark on bot events; pr_description_changed type`.

### Task 9: Diff in the event modal

**Files:**
- Create: `ui/src/components/DescriptionDiff.tsx` (default export, lazy-loaded so `@pierre/diffs` stays out of the main chunk, like `DiffView` in `WorktreeDetailPage.tsx:70`)
- Modify: `ui/src/api/client.ts` (`eventTextChange`), `ui/src/api/types.ts` (`EventTextChange`)
- Modify: `ui/src/components/EventDetailsModal.tsx` (replace the plain body for the two types)
- Test: `ui/src/components/DescriptionDiff.test.tsx`, `ui/src/components/EventDetailsModal.test.tsx`

**Interfaces:**
- Consumes: Task 6 endpoint.
- Produces:
  - `api.eventTextChange(id: string): Promise<EventTextChange>` with `interface EventTextChange { old_text: string; new_text: string }`; a 404 surfaces as `HttpError` with status 404.
  - `DescriptionDiff({ oldText, newText, cacheKey }: { oldText: string; newText: string; cacheKey: string })`.
  - `DESCRIPTION_DIFF_TYPES = ["jira_description_changed", "pr_description_changed"]`.

- [ ] **Step 1: Write failing tests:**
  - `DescriptionDiff`: normalizes `\r\n` (a CRLF-only difference renders no changed lines); `renders word highlights on a 3000-char line` (asserts the options passed include `lineDiffType: "word"` and `maxLineDiffLength: 20000`, since pierre renders in shadow DOM; follow how `DiffView.test.tsx` inspects pierre); old `""` renders as all additions.
  - `EventDetailsModal`: for a description event it requests `/api/event-text-change?id=…` and shows the diff; on 404 shows `Diff not available for this edit.`; other errors show an inline error; while loading, the header and actions are already rendered; other event types still render `e.body` and never call the endpoint.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Build the metadata with `parseDiffFromFile({name: "description", contents: old, cacheKey: cacheKey+":old"}, {name: "description", contents: new, cacheKey: cacheKey+":new"})` after normalizing line endings. Render with pierre's React `FileDiff` with options `{ diffStyle: "unified", themeType: "dark", lineDiffType: "word", maxLineDiffLength: 20000, disableFileHeader: true }`. Keep the library's default collapsed context and `expandUnchanged` so the expand controls work; check the option names against `node_modules/@pierre/diffs/dist/types.d.ts`. Use plain text, with no language highlighter (no worker pool needed if pierre allows it; otherwise copy the `WorkerPoolContextProvider` setup from `DiffBody.tsx`). Query key `["event-text-change", e.id]`, `retry: false` on 404.
- [ ] **Step 4: Run** tests + typecheck — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): show description diffs in the event modal`.

### Task 10: Move modal actions to the header row

**Files:**
- Modify: `ui/src/components/EventDetailsModal.tsx` (move the button `Group` from ~line 192 to the worktree-chip row ~line 150)
- Modify: `docs/web-ui-architecture.md` (event details modal: action placement, description diff, `author_type`, bot unread rule, `/api/event-text-change`)
- Test: `ui/src/components/EventDetailsModal.test.tsx`

**Interfaces:** none new; extract the button group into a local `EventActions` component so it can render in either row.

- [ ] **Step 1: Write failing tests:** `places actions on the worktree row`: the buttons are inside the same row element as the worktree chips, and no button follows the body. `places actions on their own row without worktrees`: an archived event with no worktrees still shows the buttons, right-aligned, above the divider. Existing modal tests keep passing unchanged (same buttons, same conditions).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Row: `Group justify="space-between" wrap="wrap" align="flex-start"`. Chips on the left; actions `Group justify="flex-end" ml="auto"`, so on narrow widths they wrap below the chips. With no worktrees, render the actions row alone with `justify="flex-end"`. Remove the footer group. Match against the approved mockup `.superpowers/brainstorm/30785-1793999503/content/modal-header.html`.
- [ ] **Step 4: Run** UI tests, typecheck, lint, then `make build` — Expected: PASS.
- [ ] **Step 5: Manual check:** `NONINTERACTIVE=1 make install` (the UI restarts itself in ~5s). Open a Jira description event created after the upgrade and a bot PR description event. Confirm the diff, the expand controls, the robot tooltip, the header buttons, and that the bot edit doesn't show as unread until it's marked.
- [ ] **Step 6: Commit** `feat(ui): event modal actions in the header row`.

---

## Part C: agent-handler (`~/git/agent-handler`), last

### Task 11: Re-pin watcher and turn on the drop-bot option

**Files:**
- Modify: `go.mod`/`go.sum` (`v0.8.0` → `v0.23.0`)
- Modify: `cmd/watcher/run.go` (~line 104: `wgithub.PollWithOptions(..., wgithub.PollOptions{DropBotDescriptionEdits: true})`; ~line 121: `JiraAuth{..., DropBotDescriptionEdits: true}`)
- Modify: `cmd/statusline.go` (~line 887: add `watcherlib.EventTypePRDescChanged` to the `prUnread` case), plus any other PR event-type enumerations found by `grep -rn EventTypePRNewCommits`
- Test: existing handler tests; add `TestStatusline_PRDescriptionChangedCountsAsPR` beside the existing statusline tests

- [ ] **Step 1:** Re-pin, `go build ./... && go test ./...`. Fix whatever breaks. **Checkpoint:** if the fixes needed by the 15 skipped releases turn into substantial work unrelated to this feature, stop and report to Mike before continuing.
- [ ] **Step 2: Write the failing statusline test**; run — Expected: FAIL.
- [ ] **Step 3: Implement** the option wiring and statusline case.
- [ ] **Step 4: Run** `go test ./...` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: watcher v0.23.0; drop bot description edits`. Ask before pushing.
