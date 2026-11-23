# CLI Search and Slack Thread Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `worktree search` mirrors the web UI's search bar from the CLI, `worktree slack thread` summarises and (on request) reads one cached Slack thread, the `worktree` skill uses both, and the home page's search dropdown gets an "Include archived" toggle that reaches archived resources and tasks.

**Architecture:** Go twins of `ui/src/lib/search.ts`'s matchers live beside `matchEvent` in `internal/webui`, locked to the TS by one shared JSON fixture. `Server.Search`, `Server.ArchivedResources`, `Server.SlackThread` and `Server.SlackThreadMessages` are read-only methods the CLI calls through `headlessServer`; the HTTP side reuses `ArchivedResources` for `GET /api/all-resources?archived=true`.

**Tech Stack:** Go (cobra, SQLite via `database/sql`), React + Mantine + TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-11-20-cli-search-and-slack-thread-design.md`

## Global Constraints

- Neither command contacts Slack, GitHub or Jira; both open the DB with `wdb.OpenRead()` and write nothing (no mark-read).
- JSON output goes through `printJSON` (`schema_version: 1`, snake_case, an object, never a bare array); colors only through `internal/ui`.
- Exit codes: 0 found, 1 nothing found (`ErrNothingFound`), 2 error. `search` with an empty query is exit 2. `slack thread` ambiguous is exit 2 after printing candidates to stdout.
- Search output never carries event bodies; `slack thread` prints bodies only with `--messages`.
- Slack bodies stay mrkdwn; only the leading `"<author>: "` is stripped.
- Default limits: 10 worktrees, 10 resources, 10 tasks, 20 events; `--limit N` sets the events limit.
- `--source` values: `github`, `jira`, `slack`, `tasks`, `links` → types `pr`, `jira`, `slack`, `task`, `link`.
- New `internal/webui` tests call `t.Parallel()` first and build git fixtures with `testgit.Worktree`/`testgit.Template`; run with `go test -timeout 40m ./internal/webui/`, and `go test -race ./internal/webui/` once at the end.
- Read logic lives in `Server` methods, never in `cmd/`. Both new commands go in `skillReadCommands` (`cmd/agent_help_test.go`).
- Commits use `--signoff` and end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Work happens on a feature branch (`cli-search`), never on `main`.
- **Do not touch `README.md` until Mike says his README rewrite is merged** (Task 10 is blocked on that).
- **After Task 9, stop.** Run the final verification, then `NONINTERACTIVE=1 make install` so Mike can test the real binary, and hand back. Task 10 only starts after he has tested and told you his README rewrite is merged.

## Review Focus

1. A thread followed by two worktrees, or unfollowed in one and still followed in another, or unfollowed then refollowed: it is not archived and appears once (Task 3 test `TestArchivedResourcesExcludesStillFollowed`).
2. Query terms holding `%`, `_` or `\` match literally in every group, not as wildcards (Task 4 test `TestSearchLiteralWildcards`).
3. A thread name that is an exact custom-name match for one thread and a substring of another's title resolves to the exact match, not "ambiguous" (Task 6 test `TestResolveSlackThreadExactBeatsSubstring`).
4. A followed Slack thread with no `watcher_resource_state` row yet (never polled) still summarises without panicking: empty channel/title, author and start from the root event if present (Task 6 test `TestSlackThreadSummaryWithoutState`).
5. Non-ASCII case folding (`É` vs `é`) matches the same way in Go and TS (Task 1 parity fixture case `unicode-fold`).

---

### Task 1: Go twins of the UI's resource/task/worktree matchers, with a shared parity fixture

**Files:**
- Create: `internal/webui/search_match.go`
- Create: `internal/webui/search_match_test.go`
- Create: `ui/src/lib/testdata/search-parity.json`
- Create: `ui/src/lib/searchParity.test.ts`
- Modify: `internal/webui/search.go` (extend `searchMatch`)
- Modify: `ui/src/lib/search.ts` (comment naming the Go twin only)

**Interfaces:**
- Consumes: `snippet`, `parseSearchTerms` (`search.go`); `shortResourceRef(typ, id string) string` (`task_timeline.go`); `tasks.Task`.
- Produces (all in package `webui`):
  - `searchMatch` gains `ViaKey, ViaType, ViaID, ViaField string` (json `via_key`, `via_type`, `via_id`, `via_field`, all `omitempty`).
  - `func matchResource(r *resourceDTO, terms []string) *searchMatch`
  - `func matchTask(t tasks.Task, terms []string) *searchMatch` (ref is `"T"+id`)
  - `func matchWorktree(w *worktreeSummary, workspaceTitles []string, rs []resourceDTO, terms []string) *searchMatch`
  - `func rankText(label string, terms []string) int`, `func rankResource(r *resourceDTO, terms []string) int`, `func rankTask(t tasks.Task, terms []string) int`
  - `func resourceLabel(r *resourceDTO) string` (custom name, else title, else id)
  - `const matchWorktreesViaResources = true` (twin of `MATCH_WORKTREES_VIA_RESOURCES`)

Field lists, order, `long` (snippet) flags and rank rules are exactly those in `ui/src/lib/search.ts` (`resourceFields`, `matchTask`, `matchWorktree`, `rankText`, `rankResource`, `rankTask`). `status` is `Status` else `State`; `url` only for `link`. Worktree name is the last path segment.

- [ ] **Step 1: Write the fixture.** `ui/src/lib/testdata/search-parity.json`: `{"cases": [{"name", "kind": "resource"|"task"|"worktree", "item": {...}, "workspace_titles"?: [], "resources"?: [...], "query": "...", "want": null | {"field", "snippet", "via_key"?, "via_field"?}, "rank"?: n}]}`. Items use the JSON field names of `ResourceDTO`, `Task` (`id`, `ref`, `title`, `description`, `state`) and `WorktreeSummary` (`path`, `branch`, `repo`, `notes_search`). Cases, at least: `key-exact` (PR `o/r#12`, query `#12`, rank 0), `title-prefix` (rank 1), `custom-name`, `jira-reporter`, `labels`, `long-description-snippet` (body > 120 runes, snippet with `…`), `all-terms-across-fields` (two terms in different fields), `one-term-missing` (want null), `link-url`, `slack-channel-key` (query is the channel name), `task-ref` (`t8`, rank 0), `task-description`, `worktree-branch`, `worktree-workspace`, `worktree-via-resource` (via_key `#12`, via_field `title`), `unicode-fold` (title `Équipe`, query `équipe`).
- [ ] **Step 2: Write the Go test** `TestSearchParityFixture` in `search_match_test.go`: reads `../../ui/src/lib/testdata/search-parity.json`, decodes each item into `resourceDTO` / a `tasks.Task` (ref ignored; id parsed from it) / `worktreeSummary`, runs the matcher with `parseSearchTerms(query)`, compares `field`, `snippet`, `via_key`, `via_field` (nil when `want` is null), and when `rank` is set compares `rankResource`/`rankTask`/`rankText(branch)`. Use subtests per case, `t.Parallel()`.
- [ ] **Step 3: Write the TS test** `searchParity.test.ts`: imports the JSON, runs `matchResource`/`matchTask`/`matchWorktree`/`rankResource`/`rankTask`/`rankText` from `./search` with `parseQuery`, compares the same fields (`viaKey`/`viaField` ↔ `via_key`/`via_field`).
- [ ] **Step 4: Run both; Go fails (undefined), TS passes.**
  Run: `go test -run TestSearchParityFixture ./internal/webui/` → FAIL (undefined: matchResource). `cd ui && npx vitest run src/lib/searchParity.test.ts` → PASS (if a TS case fails, the fixture is wrong: fix the fixture, not search.ts).
- [ ] **Step 5: Implement `search_match.go`** with the signatures above, reusing `snippet` for long fields and `strings.ToLower` for folding. Add a comment on each side naming its twin (as `slackplain.go` does).
- [ ] **Step 6: Run both tests.** Expected: PASS, PASS.
- [ ] **Step 7: Commit** — `feat(search): Go twins of the UI's resource, task and worktree matchers`

### Task 2: Export the timeline's search filters

**Files:**
- Modify: `internal/webui/timeline.go` (`TimelineQuery`, `handleGlobalTimeline`, the worktree-timeline handler, every other setter of the renamed fields)
- Test: `internal/webui/timeline_test.go`

**Interfaces:**
- Produces: `TimelineQuery` fields `Archived bool`, `HumansOnly bool`, `Query string` (parsed with `parseSearchTerms` inside `Timeline`), `EventTypes []string` (parsed inside `Timeline` by a values-based parser `eventTypeFilterFrom(vals []string) eventTypeFilter` split out of `parseEventTypes(r)`). The unexported `archived`, `humansOnly`, `terms`, `eventTypes` fields go away; handlers set the exported ones.

- [ ] **Step 1: Write `TestTimelineQueryExportedFilters`**: seed (with `insertEvent`) a followed resource's events and one archived (unsubscribed) resource's event; assert `Timeline(TimelineQuery{Query: "needle"})` returns only events whose title holds `needle` with `Match.Field == "title"`; `Archived: true` adds the archived event; `EventTypes: []string{"ci_*"}` narrows to `ci_` types; `HumansOnly: true` drops an `author_type = 'bot'` event.
- [ ] **Step 2: Run it.** `go test -run TestTimelineQueryExportedFilters ./internal/webui/` → FAIL (unknown fields).
- [ ] **Step 3: Rename/add the fields and route the handlers through them.**
- [ ] **Step 4: Run the test plus the existing timeline and search tests.** `go test -timeout 40m -run 'Timeline|Search' ./internal/webui/` → PASS.
- [ ] **Step 5: Commit** — `refactor(timeline): export search, archived, humans-only and event-type filters`

### Task 3: Archived resources loader and `GET /api/all-resources?archived=true`

**Files:**
- Create: `internal/webui/archived_resources.go`
- Create: `internal/webui/archived_resources_test.go`
- Modify: `internal/webui/all_resources_api.go` (DTO fields, handler param)
- Modify: `internal/webui/headless.go` (doc comment listing read methods)
- Modify: `ui/src/api/types.ts` (`AllResourceDTO.archived?`, `last_followed_by?`), `ui/src/api/client.ts` (`allResources(opts?: { archived?: boolean })`)

**Interfaces:**
- Produces:
  - `allResourceDTO` gains `Archived bool \`json:"archived,omitempty"\`` and `LastFollowedBy []resourceWorktree \`json:"last_followed_by,omitempty"\`` (`Worktrees` stays an empty slice for archived ones).
  - `func (s *Server) ArchivedResources() ([]AllResource, error)`: every `(resource_type, resource_id)` with at least one tombstoned (`deleted_at IS NOT NULL`) `worktree:` subscription and **no** live `worktree:` subscription (`task:` holds count for neither). Built with `newResourceDTO` + unread fill like `AllResources`. `LastFollowedBy` lists the tombstoned subscribers' paths (`wdb.WorktreePathFromSubscriber`), newest `deleted_at` first, with repo/branch from `registry` when the path is still registered, else path only. Order: newest `deleted_at` first.
  - `GET /api/all-resources?archived=true` returns `AllResources()` followed by `ArchivedResources()`.
  - TS: `api.allResources({ archived: true })`.

- [ ] **Step 1: Write tests** in `archived_resources_test.go`:
  - `TestArchivedResourcesListsUnfollowed`: follow PR `o/r#1` in worktree a, `resources.Remove` it; assert one result, `Archived` true, `LastFollowedBy[0].Path == a`, cached title enriched.
  - `TestArchivedResourcesExcludesStillFollowed`: (Review Focus 1) a Slack thread followed by a and b, removed from a only; another removed then re-added in a; a third held only by a `task:` subscription after removal. Assert none of the first two appear, the third does (holds don't count as following).
  - `TestAllResourcesEndpointArchivedParam`: `/api/all-resources` excludes the archived one; `?archived=true` includes it once with `"archived": true`.
- [ ] **Step 2: Run them.** `go test -run 'ArchivedResources|AllResourcesEndpointArchived' ./internal/webui/` → FAIL.
- [ ] **Step 3: Implement** the loader and the handler param; update the TS types and client.
- [ ] **Step 4: Run.** Same command → PASS; `cd ui && npx tsc --noEmit` → no errors.
- [ ] **Step 5: Commit** — `feat(resources): list archived resources (all-resources?archived=true)`

### Task 4: `Server.Search`

**Files:**
- Create: `internal/webui/search_api.go`
- Create: `internal/webui/search_api_test.go`

**Interfaces:**
- Consumes: Task 1 matchers; Task 2 `TimelineQuery` fields; Task 3 `ArchivedResources`; `AllResources`, `WorktreeResources`, `WorktreeSummaries`, `tasks.List`, `cmux.IsAvailable`/`cmux.ListWorkspaces`/`cmux.Match` (only when `s.cmuxEnabled()`; on error, no workspace titles).
- Produces:
  ```go
  type SearchQuery struct {
      Query        string
      WorktreePath string   // "" = all worktrees
      Sources      []string // internal types: pr, jira, slack, task, link; empty = all
      Since        string   // RFC 3339; events only
      UnreadOnly, Archived, HumansOnly bool
      EventTypes   []string
      Limits       SearchLimits // zero fields take the defaults 10/10/10/20
  }
  type SearchLimits struct{ Worktrees, Resources, Tasks, Events int }
  type SearchResult struct {
      Terms     []string
      Worktrees []SearchWorktreeHit // nil when scoped
      Resources []SearchResourceHit
      Tasks     []SearchTaskHit     // nil when scoped or the tasks group is off
      Events    []SearchEventHit
  }
  type SearchWorktreeHit struct{ Path, Repo, Branch string; Match *searchMatch }
  type SearchResourceHit struct {
      Type, ID, URL, CustomName, Title, ChannelName, Status, State, Author, Assignee string
      Archived bool; Unread bool; Worktrees []string /* paths */; LastFollowedBy []string
      Match *searchMatch
  }
  type SearchTaskHit struct{ ID int64; Ref, Title, State string; Archived bool; Worktrees []string; Match *searchMatch }
  type SearchEventHit struct {
      ID, TS, Source, Type, Title, Author string; Unread bool
      Resource SearchEventResource; Match *searchMatch // no Body field
  }
  type SearchEventResource struct{ Type, ID, URL, CustomName, Title string }
  var ErrEmptyQuery = errors.New("search needs at least one term")
  func (s *Server) Search(q SearchQuery) (SearchResult, error)
  ```
  (Exported via `headless.go` aliases if the matcher types stay unexported: alias `SearchMatch = searchMatch`. JSON tags snake_case on every field.)

Group rules (spec "How filters reach each group"): scoped (`WorktreePath != ""`) gives resources + events only and ignores `Archived`. `Sources` narrows events (`ResourceTypes`), resources by type, and a worktree's via-resources by type; tasks group only when `Sources` is empty or holds `task`. `UnreadOnly`: events `UnreadOnly`, resources with `UnreadCount > 0` or Slack `HasUnread`, worktrees with `HasUnread`, and no tasks group. Tasks: `tasks.List(s.DB, tasks.Filter{IncludeCompleted: true, IncludeArchived: q.Archived})`, ranked by `rankTask` plus 10 for done (as `buildSuggestions`). Resources ranked by `rankResource`, worktrees by `rankText(branch)`, stable ties.

- [ ] **Step 1: Write tests** in `search_api_test.go` over a fixture of two registered worktrees (`testgit.Worktree`), a PR, a Jira issue, a Slack thread (with a `slack_thread_root` and a `slack_reply` event), a task, and one archived PR:
  - `TestSearchGroupsGlobal`: query `inferencepool` finds the thread resource (title) and its root event; the worktree following it appears via the resource; `Events[0]` has no body field in its JSON (`json.Marshal` then assert no `"body"` key).
  - `TestSearchScoped`: `WorktreePath` set → `Worktrees` and `Tasks` nil; resources only from that worktree.
  - `TestSearchSourcesAndUnread`: `Sources: {"slack"}` drops the PR and the tasks group; `Sources: {"task"}` gives only tasks and task events; `UnreadOnly` drops the tasks group.
  - `TestSearchArchived`: the archived PR appears in `Resources` with `Archived` true only when `Archived: true`.
  - `TestSearchTasksIncludeDone`: a done task matches and ranks after an open one with the same rank.
  - `TestSearchLiteralWildcards`: (Review Focus 2) a title `100% done` and another `1000 done`; query `100%` matches only the first in resources and events; `a_b` does not match `axb`.
  - `TestSearchEmptyQuery`: `"   "` → `ErrEmptyQuery`.
- [ ] **Step 2: Run.** `go test -run TestSearch ./internal/webui/` → FAIL.
- [ ] **Step 3: Implement `Search`.**
- [ ] **Step 4: Run.** → PASS.
- [ ] **Step 5: Commit** — `feat(search): Server.Search, the search bar's answer for the CLI`

### Task 5: `worktree search` command

**Files:**
- Create: `cmd/search.go`
- Create: `cmd/search_test.go`
- Modify: `cmd/activity.go` (`sourceTypes` accepts `links` → `link`; error text lists it)
- Modify: `cmd/agent_help_test.go` (`"worktree search": true`)

**Interfaces:**
- Consumes: `Server.Search`, `SearchQuery`, `ErrEmptyQuery`; `parseSince`, `sourceTypes`, `resolveWorktreeFlag`, `headlessServer`, `printJSON`.
- Produces: `worktree search <terms…> [--worktree] [--source]… [--type]… [--since] [--unread] [--archived] [--humans-only] [--limit 20] [--json]`, `Args: cobra.MinimumNArgs(1)`, terms joined with spaces, `GroupID: "worktree"`. JSON: `{"schema_version":1,"query","terms","scope":"all"|<path>,"worktrees"?, "resources", "tasks"?, "events"}` (`worktrees`/`tasks` omitted when scoped). Human output: a heading per non-empty group (`Worktrees`, `Resources`, `Tasks`, `Activity`), one line per hit with the match's "why" (`field: snippet`, or `via <key>`) dimmed through `internal/ui`. `--archived` with `--worktree` is an error. Returns `ErrNothingFound` when every group is empty.

- [ ] **Step 1: Write tests** in `cmd/search_test.go`, following the existing `cmd` tests' DB setup (see `activity_test.go`): `TestSearchJSONShape` (keys and `schema_version`, no `body` anywhere), `TestSearchScopedOmitsGroups`, `TestSearchNothingFoundExit1` (via `exitCode` → 1), `TestSearchEmptyQueryExit2`, `TestSearchSourceLinks`.
- [ ] **Step 2: Run.** `go test -run TestSearch ./cmd/` → FAIL.
- [ ] **Step 3: Implement `cmd/search.go`.**
- [ ] **Step 4: Run** `go test ./cmd/` → PASS (includes `TestSkillNamesEveryWrite`).
- [ ] **Step 5: Commit** — `feat(cli): worktree search`

### Task 6: Slack thread summary and messages on the Server

**Files:**
- Create: `internal/webui/slack_thread_read.go`
- Create: `internal/webui/slack_thread_read_test.go`

**Interfaces:**
- Consumes: `AllResources`, `ArchivedResources` (Task 3), `newResourceDTO`, `slackurl.Parse`/`slackurl.ResourceID`, `resourceurl.Infer`, `snippet`.
- Produces:
  ```go
  type SlackThreadSummary struct {
      ID, URL, ChannelName, CustomName, CustomDescription, Title string
      Author, StartedAt /* RFC3339 */, UpdatedAt /* RFC3339 */ string
      ReplyCount, RepliesCached int; Complete bool; Unread bool; Archived bool
      Worktrees, LastFollowedBy []string // paths
      FirstMessage string // excerpt, <= 200 runes, word-boundary cut with "…"
  }
  type SlackMessage struct{ Author, AuthorID, TS /* Slack ts */, SentAt /* RFC3339 */, Text string; Root, Synthesized bool }
  type AmbiguousThreadError struct{ Name string; Candidates []SlackThreadSummary } // Error(): `ambiguous: N threads match "<name>"`
  var ErrThreadNotFound = errors.New("no followed Slack thread matches")
  func slackMessageText(body, author string) string // Go twin of ui/src/lib/slackEvent.ts slackMessageText
  func (s *Server) ResolveSlackThread(ref string) (string, error) // resource id; ref = URL | "slack:<id>" | name
  func (s *Server) SlackThread(id string) (SlackThreadSummary, error)
  func (s *Server) SlackThreadMessages(id string) ([]SlackMessage, error)
  ```
  JSON tags are snake_case (`channel_name`, `started_at`, `replies_cached`, `first_message`, `last_followed_by`, `sent_at`, `synthesized`, …).
  Name resolution: candidates are Slack resources from `AllResources` + `ArchivedResources`; case-insensitive exact match on custom name or title wins (several exact → ambiguous), else unique substring, else `ErrThreadNotFound`; several substring → `*AmbiguousThreadError` (candidates' `FirstMessage` empty). Summary: author/start from the `slack_thread_root` event, else cached `author`/`created_ts`; `UpdatedAt` from cached `updated_ts`; `RepliesCached` counts `slack_reply` events; `Complete` is `RepliesCached >= ReplyCount`. Messages: root + replies by `external_ts` ascending, `Text = slackMessageText(body, author)`; when no root event exists, a synthesized root from `watch_started`'s body with cached author/`created_ts`, `Synthesized: true`. `watcher_error` never included. Nothing written.

- [ ] **Step 1: Write tests:** `TestSlackMessageText` (strips `"Ann: "` only when it is the prefix for that author), `TestResolveSlackThreadByURLAndID`, `TestResolveSlackThreadExactBeatsSubstring` (Review Focus 3), `TestResolveSlackThreadAmbiguous` (two substring matches → `*AmbiguousThreadError` with 2 candidates), `TestSlackThreadSummary` (fields from root event and state; `Complete` false when state `reply_count` is 3 and 2 replies cached), `TestSlackThreadSummaryWithoutState` (Review Focus 4), `TestSlackThreadMessagesOrderAndStrip` (root first, replies by `external_ts`, prefixes stripped, `watch_started` and `watcher_error` absent), `TestSlackThreadMessagesSynthesizedRoot`, `TestSlackThreadArchived` (resolves and reads a thread no worktree follows).
- [ ] **Step 2: Run.** `go test -run 'SlackThread|SlackMessageText' ./internal/webui/` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** → PASS.
- [ ] **Step 5: Commit** — `feat(slack): read a cached thread's summary and messages`

### Task 7: `worktree slack thread` command

**Files:**
- Create: `cmd/slack.go`
- Create: `cmd/slack_test.go`
- Modify: `cmd/root.go` (`exitCode`: an `ErrPrinted` sentinel-wrapping error exits 2 without printing again)
- Modify: `cmd/agent_help_test.go` (`"worktree slack": true`, `"worktree slack thread": true` — whichever paths the test walks)

**Interfaces:**
- Consumes: Task 6.
- Produces: `worktree slack thread <ref> [--messages] [--json]`, `Args: cobra.ExactArgs(1)`. JSON `{"schema_version":1,"thread":{…},"messages"?:[…]}`; ambiguous: stdout `{"schema_version":1,"ambiguous":true,"candidates":[…]}` (or one human line each), stderr `ambiguous: N threads match "<name>"`, exit 2; not found: exit 1. `var ErrPrinted` in `cmd`: `exitCode` returns 2 for `errors.Is(err, ErrPrinted)` and prints only the wrapped message. Human summary per the spec sketch; `--messages` appends `<author> · <local time>` then the text, a blank line between messages; a synthesized root is labelled `(from the follow event)`; `Complete == false` prints `Only N of M replies are cached.`

- [ ] **Step 1: Write tests:** `TestSlackThreadJSONSummaryOnly` (no `messages` key without the flag), `TestSlackThreadMessagesJSON`, `TestSlackThreadAmbiguousExit2` (stdout JSON has `ambiguous: true` and 2 candidates; stderr one line; `exitCode` 2), `TestSlackThreadNotFoundExit1`.
- [ ] **Step 2: Run.** `go test -run TestSlackThread ./cmd/` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./cmd/` → PASS.
- [ ] **Step 5: Commit** — `feat(cli): worktree slack thread`

### Task 8: Agent skill and architecture docs

**Files:**
- Modify: `internal/agentskill/skills/worktree/SKILL.md`
- Modify: `docs/web-ui-architecture.md` ("Search": new "CLI" subsection; `GET /api/all-resources` row gains `archived`)
- Modify: `.claude/CLAUDE.md` (the `webui` bullet's list of read methods gains `Search`, `ArchivedResources`, `SlackThread`, `SlackThreadMessages`)

- [ ] **Step 1: Add the "Finding things" section** to SKILL.md with the six steps from the spec's "Agent skill" section, including: terms are ANDed substrings; map time words to `--since`, source words to `--source`, "here" to `--worktree .`; try `--archived` when nothing turns up; group event hits by `resource`; list Slack candidates with `slack thread <ref> --json` (channel, custom name/title, author, first message, started, updated) and ask; **never run `--messages` until the user says to, even for one candidate**; exit 2 with `"ambiguous": true` is a candidate list; warn when `complete` is false. Add a "Find X" bullet under Drill-downs pointing at the section, and a line under "Reading output" that `slack thread` prints Slack timestamps as RFC 3339 (`started_at`, `updated_at`).
- [ ] **Step 2: Update the two docs.**
- [ ] **Step 3: Verify.** `go test ./cmd/ ./internal/agentskill/...` → PASS; `go run . agent-help | grep -c "slack thread"` → ≥ 1.
- [ ] **Step 4: Commit** — `docs(skill): find things with search; read Slack threads only on request`

### Task 9: "Include archived" in the home page's search dropdown

**Files:**
- Create: `ui/src/hooks/useHomeArchived.ts` (or a context in `HomePage.tsx`; one source of truth either way)
- Create: `ui/src/components/search/ArchivedResourceModal.tsx` + test
- Modify: `ui/src/components/ActivityPanel.tsx` (read/write the shared state instead of local `useState`)
- Modify: `ui/src/components/search/SearchBar.tsx` / `SearchSuggestions.tsx` (optional `archivedToggle?: { value: boolean; onChange: (v: boolean) => void }` prop rendered as an `ArchivedToggle` at the top of the dropdown)
- Modify: `ui/src/components/search/suggestions.ts` (resource rows marked archived)
- Modify: `ui/src/pages/HomePage.tsx`
- Modify: `ui/src/hooks/useAllResources.ts` (an `useArchivedResources(enabled)` query, key `["resources", "__archived__"]`)
- Modify: `docs/web-ui-architecture.md` ("Search": the shared state and the dropdown toggle)
- Tests: `ui/src/pages/HomePage.test.tsx` or the nearest existing home-page/search test file, `suggestions.test.ts`

**Interfaces:**
- Consumes: `api.allResources({ archived: true })` (Task 3), `api.tasks(scope, { completed: true, archived: true })`, `FollowInWorktreeMenu`, `followResourceState`, `AllResourceRow`.
- Produces: `useHomeArchived(): [boolean, (v: boolean) => void]` — page state, not persisted. With it on, `buildSuggestions` receives archived resources (from `useArchivedResources`, filtered to `archived`) appended to the resource list, and archived tasks (from a `useTasks({kind: "all"}, {completed: true, archived: true})` query enabled only while on, filtered to `t.archived`) appended to the tasks. Picking an archived resource opens `ArchivedResourceModal`: the resource row (`AllResourceRow`), "Last followed in <worktree>" lines, an "Open" link to its URL, and `FollowInWorktreeMenu` whose pick navigates exactly as `EventDetailsModal.followIn` does. Worktree page: no toggle (prop not passed).

- [ ] **Step 1: Write tests:** toggling the dropdown's switch flips the Activity panel's `Include archived` and vice versa; with it on, an archived resource and an archived task appear in suggestions and the resource row reads "archived"; picking the resource opens the modal with a Follow menu; with it off neither appears; the worktree page's dropdown has no toggle.
- [ ] **Step 2: Run.** `cd ui && npx vitest run <those files>` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd ui && npx vitest run && npx tsc --noEmit && npx eslint src` → PASS, no errors.
- [ ] **Step 5: Verify in the browser** with `make dev`: on the home page, type a term matching an archived resource, flip the dropdown toggle, confirm the Activity panel's toggle follows, pick the resource, confirm the modal. (Do not kill any mprocs process; stop only what you started, by PID.)
- [ ] **Step 6: Commit** — `feat(ui): Include archived in the search dropdown, reaching archived resources and tasks`

### Task 10: README — BLOCKED until Mike says his README rewrite is merged

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Wait** for Mike's explicit go-ahead that his README rewrite has merged. Do not read or edit `README.md` before then.
- [ ] **Step 2: Read the README as it is then** and add a section featuring "ask your agent" search, adapted to its structure, using a handful of the spec's acceptance examples (Slack, GitHub, Jira, across sources) and showing `worktree search` and `worktree slack thread` briefly.
- [ ] **Step 3: Commit** — `docs(readme): feature CLI and agent search`

### Final verification (after Task 9; Task 10 may come later)

- [ ] `make test` → PASS.
- [ ] `go test -race -timeout 40m ./internal/webui/` → PASS.
- [ ] `make build && ./bin/worktree search inferencepool --json | head -40` and `./bin/worktree slack thread <a real thread custom name> --json` against Mike's DB: sensible output, no bodies in search, summary only without `--messages`.
