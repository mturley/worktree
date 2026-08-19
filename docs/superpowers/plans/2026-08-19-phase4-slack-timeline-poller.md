# Phase 4 — Slack Timeline Poller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `slack` resource type + Slack thread poller to the `github.com/mturley/watcher` library so new Slack replies appear as events in worktree's timeline, and cache each thread's title for the Overview resource card. Released as watcher v0.3.0, consumed by worktree.

**Architecture:** Lift worktree's dependency-free `internal/slackapi` into a new `watcher/slack` library package, add a `Poll` there mirroring `github`/`jira` (fetch replies → emit one `slack_reply` event per new reply after the cursor → cache thread title in `resource_state`), release v0.3.0, then in worktree re-pin, rewrite `slackapi` imports to the library, add a `slack` branch to `pollAll`, and wire the cached title into the Overview card.

**Tech Stack:** Go (watcher library + worktree backend), SQLite, React/TS (worktree card).

**Spec:** `docs/superpowers/specs/2026-08-19-phase4-slack-timeline-poller-design.md`

## Global Constraints

- **Cross-repo protocol (CLAUDE.md "Watcher library"):** library changes land in `~/git/watcher` FIRST — change + `go test ./...` → commit → verify the COMMITTED tree builds+tests green in an ISOLATED detached worktree (`git worktree add --detach /tmp/... HEAD`) before tagging → tag `v0.3.0` → `git push origin main && git push origin v0.3.0`. Only then re-pin in worktree.
- **The library is also consumed by agent-handler** — all changes must be additive; do not break existing github/jira behavior or existing DB schema.
- **LOAD-BEARING INVARIANT (CC-3):** every Slack event's `ExternalTS` is the **raw Slack `ts` string** (e.g. `"1699123456.000200"`), NEVER converted to RFC3339. `db.EventCursor` uses `MAX(external_ts)` + string comparison; this works for Slack only because Slack ts are fixed-width, zero-padded, monotonic, and isolated under `source="slack"`. A test must assert stored `external_ts` == the Slack ts verbatim.
- **Resource identity:** `Type:"slack"`, `ID:"<channel>:<thread_ts>"`, `Source:"slack"` (both type and source are `"slack"`, unlike github where type=`"pr"`/source=`"github"`).
- **Event scope:** new replies only → one `slack_reply` event each. NO reactions, NO backfill-on-first-watch (watch_started-only gate, matching github/jira). Reserve `slack_reaction` for a later phase; do not add it.
- **Slack domain package moves WHOLE** (client + all domain types incl. Block/BlockKit) into `watcher/slack` — one canonical type set for the poller, worktree UI, and future agent-handler. Do not split the domain across repos.
- **Slack test fixtures MUST stay synthetic/sanitized** (no real Slack content/secrets) — they travel with the package.
- **Card fallback precedence:** `custom_name || cached title || channel:ts`.

---

### Task 1: Move `slackapi` into the watcher library as package `slack`

**Repo:** `~/git/watcher`.

**Files:**
- Create (via `git mv` from worktree is NOT possible cross-repo; use `cp` + `git add`, then delete from worktree in Task 6): `~/git/watcher/slack/client.go`, `client_test.go`, `types.go`, `normalize.go`, `normalize_test.go`, `testdata/` (copied verbatim from `~/git/worktree/internal/slackapi/`).
- Modify: package declaration in each moved `.go` file from `package slackapi` → `package slack`.

**Interfaces:**
- Consumes: nothing (slackapi has zero external deps — stdlib only).
- Produces (consumed by Tasks 2-3 in the library, and Task 7 in worktree): package `github.com/mturley/watcher/slack` exporting `Client` (interface), `HTTPClient`, `New(token, cookie string) *HTTPClient`, `NewWithBaseURL(token, cookie, baseURL string) *HTTPClient`, domain types `Thread{Channel, ThreadTS, LastRead, LatestReply, Messages []Message}`, `Message{TS, UserID, Text, Blocks, Reactions, Edited, Files, Attachments}`, `User{ID, RealName, DisplayName, Avatar72}`, `Reaction`, `File`, `Attachment`, `Block`/`Element`/`BlockKit`/`TextObject`/`Style`, `ErrAuth`, `UnreadDividerIndex`, `NormalizeThread`.

- [ ] **Step 1: Copy the package files into the library**

```bash
mkdir -p ~/git/watcher/slack
cp ~/git/worktree/internal/slackapi/client.go ~/git/watcher/slack/
cp ~/git/worktree/internal/slackapi/client_test.go ~/git/watcher/slack/
cp ~/git/worktree/internal/slackapi/types.go ~/git/watcher/slack/
cp ~/git/worktree/internal/slackapi/normalize.go ~/git/watcher/slack/
cp ~/git/worktree/internal/slackapi/normalize_test.go ~/git/watcher/slack/
cp -R ~/git/worktree/internal/slackapi/testdata ~/git/watcher/slack/
```

- [ ] **Step 2: Rename the package declaration in every copied file**

Change the first non-comment line `package slackapi` → `package slack` in all five `.go` files (`client.go`, `client_test.go`, `types.go`, `normalize.go`, `normalize_test.go`). Do a grep to confirm none remain:

Run: `grep -rn "package slackapi" ~/git/watcher/slack/` → expected: no matches.
Run: `grep -rn "slackapi\." ~/git/watcher/slack/` → expected: no matches (the package never referred to itself by name).

- [ ] **Step 3: Build + test the moved package in isolation**

Run: `cd ~/git/watcher && go build ./slack/ && go test ./slack/ -v`
Expected: builds clean; all ported tests (client_test, normalize_test) PASS. Fixtures resolve from the copied `testdata/`.

- [ ] **Step 4: Commit**

```bash
cd ~/git/watcher
git add slack/
git commit --signoff -m "slack: vendor Slack Web API client + domain types (from worktree internal/slackapi)

Zero-dep package lifted verbatim into the library so the new Slack poller
(and later agent-handler) share one canonical Slack domain. Renamed package
slackapi -> slack. Worktree will re-import these types in a later change."
```

---

### Task 2: Add `slack_reply` event type + display name

**Repo:** `~/git/watcher`.

**Files:**
- Modify: `~/git/watcher/eventtype.go` (const block + `eventTypeDisplayNames` map)
- Test: `~/git/watcher/eventtype_test.go` (create if absent, or add a case)

**Interfaces:**
- Produces: `watcher.EventTypeSlackReply EventType = "slack_reply"`, with `DisplayName()` → `"Slack replies"`.

- [ ] **Step 1: Write the failing test**

Create/extend `~/git/watcher/eventtype_test.go`:
```go
package watcher

import "testing"

func TestSlackReplyDisplayName(t *testing.T) {
	if got := EventTypeSlackReply.DisplayName(); got != "Slack replies" {
		t.Fatalf("EventTypeSlackReply.DisplayName() = %q, want %q", got, "Slack replies")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/git/watcher && go test . -run TestSlackReplyDisplayName -v`
Expected: FAIL — `undefined: EventTypeSlackReply`.

- [ ] **Step 3: Add the const and the display-name mapping**

In `~/git/watcher/eventtype.go`, add to the const block (after `EventTypeJiraLabelsChanged`):
```go
	EventTypeSlackReply        EventType = "slack_reply"
```
And to `eventTypeDisplayNames` (after the Jira entries):
```go
	EventTypeSlackReply:        "Slack replies",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/git/watcher && go test . -run TestSlackReplyDisplayName -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/git/watcher
git add eventtype.go eventtype_test.go
git commit --signoff -m "eventtype: add slack_reply event type + display name"
```

---

### Task 3: Slack timeline poller (`watcher/slack/poller.go`)

**Repo:** `~/git/watcher`.

**Files:**
- Create: `~/git/watcher/slack/poller.go`
- Create: `~/git/watcher/slack/fallbacktitle.go` (Go port of the 60-char truncation)
- Test: `~/git/watcher/slack/poller_test.go`, `~/git/watcher/slack/fallbacktitle_test.go`

**Interfaces:**
- Consumes: package `slack` types from Task 1 (`Client`, `Thread`, `Message`, `New`); `EventTypeSlackReply` from Task 2; existing `db.EventCursor`, `db.IsDuplicate`, `db.DedupCheck`, `db.InsertEvent`, `db.UpsertResourceState`, `db.BackfillFor`, `db.HasPollerError`, `db.RecordPollerSuccess`, `db.RecordPollerError`; `watcher.Event`, `watcher.Resource`, `watcher.EventType`, `watcher.EventTypeWatchStarted`, `watcher.EventTypeWatcherError`.
- Produces (consumed by Task 5 in worktree): `slack.SlackAuth{Token, Cookie, WorkspaceDomain string}` and `func slack.Poll(conn *sql.DB, cfg SlackAuth, resources []watcher.Resource, logger *log.Logger) error`. Also `func fallbackTitle(text string) string` (internal).

- [ ] **Step 1: Write the failing test for fallbackTitle**

Create `~/git/watcher/slack/fallbacktitle_test.go`:
```go
package slack

import "testing"

func TestFallbackTitle(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"   ", ""},
		{"hello world", "hello world"},
		{"  multiple   spaces\n\tand tabs ", "multiple spaces and tabs"},
		{"this is a fairly long first message that exceeds sixty characters for sure", "this is a fairly long first message that exceeds sixty chara…"},
	}
	for _, c := range cases {
		if got := fallbackTitle(c.in); got != c.want {
			t.Errorf("fallbackTitle(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
```
NOTE: the truncation is 60 chars then a trailing `…` (matching `ui/src/lib/fallbackTitle.ts` MAX_LENGTH=60). Verify the expected string is exactly 60 runes of the input + `…` — if the assertion is off by a rune, adjust the expected string to match a correct 60-rune slice, not the code.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/git/watcher && go test ./slack/ -run TestFallbackTitle -v`
Expected: FAIL — `undefined: fallbackTitle`.

- [ ] **Step 3: Implement fallbackTitle**

Create `~/git/watcher/slack/fallbacktitle.go`:
```go
package slack

import "strings"

const maxTitleLen = 60

// fallbackTitle collapses whitespace, trims, and truncates to maxTitleLen
// runes with a trailing ellipsis — the Go port of ui/src/lib/fallbackTitle.ts
// so the cached thread title matches the live-view title.
func fallbackTitle(text string) string {
	collapsed := strings.Join(strings.Fields(text), " ")
	if collapsed == "" {
		return ""
	}
	r := []rune(collapsed)
	if len(r) <= maxTitleLen {
		return collapsed
	}
	return strings.TrimRight(string(r[:maxTitleLen]), " ") + "…"
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/git/watcher && go test ./slack/ -run TestFallbackTitle -v`
Expected: PASS. (If the long-string case fails only on the exact cut point, fix the TEST's expected value to the correct 60-rune slice — the implementation matches the TS source.)

- [ ] **Step 5: Write the failing poller test**

Create `~/git/watcher/slack/poller_test.go`. Use an in-memory DB via the library's test helper (READ `~/git/watcher/jira/poller_test.go` first to reuse its exact DB-setup + subscription-seeding helpers — e.g. how it opens a migrated DB, calls `db.Subscribe`, and constructs a fake client). Define a fake `Client` returning a canned `Thread`. Assertions:
```go
// Pseudocode shape — adapt to jira/poller_test.go's helpers:
// 1. Seed a subscription for Type"slack" ID"C1:1699000000.000100".
// 2. First Poll (empty cursor): exactly ONE event, type watch_started; NO slack_reply.
//    resource_state now caches: title == fallbackTitle(root text); channel_name ==
//    the fake client's Channel() return; author == the root message author's display
//    name (from the fake Users()); created_ts == root message ts; updated_ts ==
//    latest message ts. Assert the fake's Channel() was called exactly ONCE across
//    two polls (stable-name caching): a second Poll must NOT call Channel() again.
// 3. Second Poll with a NEW reply (ts "1699000001.000200"): exactly one slack_reply
//    event; its external_ts == "1699000001.000200" VERBATIM (invariant); body contains
//    the author + snippet.
// 4. Third Poll with no new replies: zero new events (cursor advanced; dedup holds).
```
Include a fake `Client` implementing the `slack.Client` interface. `Replies`, `Users`, and `Channel` need real behavior; the rest return zero values / nil. The fake's `Replies` returns a `Thread` whose `Messages[0]` is the root and `Messages[1:]` are replies with the given ts values. The fake's `Channel` returns a fixed name (e.g. `"wg-dashboard-zaffre"`) and increments a call counter so the test can assert it's called exactly once across two polls.

- [ ] **Step 6: Run to verify it fails**

Run: `cd ~/git/watcher && go test ./slack/ -run TestPoll -v`
Expected: FAIL — `undefined: Poll` / `undefined: SlackAuth`.

- [ ] **Step 7: Implement the poller**

Create `~/git/watcher/slack/poller.go`, mirroring `~/git/watcher/jira/poller.go` (`Poll` → per-resource fetch → `processThread` → cache state → `RecordPollerSuccess`; plus `emitEvent`/`emitError` with `Source:"slack"`). Key specifics:
```go
package slack

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/mturley/watcher"
	"github.com/mturley/watcher/db"
)

type SlackAuth struct {
	Token           string
	Cookie          string
	WorkspaceDomain string
}

func Poll(conn *sql.DB, cfg SlackAuth, resources []watcher.Resource, logger *log.Logger) error {
	if cfg.Token == "" || cfg.Cookie == "" {
		return fmt.Errorf("slack not configured")
	}
	client := New(cfg.Token, cfg.Cookie)
	eventCount := 0
	for _, resource := range resources {
		channel, threadTS, ok := parseResourceID(resource.ID)
		if !ok {
			logger.Printf("ERROR: bad slack resource id %q", resource.ID)
			continue
		}
		thread, err := client.Replies(contextTODO(), channel, threadTS)
		if err != nil {
			logger.Printf("ERROR: fetch thread %s: %v", resource.ID, err)
			errBody := fmt.Sprintf("Failed to fetch thread: %v", err)
			if e := emitError(conn, fmt.Sprintf("Failed to fetch %s", resource.ID), &errBody, resource); e != nil {
				logger.Printf("ERROR: emit watcher error: %v", e)
			}
			if e := db.RecordPollerError(conn, "slack", errBody); e != nil {
				logger.Printf("ERROR: record poller error: %v", e)
			}
			continue
		}
		backfill, err := db.BackfillFor(conn, resource.Type, resource.ID)
		if err != nil {
			logger.Printf("WARNING: backfill resolve %s: %v", resource.ID, err)
		}
		// Resolve display names for ALL message authors (root + replies) in one
		// batched client.Users call; used for both slack_reply event authors and
		// the cached root author.
		names := resolveAuthors(client, thread.Messages)
		count, err := processThread(conn, thread, names, resource, backfill, logger)
		if err != nil {
			logger.Printf("ERROR: process thread %s: %v", resource.ID, err)
			errBody := fmt.Sprintf("Failed to process thread: %v", err)
			if e := emitError(conn, fmt.Sprintf("Error processing %s", resource.ID), &errBody, resource); e != nil {
				logger.Printf("ERROR: emit watcher error: %v", e)
			}
			continue
		}
		eventCount += count

		// Cache thread title/state (always, incl. first poll). The channel
		// name is stable, so resolveChannelName reuses the cached value and
		// only calls the Slack API until it first succeeds.
		channelName := resolveChannelName(conn, client, resource, channel)
		rootAuthor := ""
		if len(thread.Messages) > 0 {
			rootAuthor = names[thread.Messages[0].UserID]
		}
		stateJSON := buildSlackStateJSON(thread, channelName, rootAuthor)
		latestTS := latestThreadTS(thread)
		now := time.Now().UTC().Format(time.RFC3339)
		if err := db.UpsertResourceState(conn, "slack", resource.ID, stateJSON, latestTS, now); err != nil {
			logger.Printf("WARNING: upsert resource state %s: %v", resource.ID, err)
		}
	}
	logger.Printf("Emitted %d events", eventCount)
	if err := db.RecordPollerSuccess(conn, "slack"); err != nil {
		logger.Printf("ERROR: record poller success: %v", err)
	}
	return nil
}
```
Where:
- `contextTODO()` → use `context.Background()` (import `context`); the jira poller's client is sync, slack's `Replies` takes a ctx — pass `context.Background()`.
- `parseResourceID(id)` splits on the FIRST `:` into `(channel, threadTS, ok)`. (Slack channel ids have no colon; thread_ts is `digits.digits`.)
- `processThread` mirrors `jira.processIssue`:
```go
func processThread(conn *sql.DB, thread Thread, names map[string]string, resource watcher.Resource, backfill bool, logger *log.Logger) (int, error) {
	eventCount := 0
	cursor, err := db.EventCursor(conn, "slack", resource.Type, resource.ID)
	if err != nil {
		return 0, fmt.Errorf("event cursor: %w", err)
	}
	title := threadTitle(thread) // fallbackTitle(root text)
	if cursor == "" && !backfill {
		wsTitle := fmt.Sprintf("Started watching thread: %s", title)
		body := title
		if err := emitEvent(conn, watcher.EventTypeWatchStarted, wsTitle, &body, latestThreadTS(thread), nil, nil, resource); err != nil {
			return 0, fmt.Errorf("emit watch_started: %w", err)
		}
		return 1, nil
	}
	replies := thread.Messages
	if len(replies) > 0 {
		replies = replies[1:] // skip the root
	}
	// `names` (author display names for all messages) is resolved once in Poll
	// and passed in, so processThread makes no API calls.
	for _, m := range replies {
		if m.TS <= cursor { // raw Slack ts string compare — the invariant
			continue
		}
		dup, err := db.IsDuplicate(conn, db.DedupCheck{
			Source: "slack", ResourceType: resource.Type, ResourceID: resource.ID,
			Type: watcher.EventTypeSlackReply, ExternalTS: &m.TS,
		})
		if err != nil {
			return eventCount, fmt.Errorf("dedup: %w", err)
		}
		if dup {
			continue
		}
		author := names[m.UserID]
		evTitle := fmt.Sprintf("New reply in %s", title)
		snippet := fallbackTitle(m.Text) // reuse collapse+truncate for the snippet
		body := snippet
		if author != "" {
			body = author + ": " + snippet
		}
		var authorPtr *string
		if author != "" {
			authorPtr = &author
		}
		if err := emitEvent(conn, watcher.EventTypeSlackReply, evTitle, &body, m.TS, authorPtr, nil, resource); err != nil {
			return eventCount, fmt.Errorf("emit slack_reply: %w", err)
		}
		eventCount++
	}
	return eventCount, nil
}
```
- `emitEvent`/`emitError`: copy verbatim from `jira/poller.go` (the two helpers shown in the spec recon), changing `Source: "jira"` → `Source: "slack"` and `db.HasPollerError(conn, "jira")` → `"slack"`.
- `threadTitle(thread)` = `fallbackTitle(rootText(thread))` where `rootText` = `thread.Messages[0].Text` if any, else `""`.
- `latestThreadTS(thread)` = the max `ts` among messages (last reply's ts, or root ts if no replies) — since messages are returned in ascending ts order, it's the last element's `TS`.
- `resolveAuthors(client, messages)` collects distinct `UserID`s across the given messages and calls `client.Users(context.Background(), ids)`, returning `map[userID]displayName` (prefer `DisplayName`, fall back to `RealName`, then the id). Called once in `Poll` with `thread.Messages` (root + replies). On error, return an empty map (events still emit with no author; card author just omitted).
- `buildSlackStateJSON(thread, channelName, rootAuthor)`:
```go
func buildSlackStateJSON(thread Thread, channelName, rootAuthor string) string {
	createdTS := ""
	if len(thread.Messages) > 0 {
		createdTS = thread.Messages[0].TS // root message ts = thread creation time
	}
	m := map[string]interface{}{
		"title":        threadTitle(thread),
		"channel_name": channelName,          // "" if unresolved; card shows "#name"
		"author":       rootAuthor,           // display name of the thread's first-message author
		"created_ts":   createdTS,            // raw Slack ts of the root message
		"updated_ts":   latestThreadTS(thread), // raw Slack ts of the latest message
		"reply_count":  max(0, len(thread.Messages)-1),
	}
	b, _ := json.Marshal(m)
	return string(b)
}
```
(Use a local `max` or inline; Go 1.21+ has builtin `max`. `created_ts`/`updated_ts` are raw Slack epoch-second strings — the card converts them to relative times client-side.)
- `rootAuthor` is resolved from the thread's root message author. Extend the author resolution so `names` also covers `thread.Messages[0].UserID` (i.e. resolve authors for ALL messages incl. the root, not just replies), then `rootAuthor := ""; if len(thread.Messages) > 0 { rootAuthor = names[thread.Messages[0].UserID] }`. This adds no extra API call — the root's UserID just joins the same batched `client.Users` request.
- `resolveChannelName(conn, client, resource, channelID)` — the channel name is STABLE, so cache it once and never re-fetch: read the prior `resource_state` via `db.GetResourceState(conn, "slack", resource.ID)`; if it parses and already has a non-empty `channel_name`, return that (no API call). Otherwise call `client.Channel(context.Background(), channelID)` ONCE; on error return `""` (the card falls back to the title, and the next poll retries the lookup). This keeps steady-state polls to a single `Replies` call — the `Channel` lookup only happens on first poll (or until it first succeeds).
```go
func resolveChannelName(conn *sql.DB, client Client, resource watcher.Resource, channelID string) string {
	if st, err := db.GetResourceState(conn, "slack", resource.ID); err == nil && st != nil {
		var m map[string]interface{}
		if json.Unmarshal([]byte(st.StateJSON), &m) == nil {
			if v, ok := m["channel_name"].(string); ok && v != "" {
				return v
			}
		}
	}
	name, err := client.Channel(context.Background(), channelID)
	if err != nil {
		return ""
	}
	return name
}
```

- [ ] **Step 8: Run to verify the poller tests pass**

Run: `cd ~/git/watcher && go test ./slack/ -v`
Expected: PASS — watch_started-only first poll, one slack_reply per new reply, verbatim external_ts, cursor advance/dedup.

- [ ] **Step 9: Run the full library suite**

Run: `cd ~/git/watcher && go test ./...`
Expected: PASS (no regression to github/jira/db).

- [ ] **Step 10: Commit**

```bash
cd ~/git/watcher
git add slack/poller.go slack/poller_test.go slack/fallbacktitle.go slack/fallbacktitle_test.go
git commit --signoff -m "slack: add timeline Poll (new-reply events + cached thread metadata)

Mirrors github/jira pollers: one slack_reply event per new reply after the
cursor (external_ts = raw Slack ts, never RFC3339), watch_started-only on
first poll. Caches thread title, channel name (once — stable), root author,
and created/updated ts to resource_state for the Overview card."
```

---

### Task 4: Release watcher v0.3.0

**Repo:** `~/git/watcher`.

**Files:** none (release mechanics).

**Interfaces:** Produces pushed tag `v0.3.0` (consumed by Task 5's `go get`).

- [ ] **Step 1: Verify the COMMITTED tree in an isolated detached worktree**

```bash
cd ~/git/watcher
git worktree add --detach /tmp/watcher-verify-v030 HEAD
cd /tmp/watcher-verify-v030
go build ./... && go test ./...
```
Expected: build + all tests PASS in isolation.

- [ ] **Step 2: Remove the verify worktree**

```bash
cd ~/git/watcher && git worktree remove /tmp/watcher-verify-v030
```

- [ ] **Step 3: Tag and push**

```bash
cd ~/git/watcher
git tag -a v0.3.0 -m "v0.3.0: Slack resource type + timeline poller"
git push origin main
git push origin v0.3.0
```
(Annotated tag matches the repo convention — v0.2.3..v0.2.8 are all annotated.)

- [ ] **Step 4: Confirm the tag on the remote**

Run: `cd ~/git/watcher && git ls-remote --tags origin v0.3.0`
Expected: prints a ref for `refs/tags/v0.3.0`.

---

### Task 5: Re-pin v0.3.0 + rewrite `slackapi` imports + delete worktree's copy + add `pollAll` slack branch

**Repo:** `~/git/worktree`.

**Files:**
- Modify: `go.mod`, `go.sum` (via `go get`)
- Delete: `internal/slackapi/` (whole directory — now lives in the library)
- Modify: every worktree file importing `github.com/mturley/worktree/internal/slackapi` → `github.com/mturley/watcher/slack`, and every `slackapi.` qualifier → `slack.` (importers per recon: `cmd/ui.go`, `internal/slackcreds/slackcreds.go`, `internal/setup/slack.go`, `internal/slackpoller/slackpoller.go`, `internal/webui/server.go`, `internal/webui/slack.go`, `internal/webui/slack_proxy.go`, plus their tests `internal/slackpoller/slackpoller_test.go`, `internal/webui/slack_test.go`)
- Modify: `internal/webui/poller.go` (`pollAll` — add slack branch)

**Interfaces:**
- Consumes: `github.com/mturley/watcher/slack` (Task 1) + `slack.Poll`/`slack.SlackAuth` (Task 3); existing `(*wconfig.Config).Slack()` returning `SlackCreds{Token, Cookie, WorkspaceDomain}`.
- Produces: worktree building against the library slack package; slack resources polled in `pollAll`.

- [ ] **Step 1: Re-pin the library**

```bash
cd ~/git/worktree
go get github.com/mturley/watcher@v0.3.0
go mod tidy
```
Expected: `go.mod` shows `github.com/mturley/watcher v0.3.0`.

- [ ] **Step 2: Rewrite imports + qualifiers, then delete the local package**

For each importer file, change the import path `"github.com/mturley/worktree/internal/slackapi"` → `"github.com/mturley/watcher/slack"` and rename every `slackapi.X` reference → `slack.X`. (If a file aliases the import, keep the alias and only change the path — simplest is to import as `slackapi "github.com/mturley/watcher/slack"` to avoid touching call sites; PREFER a clean rename to `slack` unless a local identifier named `slack` collides — check each file.)

Then remove the vendored copy:
```bash
cd ~/git/worktree
git rm -r internal/slackapi
```

- [ ] **Step 3: Add the slack branch to `pollAll`**

In `~/git/worktree/internal/webui/poller.go`, add (after the jira block, before `return nil`), and add the import `wslack "github.com/mturley/watcher/slack"`:
```go
	if threads, _ := watcherdb.ActiveResources(s.DB, "slack"); len(threads) > 0 {
		if sc, err := cfg.Slack(); err == nil {
			auth := wslack.SlackAuth{Token: sc.Token, Cookie: sc.Cookie, WorkspaceDomain: sc.WorkspaceDomain}
			if err := wslack.Poll(s.DB, auth, threads, s.logger()); err != nil {
				s.logger().Printf("slack poll: %v", err)
			}
		} else {
			s.logger().Printf("slack not configured; skipping %d slack resources", len(threads))
		}
	}
```
NOTE: confirm the field names on `wconfig`'s Slack creds return (`sc.Token`, `sc.Cookie`, `sc.WorkspaceDomain`) by reading `internal/slackcreds` / the wconfig `Slack()` accessor; adjust if named differently.

- [ ] **Step 4: Build**

Run: `cd ~/git/worktree && go build ./...`
Expected: builds clean (all `slackapi.` references resolved to `slack.`, no dangling import of the deleted package).

- [ ] **Step 5: Run the Go test suite**

Run: `cd ~/git/worktree && go test ./...`
Expected: PASS — the moved slackapi tests are gone from worktree (they run in the library now); slackpoller/webui slack tests pass against the library types.

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktree
git add go.mod go.sum internal/webui/poller.go internal/slackpoller/ internal/slackcreds/ internal/setup/ internal/webui/server.go internal/webui/slack.go internal/webui/slack_proxy.go cmd/ui.go
git commit --signoff -m "slack: consume watcher/slack (v0.3.0); poll slack threads in pollAll

Re-pin watcher v0.3.0, delete the vendored internal/slackapi (now
watcher/slack), rewrite imports, and add a slack branch to the in-process
poll loop so watched threads emit slack_reply timeline events."
```

---

### Task 6: Overview card — slack title, channel, author, created/updated (`enrichResourceDTO` + `SlackCardBody`)

**Repo:** `~/git/worktree`.

**Files:**
- Modify: `internal/webui/resources_api.go` (`resourceDTO` add `ChannelName`; `enrichResourceDTO` — add `case "slack"`)
- Test: `internal/webui/resources_api_test.go` (add a slack-enrichment case)
- Modify: `ui/src/api/types.ts` (`ResourceDTO` add `channel_name?`)
- Modify: `ui/src/components/ResourceCard.tsx` (`SlackCardBody` fallback precedence + `#channel_name`)
- Test: `ui/src/components/ResourceCard.test.tsx` (update slack fallback tests)

**Interfaces:**
- Consumes: cached `resource_state` for `("slack", id)` with `{"title": ..., "channel_name": ...}` written by Task 3's poller; existing `resourceDTO.Title`, `ResourceDTO.custom_name`.
- Produces: slack resource cards show label `custom_name || title || id` plus a `#<channel_name>` chip when present. DTO gains `channel_name` (json `channel_name,omitempty`) / TS `channel_name?: string`.

- [ ] **Step 1: Write the failing backend test**

In `~/git/worktree/internal/webui/resources_api_test.go`, add a test that upserts a slack resource_state row with `{"title":"e2e regression thread","channel_name":"wg-dashboard-zaffre","author":"Christian Vogt","created_ts":"1699000000.000100","updated_ts":"1699000500.000200"}` and asserts the DTO from `/api/worktree-resources` for the slack resource includes `title`, `channel_name`, `author`, `created_ts`, and `updated_ts` with those values. (Match the existing test's server+DB setup; use `watcherdb.UpsertResourceState(conn, "slack", "<channel>:<ts>", <that JSON>, "1699000500.000200", now)`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/git/worktree && go test ./internal/webui/ -run TestSlackEnrich -v`
Expected: FAIL — slack DTO has empty Title (no `case "slack"` yet).

- [ ] **Step 3: Add the DTO field + slack case to enrichResourceDTO**

In `~/git/worktree/internal/webui/resources_api.go`, add fields to `resourceDTO` (after `Title`):
```go
	ChannelName string `json:"channel_name,omitempty"` // slack: cached #channel name
	CreatedTS   string `json:"created_ts,omitempty"`   // slack: root message ts (creation)
	UpdatedTS   string `json:"updated_ts,omitempty"`   // slack: latest message ts
```
And in `enrichResourceDTO`'s `switch dto.Type`, add:
```go
	case "slack":
		if v, ok := m["title"].(string); ok {
			dto.Title = v
		}
		if v, ok := m["channel_name"].(string); ok {
			dto.ChannelName = v
		}
		if v, ok := m["author"].(string); ok {
			dto.Author = v
		}
		if v, ok := m["created_ts"].(string); ok {
			dto.CreatedTS = v
		}
		if v, ok := m["updated_ts"].(string); ok {
			dto.UpdatedTS = v
		}
```
(`dto.Author` already exists on `resourceDTO` from the PR path — reused here.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd ~/git/worktree && go test ./internal/webui/ -run TestSlackEnrich -v`
Expected: PASS.

- [ ] **Step 5: Add the TS DTO fields**

In `~/git/worktree/ui/src/api/types.ts`, add to `ResourceDTO` (after the existing enrichment fields):
```ts
  channel_name?: string
  created_ts?: string
  updated_ts?: string
```
(`author` is already on `ResourceDTO` from the PR path — the slack enrich case in Step 3 reuses it, no new TS field for author.)

- [ ] **Step 6: Update the SlackCardBody + its test**

In `~/git/worktree/ui/src/components/ResourceCard.tsx`, update `SlackCardBody` so it shows:
- **label** = `r.custom_name || r.title || r.id` (the link text).
- a dimmed **`#<channel_name>`** when `r.channel_name` is set.
- a dimmed **author** (`r.author`) when set — e.g. `"by <author>"`.
- dimmed **created/updated** relative times when set, via `relativeFromNow` (from `../lib/relativeTime`, which takes a Slack epoch-second `ts` string — the same helper the SlackTab header uses). Mirror the header's "Started X · Active Y" phrasing.

`ResourceCard.tsx` already imports `relativeTime` from `../lib/relativeTime` and `Stack` from `@mantine/core` — extend the existing `relativeTime` import to `{ relativeTime, relativeFromNow }` rather than adding a new import line.

```tsx
function SlackCardBody({ r }: { r: ResourceDTO }) {
  const label = r.custom_name || r.title || r.id
  return (
    <Stack gap={2}>
      <Group gap="xs" wrap="wrap">
        <Badge size="xs" variant="light" color="grape">Slack</Badge>
        {r.url ? <Anchor href={r.url} target="_blank" size="sm">{label}</Anchor> : <Text size="sm">{label}</Text>}
      </Group>
      <Group gap="xs" wrap="wrap">
        {r.channel_name && <Text size="xs" c="dimmed">#{r.channel_name}</Text>}
        {r.author && <Text size="xs" c="dimmed">by {r.author}</Text>}
        {r.created_ts && <Text size="xs" c="dimmed">started {relativeFromNow(r.created_ts)}</Text>}
        {r.updated_ts && <Text size="xs" c="dimmed">· active {relativeFromNow(r.updated_ts)}</Text>}
      </Group>
    </Stack>
  )
}
```
(`Stack` is already imported from `@mantine/core` in ResourceCard.tsx.)

In `~/git/worktree/ui/src/components/ResourceCard.test.tsx`, add/adjust cases:
- custom_name set → shows custom_name as the label (unchanged).
- no custom_name, title set → shows title (NEW).
- neither → shows id (unchanged).
- channel_name set → shows `#channel_name` (NEW).
- author set → shows `by <author>` (NEW).
- created_ts/updated_ts set → shows a "started …"/"active …" relative time (NEW). To keep this deterministic, assert the presence of the `started`/`active` labels (e.g. `getByText(/^started /)`) rather than an exact duration, OR pass a recent ts and match `/started \d+[smhd] ago/`. (relativeFromNow defaults `now` to `new Date()`; for a stable assertion, use a ts a fixed offset before a mocked now if the test file already mocks time — otherwise the label-presence check is sufficient.)

- [ ] **Step 7: Run frontend tests + tsc**

Run: `cd ~/git/worktree/ui && npx vitest run src/components/ResourceCard.test.tsx && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
cd ~/git/worktree
git add internal/webui/resources_api.go internal/webui/resources_api_test.go ui/src/api/types.ts ui/src/components/ResourceCard.tsx ui/src/components/ResourceCard.test.tsx
git commit --signoff -m "slack: enrich Overview card with title, channel, author, timestamps

enrichResourceDTO reads the slack resource_state title/channel_name/author/
created_ts/updated_ts (cached by the watcher slack poller); card label =
custom_name || title || id, plus #channel, 'by <author>', and started/active
relative times."
```

---

### Task 7: Full build + docs

**Repo:** `~/git/worktree`.

**Files:**
- Modify: `.claude/CLAUDE.md` (internal/ package list: note slackapi moved to watcher/slack; add the slack poller to the "three pollers" note if needed)
- Modify: `docs/web-ui-architecture.md` (Polling model: slack now polled in pollAll; slack timeline events; card title from cached state)

**Interfaces:** Consumes everything above; produces green `make build` + `make test` and accurate docs.

- [ ] **Step 1: Full build (embeds UI)**

Run: `cd ~/git/worktree && make build`
Expected: builds clean.

- [ ] **Step 2: Full test**

Run: `cd ~/git/worktree && make test`
Expected: Go + vitest all green.

- [ ] **Step 3: Update CLAUDE.md**

In `~/git/worktree/.claude/CLAUDE.md`, update the `internal/` package list: `slackapi` no longer exists locally (it's `github.com/mturley/watcher/slack`); note that the Slack API client + domain types + the timeline poller now live in the watcher library, and worktree's `slackpoller` (live-tab SSE) consumes the library's `slack.Client`. Update the "three distinct pollers" note to reflect: (1) library github/jira/**slack** pollers called from `internal/webui/poller.go`, (2) worktree's live-tab `slackpoller`, (3) — keep it accurate to the new reality.

- [ ] **Step 4: Update web-ui-architecture.md**

In `~/git/worktree/docs/web-ui-architecture.md`, note in the polling model section: slack resources are now polled in `pollAll` via `watcher/slack.Poll`, emitting `slack_reply` timeline events; the Overview slack card title comes from cached `resource_state` written by that poller (fallback `custom_name || title || id`).

- [ ] **Step 5: Commit**

```bash
cd ~/git/worktree
git add .claude/CLAUDE.md docs/web-ui-architecture.md
git commit --signoff -m "docs: watcher/slack poller + slack timeline events + card title"
```

---

## Notes for the executor

- **Task order is strict for 1→5** (library package + event type + poller must be committed and released as v0.3.0 before the worktree `go get`). Tasks 6-7 are worktree-only.
- Tasks 1-4 happen in `~/git/watcher` (use `git -C ~/git/watcher` or `cd` per the brief); Tasks 5-7 in `~/git/worktree`.
- Do NOT add `slack_reaction` or any reaction handling this phase (Global Constraints).
- The live-tab `internal/slackpoller` stays — it just imports `slack.Client`/`slack.Thread` from the library now instead of the deleted local package. Do not remove or merge it.
- The raw-ts-not-RFC3339 invariant is the single most important correctness property — the poller test must assert stored `external_ts` equals the Slack ts verbatim.
