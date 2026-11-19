# Slack Thread Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Following a Slack thread records its earlier replies as `slack_reply` events dated at send time, so search finds them.

**Architecture:** The watcher library's Slack poller already branches on the per-subscription `backfill` flag (`db.BackfillFor`); fix that branch (send-time `ts`, keep `watch_started`) and export it as a function. worktree turns the flag on for Slack subscriptions. Already-followed threads are caught up once by a throwaway program.

**Tech Stack:** Go, SQLite, `github.com/mturley/watcher` (local `~/git/watcher`, worked on directly on `main`).

**Spec:** `docs/superpowers/specs/2026-11-19-slack-thread-backfill-design.md`

## Global Constraints

- Backfill limited to the ≤200 messages `conversations.replies` returns; no paging.
- `external_ts` stays the verbatim Slack ts (unread compares it to `last_read`; `unread.SlackNewerSQL`).
- Backfilled `ts` = Slack ts seconds → `time.Unix(sec,0).UTC().Format(time.RFC3339)`; unparseable → wall clock.
- Live replies (cursor non-empty) keep wall-clock `ts`: the notifier reads `ts >= cursor − 30s`, so a send-time stamp minutes old would never notify.
- No upgrade migration or shipped catch-up code; agent-handler behavior unchanged (it never sets the flag).
- Slack test fixtures synthetic only.
- worktree commits use `--signoff`; pushing the watcher release requires asking Mike first.

## Review Focus

- A thread with only a root and backfill on: exactly one `watch_started`, and the next poll emits nothing (no re-fire). → Task 1 test `TestPoll_BackfillRootOnly`.
- Running `BackfillThread` on a thread whose later replies were already recorded live: only the missing older replies are added, no duplicates. → Task 1 test `TestBackfillThread_FillsOnlyMissing`.
- A reply with a malformed ts (`"abc"`) still gets an event, stamped wall clock. → Task 1 test `TestSlackSendTime`.
- Backfilled replies carry `author_id`, so the user's own messages stay out of unread (`selfid.NotMineSQL`). → asserted in `TestPoll_BackfillDatesRepliesAtSendTime`.
- A live reply arriving after a backfill is wall-clock dated. → asserted in `TestPoll_BackfillDatesRepliesAtSendTime`.

---

### Task 1: Library — dated Slack backfill + exported `BackfillThread` (in `~/git/watcher`)

**Files:**
- Modify: `slack/poller.go` (`processThread`, `emitEvent`; add `slackSendTime`, `BackfillThread`)
- Test: `slack/poller_test.go` (existing `fakeClient`, `pollOnce`, `slackResource`, `testutil.NewTestDB`)

**Interfaces:**
- Produces: `func BackfillThread(conn *sql.DB, client Client, resource watcher.Resource, logger *log.Logger) (int, error)` — fetches the thread, emits a send-time-dated `slack_reply` for every reply (not the root) not already recorded (dedup via `db.IsDuplicate` on `external_ts`), regardless of cursor; never emits `watch_started`; returns the count emitted. Errors on a bad resource id or a `Replies` failure.
- Produces (unexported): `func slackSendTime(ts string) string` — RFC3339 UTC of the ts's integer seconds; `""` if unparseable.

- [ ] **Step 1: Write failing tests** in `slack/poller_test.go`:
  - `TestSlackSendTime`: `slackSendTime("1699000000.000100") == "2023-11-03T08:26:40Z"`; `slackSendTime("abc") == ""`; `slackSendTime("") == ""`.
  - `TestPoll_BackfillDatesRepliesAtSendTime`: subscribe with `db.SubscribeOpts{Backfill: true}`; thread = root `1699000000.000100` + replies `1699000100.000200` (U2) and `1699000200.000300` (U1). `pollOnce` → exactly 1 `watch_started` and 2 `slack_reply` rows; reply rows' `ts` are `2023-11-03T08:28:20Z` / `2023-11-03T08:30:00Z`, `external_ts` verbatim, `author_id` `U2`/`U1`; `watch_started` `ts` within 1 minute of now. Then append reply `1699000300.000400` and poll again → one new `slack_reply` whose `ts` is within 1 minute of now (not 2023).
  - `TestPoll_BackfillRootOnly`: backfill subscription, root-only thread; poll twice → total 1 `watch_started`, 0 `slack_reply`.
  - `TestBackfillThread_FillsOnlyMissing`: plain subscription; thread root + one reply; `pollOnce` (watch_started only); then add a reply and poll (records it live); then thread has 3 replies total (one older added before them) — call `BackfillThread` → returns the count of replies not yet recorded (2), and a second call returns 0; no `watch_started` beyond the first.

- [ ] **Step 2: Run** `cd ~/git/watcher && go test ./slack/ -run 'SlackSendTime|Backfill'` — expect FAIL (undefined `slackSendTime`/`BackfillThread`, backfill emits no `watch_started`, ts is now).

- [ ] **Step 3: Implement.** `emitEvent` takes the `ts` to stamp (callers pass `""` for wall clock). In `processThread`: when `cursor == ""` emit `watch_started` as today; if `!backfill` return, else fall through and emit every reply via a shared reply-emitting helper that, when backfilling, stamps `slackSendTime(m.TS)` (falling back to wall clock on `""`). Live replies pass wall clock. `BackfillThread` parses the id (`parseResourceID`), calls `client.Replies(context.Background(), …)`, `resolveAuthors`, builds the mention resolver over the root + all replies, and uses the same helper with send-time stamping. Update `processThread`'s doc comment to describe both modes.

- [ ] **Step 4: Run** `go test ./...` in `~/git/watcher` — expect PASS (including the existing `TestPoll_FirstPollWatchStartedOnly`).

- [ ] **Step 5: Commit** on `main`:
```bash
git add slack/poller.go slack/poller_test.go
git commit --signoff -m "feat(slack): date backfilled replies at send time; export BackfillThread"
```

- [ ] **Step 6: Release.** Tag `v0.28.0`. **Ask Mike** before `git push origin main && git push origin v0.28.0`.

### Task 2: worktree — follow Slack threads with backfill

**Files:**
- Modify: `go.mod`, `go.sum` (re-pin), `internal/resources/resources.go` (`Add`), `docs/web-ui-architecture.md` ("Polling model", ~line 2663)
- Test: `internal/resources/resources_test.go`

**Interfaces:**
- Consumes: watcher `v0.28.0`.

- [ ] **Step 1: Re-pin:** `go get github.com/mturley/watcher@v0.28.0 && go mod tidy && go build ./...`.

- [ ] **Step 2: Write failing test** `TestAddRequestsBackfillOnlyForSlack`: `Add` a `slack` resource `C1:1.2` and a `pr` resource `o/r#1` to one worktree path; `watcherdb.BackfillFor(conn, "slack", "C1:1.2")` is `true`, `BackfillFor(conn, "pr", "o/r#1")` is `false`. Run `go test ./internal/resources/ -run Backfill` → FAIL.

- [ ] **Step 3: Implement:** in `Add`, pass `watcherdb.SubscribeOpts{Backfill: r.Type == "slack"}` with a one-line comment on why (search over pre-follow replies; Slack unread mirrors `last_read`, so backfilled replies read correctly).

- [ ] **Step 4: Docs:** in "Polling model", one short paragraph: following a Slack thread backfills its replies (≤200), dated at send time with `watch_started` at follow time; later replies are wall-clock dated for the notifier; PRs/Jira don't backfill.

- [ ] **Step 5: Run** `make test` (webui tests may need `go test -timeout 40m ./internal/webui/`) — expect PASS.

- [ ] **Step 6: Commit:**
```bash
git add go.mod go.sum internal/resources/resources.go internal/resources/resources_test.go docs/web-ui-architecture.md docs/superpowers/specs/2026-11-19-slack-thread-backfill-design.md docs/superpowers/plans/2026-11-19-slack-thread-backfill.md
git commit --signoff -m "feat: backfill Slack thread history when following a thread"
```

### Task 3: Catch up already-followed threads (in-session, nothing committed)

- [ ] **Step 1:** After the branch is merged and installed (`NONINTERACTIVE=1 make install`), back up the DB: `cp ~/.local/share/worktree/worktree.db ~/tmp/worktree-db-before-slack-backfill.db`.
- [ ] **Step 2:** Write an untracked `hack/slack-backfill-catchup/main.go` in this checkout (inside the module so `internal/slackcreds` imports): open the DB via `internal/db`, build the client with `slackcreds.Client()`, select distinct `resource_id` from `watcher_subscriptions` where `resource_type='slack' AND subscriber LIKE 'worktree:%' AND deleted_at IS NULL`, call `slack.BackfillThread` for each, print id + count + errors.
- [ ] **Step 3:** Run `go run ./hack/slack-backfill-catchup`; verify with `sqlite3` that each thread's `slack_reply` count now matches its reply count (≤200) and that no `(resource, external_ts)` pair is duplicated. Spot-check search in the UI for a pre-follow message.
- [ ] **Step 4:** `rm -r hack/slack-backfill-catchup`.

### Task 4: Library — Slack events carry the full message text (added 2026-11-19 at Mike's request; runs before Task 3)

Approved in conversation: reply bodies become `Author: <full text>` (mentions resolved, newlines kept), `watch_started` body becomes the full resolved root text, titles and the cached thread title stay 60-rune. `BackfillThread` also rewrites a recorded reply's body when it differs (catches existing truncated bodies and edits). Event-details mrkdwn rendering is out of scope (revisit after the catch-up).

**Files:** Modify `~/git/watcher/slack/poller.go`, `~/git/watcher/db/dedup.go` (add `UpdateEventBody`); Test `slack/poller_test.go`, `db/dedup_test.go`.

**Interfaces:** Produces `func UpdateEventBody(conn *sql.DB, d DedupCheck, body string) (bool, error)` — sets `body` on every event matching `d` (same match as `IsDuplicate`) whose body differs; reports whether any row changed. `BackfillThread`'s count becomes emitted + updated.

- [ ] **Step 1: Failing tests:** `TestPoll_ReplyBodyIsFullText` (a 200-rune multi-line reply → body `Bob: ` + the exact text); `TestPoll_WatchStartedBodyIsFullRoot`; `TestBackfillThread_RewritesTruncatedBody` (seed a reply event with a truncated body, `BackfillThread` returns 1 and the body becomes full; second call returns 0); `TestUpdateEventBody` in db.
- [ ] **Step 2: Run** `go test ./slack/ ./db/` → FAIL.
- [ ] **Step 3: Implement.** A `replyBody(author, text)` helper; `emitReplies` in send-time (backfill) mode calls `UpdateEventBody` for a duplicate.
- [ ] **Step 4: Run** `go test ./...` in watcher → PASS. Commit, tag `v0.29.0` (ask Mike before pushing).
- [ ] **Step 5:** worktree: re-pin `v0.29.0`, update the "Polling model" doc paragraph (bodies hold the full text), `make test`, commit.
