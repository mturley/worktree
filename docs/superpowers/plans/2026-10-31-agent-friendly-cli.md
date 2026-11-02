# Agent-friendly CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worktree CLI answer "what deserves my attention?" and the other questions the web UI answers, with stable JSON, and ship a cross-agent skill that teaches agents to use it.

**Architecture:** The CLI already reuses web UI logic by building a headless `&webui.Server{DB: conn}` and calling exported methods (`cmd/unread.go` → `Server.AppUnread`). This plan extends that pattern: each HTTP handler's core moves into an exported `Server` method that returns data, the handler becomes a thin wrapper, and a new cobra command calls the same method. Ranking signals live in a new pure package `internal/attention`. Two small watcher library additions ship first as one release.

**Tech Stack:** Go, cobra, SQLite (watcher schema), `github.com/mturley/watcher`, `embed`.

**Spec:** `docs/superpowers/specs/2026-10-31-agent-friendly-cli-design.md`

**Repos:** worktree at `~/.worktrees/worktree/agent-friendly-cli` (branch `agent-friendly-cli`); watcher library at `~/git/watcher` (Task 1); agent-handler at `~/git/agent-handler` (Task 3).

## Global Constraints

- Every JSON output is an object with `"schema_version": 1` and named snake_case fields, never a bare array.
- No read command writes to any DB table, and none contacts GitHub/Jira/Slack, except `pr-threads` and `linked`, which check `s.WatcherEnabled(config.Service…)` first and refuse with `setup.WatcherOffMessage(svc)` when off.
- The CLI never calls Slack's `subscriptions.thread.mark`; mark-read skips Slack resources.
- Exit codes: 0 success; 1 "nothing found" only for `attention` and `activity --unread`; 2 for every error. `unread` exits 0 when nothing is unread (the menu bar app needs it).
- No ANSI escape codes when stdout is not a terminal or `NO_COLOR` is set (non-empty).
- Queries that mean "followed by a worktree" restrict to `subscriber LIKE 'worktree:%'`; subscriber keys go through `wdb.Subscriber`.
- Tests: new top-level tests in `internal/webui` call `t.Parallel()` first unless they set env or package globals; git fixtures come from `testgit`; run `go test -race ./internal/webui/` after touching it.
- Watcher library changes follow `CLAUDE.md` "cross-repo coordination": change + test in `~/git/watcher`, tag, push `main` and the tag, re-pin with `go get … && go mod tidy`.
- Staleness threshold: 15 minutes since a service's last successful poll.
- Commits use `--signoff` and end with the `Co-Authored-By` / `Claude-Session` trailers.

## Review Focus

1. **A worktree directory deleted out-of-band** (registered, not on disk): `list --json` must still list it with `on_disk: false`, `--git` must not fail the whole command, and `attention` must still include its resources. Test in Task 6.
2. **A resource never polled** (no `watcher_resource_state` row): every command must emit it with empty state fields, and `attention` must neither crash nor invent signals for it. Test in Task 9.
3. **A watcher turned off with old cached data present**: `status` reports it `enabled: false` and never stale-warns about it; `attention` still uses its cached state; `pr-threads` refuses. Tests in Tasks 7 and 12.
4. **Piped output from a command that previously colored** (`list`, `info`, `ports`, cmux color dots): no `\x1b[` bytes. Test in Task 2.
5. **An agent running a read command while `worktree ui` is polling**: reads take no write locks. Covered by the constraint above; the reviewer checks that no new code path calls `unread.EnsureCursor`, `selfid.Set`, `notes.Set` or any `watcherdb.Record*` from a read command.

---

### Task 1: Watcher library — priority rank, requested reviewers, unregister consumer (v0.21.0)

Work in `~/git/watcher`.

**Files:**
- Modify: `jira/client.go` (add `FetchPriorityOrder`, `FetchGlobalPriorities`), `jira/poller.go` (`buildJiraStateJSON`, poller run)
- Modify: `github/graphql.go` (`PRData`, the PR query), `github/poller.go` (`buildPRStateJSON`)
- Modify: `config/config.go` (add `UnregisterConsumer`)
- Test: `jira/poller_test.go`, `jira/client_test.go`, `github/poller_test.go`, `config/config_test.go`

**Interfaces:**
- Produces: Jira state JSON key `priority_rank` (int, 0 = highest; key absent when no order could be fetched or the priority isn't in it).

**Why editmeta (verified 2026-10-31 against redhat.atlassian.net, read-only):** `GET /rest/api/3/priority` (deprecated, still 200) and `GET /rest/api/3/priority/search` both return the instance-wide list, which mixes every priority scheme: it starts `Highest (migrated), High (migrated), …, Nice to, Blocker, Urgent, Critical, …`, so a global index ranks "Highest (migrated)" above "Blocker". `GET /rest/api/3/issue/{key}/editmeta` returns `fields.priority.allowedValues` in the issue's own project scheme order: for RHOAIENG it is `Blocker, Critical, Major, Normal, Minor, Undefined`. editmeta needs edit permission on the issue; when `fields.priority` is absent, fall back to the global list's index, which keeps each scheme's relative order but isn't comparable across schemes. PR state JSON key `requested_reviewer_ids` ([]string of decimal user databaseIds; teams ignored; `[]` when none). `func (c *Config) UnregisterConsumer(name string)`.

- [ ] **Step 1: Write failing tests**
  - `TestFetchPriorityOrderEditmeta`: httptest server returns `{"fields":{"priority":{"allowedValues":[{"name":"Blocker"},{"name":"Critical"},{"name":"Major"},{"name":"Normal"},{"name":"Minor"},{"name":"Undefined"}]}}}` at `/rest/api/3/issue/RHOAIENG-1/editmeta`; assert `FetchPriorityOrder("RHOAIENG-1")` returns `map[string]int{"Blocker":0,"Critical":1,"Major":2,"Normal":3,"Minor":4,"Undefined":5}, true`.
  - `TestFetchPriorityOrderNoPermission`: editmeta returns `{"fields":{}}` → `nil, false, nil`.
  - `TestFetchGlobalPriorities`: `/rest/api/3/priority` returns `[{"name":"Highest (migrated)"},{"name":"Blocker"}]` → `{"Highest (migrated)":0,"Blocker":1}`.
  - `TestPollerRanksOncePerProject`: two RHOAIENG issues and one OTHER issue in one poll → editmeta called once for RHOAIENG and once for OTHER; global list fetched only when an editmeta returned no priority field.
  - `TestBuildJiraStateJSONPriorityRank`: issue priority `"Major"` with ranks above → JSON has `"priority_rank":2`; with a nil rank map → no `priority_rank` key.
  - `TestBuildPRStateJSONRequestedReviewers`: `PRData.RequestedReviewerIDs = []string{"123","456"}` → JSON `"requested_reviewer_ids":["123","456"]`; nil → `[]`.
  - `TestUnregisterConsumer`: register `worktree` and `handler`, unregister `worktree` → `Consumers()` has only `handler`; unregistering an absent name is a no-op.
- [ ] **Step 2: Run** `go test ./jira/ ./github/ ./config/` — expect the four tests to FAIL (undefined symbols).
- [ ] **Step 3: Implement**
  - `func (c *Client) FetchPriorityOrder(issueKey string) (map[string]int, bool, error)` — editmeta; rank = index in `allowedValues`; `ok=false` when the field is absent.
  - `func (c *Client) FetchGlobalPriorities() (map[string]int, error)` — `GET /rest/api/3/priority`; rank = array index.
  - The Jira poller keeps a per-run `map[project]map[string]int` (project = key prefix before `-`), filled by the first issue of each project; the global list is fetched at most once per run, lazily. It passes the project's map to `buildJiraStateJSON(issue, ranks map[string]int)`. Any fetch error logs and passes nil (rank omitted, poll continues).
  - Add `reviewRequests(first: 50) { nodes { requestedReviewer { ... on User { databaseId } } } }` to the PR query; fill `PRData.RequestedReviewerIDs []string`.
  - `UnregisterConsumer` deletes the map entry.
- [ ] **Step 4: Run** `go test ./...` — expect PASS.
- [ ] **Step 5: Commit, tag, push**
```bash
git add jira/client.go jira/poller.go github/graphql.go github/poller.go config/config.go jira/client_test.go jira/poller_test.go github/poller_test.go config/config_test.go
git commit --signoff -m "feat: Jira priority_rank, PR requested_reviewer_ids, UnregisterConsumer"
git tag v0.21.0 && git push origin main && git push origin v0.21.0
```
- [ ] **Step 6: Re-pin in worktree** — in the worktree repo: `go get github.com/mturley/watcher@v0.21.0 && go mod tidy && go test ./internal/webui/ -run TestSettingsModalCoversEveryConfigKey`. Expect PASS (no config keys changed). Commit `go.mod go.sum` with message `chore: re-pin watcher v0.21.0`.

---

### Task 2: No colors when piped

**Files:**
- Modify: `internal/ui/ui.go`, `internal/cmux/cmux.go:333`, `cmd/root.go`
- Test: `internal/ui/ui_test.go`, `cmd/root_test.go`

**Interfaces:**
- Produces: `func ui.SetColor(on bool)`, `func ui.ColorEnabled() bool`, `func ui.ColorWanted(isTTY bool, getenv func(string) string) bool`. Every `ui.Bold/Dim/Red/Green/Yellow/Blue/Cyan` returns its input unchanged while color is off.

- [ ] **Step 1: Write failing tests**
  - `TestColorWanted`: `(true, NO_COLOR="")` → true; `(true, NO_COLOR="1")` → false; `(false, "")` → false.
  - `TestHelpersPlainWhenColorOff`: `SetColor(false)`; `Bold("x") == "x"`, same for every helper; `SetColor(true)` restores escapes (restore in `t.Cleanup`; test stays serial).
  - In `cmd/root_test.go`, `TestListOutputHasNoEscapesWhenPiped`: run the root command's `list` into a buffer after `PersistentPreRun` with a non-TTY stdout, assert `!bytes.Contains(out, []byte("\x1b["))`.
- [ ] **Step 2: Run** `go test ./internal/ui/ ./cmd/` — FAIL.
- [ ] **Step 3: Implement.** A package-level atomic bool (default true) in `ui`. Add `ui.SetColor(ui.ColorWanted(term.IsTerminal(int(os.Stdout.Fd())), os.Getenv))` as the first line of the existing `rootCmd.PersistentPreRun` (`cmd/root.go:39`; it is the only `PersistentPreRun` in `cmd/`). The color dot in `cmux.go:333` returns `"●"` when `!ui.ColorEnabled()`. Replace the help func's local `term.IsTerminal` check with `ui.ColorEnabled()`.
- [ ] **Step 4: Run** `go test ./internal/ui/ ./internal/cmux/ ./cmd/` — PASS.
- [ ] **Step 5: Commit** — `feat(cli): no ANSI colors when piped or NO_COLOR is set`.

---

### Task 3: JSON envelope, exit codes, root `--as-agent`, agent-handler update

**Files:**
- Create: `cmd/output.go`
- Modify: `cmd/root.go` (`Execute`), `cmd/resources.go`, `cmd/tasks.go`, `cmd/tasks_json.go`, `cmd/tasks_blockers.go`, `cmd/unread.go`, `main.go`
- Modify (other repo): `~/git/agent-handler/worktreeinterop/cli.go` and its test
- Test: `cmd/output_test.go`, `cmd/resources_test.go`, `cmd/tasks_test.go`

**Interfaces:**
- Produces:
  - `const SchemaVersion = 1`
  - `func printJSON(w io.Writer, fields map[string]any) error` — writes `{"schema_version":1, …fields}` and a newline; a `schema_version` key in `fields` is overwritten.
  - `var ErrNothingFound = errors.New("nothing found")` — a `RunE` returns it for exit 1, after printing its own (empty) output.
  - `func Execute() int`; `main` calls `os.Exit(cmd.Execute())`. Returns 0 on nil, 1 on `ErrNothingFound` (printing nothing to stderr), and 2 otherwise (printing the error).
  - Root persistent flag `--as-agent` (the variable `asAgent bool` in `cmd/root.go`); `tasksAsAgent` is deleted and `actorFromEnv(asAgent, os.Getenv)` reads the root flag.
- JSON shapes: `resources list --json` → `{"schema_version":1,"resources":[…]}`; `tasks list --json` → `{"schema_version":1,"tasks":[…]}`; `tasks show --json` → `{"schema_version":1,"task":{…}}`. The tasks helper `writeJSON` (`cmd/tasks_json.go:107`) becomes `writeJSON(w io.Writer, key string, v any)`: when `v` is a `map[string]any`, its entries are merged at top level with `schema_version` (`key` is ""); otherwise the output is `{"schema_version":1, key: v}`. Keys at each current call site: `tasks.go:351` → `"tasks"`; every site writing a `taskJSON` (`tasks.go:262, 394, 457, 522`) → `"task"`; `tasks.go:842` → `"subtask"`; `tasks_blockers.go:145` → `"blocker"`; the map sites (`tasks.go:578, 910`, `tasks_blockers.go:165, 186`) → merged; `unread --json` → `{"schema_version":1,"unread":…,"count":…}`.

- [ ] **Step 1: Write failing tests**
  - `TestPrintJSONEnvelope`: `printJSON(&b, map[string]any{"x":1})` decodes to `schema_version==1, x==1`.
  - `TestExecuteExitCodes`: commands returning nil / `ErrNothingFound` / `errors.New("boom")` → 0 / 1 / 2.
  - Update the existing resources and tasks JSON tests to decode the envelope. Add `TestAsAgentIsRootFlag`: `worktree resources list --as-agent --json` parses without error.
- [ ] **Step 2: Run** `go test ./cmd/` — FAIL.
- [ ] **Step 3: Implement** the interfaces above. Writes outside `tasks` accept `--as-agent` and do nothing with it: there is no actor column for resources or notes, and the spec allows this.
- [ ] **Step 4: Run** `go test ./cmd/` — PASS.
- [ ] **Step 5: Update agent-handler.** In `~/git/agent-handler/worktreeinterop/cli.go`, `listAll` decodes `struct{ Resources []Resource \`json:"resources"\` }` instead of a bare array. Update its test fixture to the envelope. Run `go test ./...` there and expect PASS. Commit there: `fix(worktreeinterop): read worktree's enveloped resources list JSON`. Push only after asking Mike.
  The menu bar app needs no change: `internal/macapp/app/UnreadWatch.swift:72-73` requires exit 0 and reads the output with `JSONSerialization` into `[String: Any]`, so the extra key is ignored (verified).
- [ ] **Step 6: Commit** worktree — `feat(cli): schema_version JSON envelope, exit codes, root --as-agent`.

---

### Task 4: Headless read methods on `webui.Server`

Moves handler cores into exported methods so the CLI can call them. No behavior change for HTTP.

**Files:**
- Modify: `internal/webui/worktrees.go`, `all_resources_api.go`, `resources_api.go`, `watchers_api.go`, `listeners.go`
- Create: `internal/webui/headless.go` (aliases and doc comment)
- Test: `internal/webui/headless_test.go`

**Interfaces:**
- Produces (in `headless.go`): `type ResourceDTO = resourceDTO`, `type WorktreeSummary = worktreeSummary`, `type AllResource = allResourceDTO`, `type WatcherStatus = watcherStatusDTO`.
- Produces methods:
  - `func (s *Server) WorktreeSummaries() ([]WorktreeSummary, error)` — the body of `handleWorktrees`.
  - `func (s *Server) AllResources() ([]AllResource, error)` — the body of `handleAllResources`.
  - `func (s *Server) WorktreeResources(path string) ([]ResourceDTO, error)` — the body of `handleWorktreeResources`, with DTOs filled by the unread index.
  - `func (s *Server) WatcherStatuses() []WatcherStatus` — the loop in `handleWatchers`.
  - `func (s *Server) ScanListeners(ctx context.Context) (listeners.Snapshot, error)` — rename `scanListeners` (update the `listenersScan` reference).
- Add to `allResourceDTO`, both JSON-visible: `PriorityRank *int \`json:"priority_rank,omitempty"\`` and `RequestedReviewerIDs []string \`json:"-"\`` on `resourceDTO`, filled in `enrichResourceDTO` from the Task 1 keys. The reviewer IDs are never sent, like `authorID`.

- [ ] **Step 1: Write failing tests** (parallel): `TestWorktreeSummariesHeadless` and `TestAllResourcesHeadless` build `&Server{DB: db}` over a fixture with one worktree following one Jira issue whose cached state is `{"priority":"Critical","priority_rank":1}`, and assert the summary and resource fields, including `PriorityRank == 1`. `TestEnrichRequestedReviewers`: a PR state with `requested_reviewer_ids:["9"]` fills `RequestedReviewerIDs`.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run 'Headless|RequestedReviewers'` — FAIL.
- [ ] **Step 3: Implement.** Each handler becomes: call the method, `writeError` on error, `writeJSON` the result.
- [ ] **Step 4: Run** `go test -race ./internal/webui/` — PASS, existing handler tests unchanged.
- [ ] **Step 5: Commit** — `refactor(webui): headless read methods for the CLI`.

---

### Task 5: Timeline query method

**Files:**
- Modify: `internal/webui/timeline.go`
- Test: `internal/webui/timeline_query_test.go`

**Interfaces:**
- Produces:
```go
type TimelineQuery struct {
    WorktreePath  string   // "" = every worktree (global timeline)
    ResourceType  string   // with ResourceID; both or neither
    ResourceID    string
    ResourceTypes []string // "pr","jira","slack","link","task"; empty = all
    Since         string   // RFC 3339, inclusive; "" = no floor (new)
    Before        string   // RFC 3339, exclusive cursor
    UnreadOnly    bool
    Limit         int      // 0 = defaultTimelineLimit
}
func (s *Server) Timeline(q TimelineQuery) ([]TimelineEvent, error)
```
  The global path is `handleGlobalTimeline`'s core; the worktree path is `handleWorktreeTimeline`'s. Both handlers build a `TimelineQuery` and call `Timeline`. `Since` adds `AND e.ts >= ?` (global) or a skip (worktree path) and is applied to task events too.

- [ ] **Step 1: Write failing tests** (parallel): `TestTimelineSince` (three events at t0 < t1 < t2, `Since=t1` returns t2 and t1); `TestTimelineWorktreeScope` (an event on a resource followed only by another worktree is excluded); `TestTimelineUnreadOnly` (an event before the cursor is excluded); `TestTimelineResourceFilter`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/webui/` — PASS.
- [ ] **Step 5: Commit** — `refactor(webui): Timeline query method with Since`.

---

### Task 6: `list --json`, `info` and `info --json`, `ports --json`, `jira --json`, `resources list --all`

**Files:**
- Modify: `cmd/list.go`, `cmd/info.go`, `cmd/ports.go`, `cmd/jira.go`, `cmd/resources.go`
- Create: `cmd/headless.go` — `func headlessServer(conn *sql.DB) (*webui.Server, error)`, which loads config and calls `SetWatchersDisabled` from `cfg.Watchers.Enabled`, the same way `cmd/ui.go:141-145` does
- Test: `cmd/list_test.go`, `cmd/info_test.go`, `cmd/resources_test.go`

**Interfaces:**
- Consumes: Task 4 methods; Task 3 `printJSON`.
- `list --json` → `{"schema_version":1,"worktrees":[WorktreeSummary + "open_in_cmux": bool + "git": {...} when --git]}`. `git` = `{"branch","upstream","ahead","behind","dirty"}` from the existing `gitBranch`/`gitTrackingInfo` helpers, refactored to return values. On a worktree that isn't on disk, `git` is omitted.
- `info [path] --json` → `{"schema_version":1,"worktree":{path, branch, upstream, ahead, behind, env: {NAME: value}, resources: [ResourceDTO]}}`. Text `info` prints each resource's cached state after its id (PR: state, review decision, CI; Jira: status, priority). `--local` is deleted.
- `ports --json` → `{"schema_version":1,"allocations":[{"name","start","end"}]}`.
- `jira` today fetches each issue live from Jira (`cmd/jira.go:44-54`, `jira.NewClient` + `FetchIssue`), without checking the watcher toggle. It switches to the cached state from `WorktreeResources(path)` filtered to `type == "jira"`, like `info`, so it never contacts Jira. Text output stays one line per issue (key, status, priority, summary). `jira --json` → `{"schema_version":1,"issues":[ResourceDTO]}`. `jira add`/`jira remove` are unchanged.
- `resources list --json` items become `ResourceDTO` (a superset of today's fields: `type,id,url,primary,custom_name,custom_description,updated_at,unread_count` keep their names). `--all` → `AllResources()`; it is mutually exclusive with `--worktree`.

- [ ] **Step 1: Write failing tests**: `TestListJSONShape` (fixture of two worktrees, one deleted from disk → `on_disk:false`, no error); `TestListJSONGitFlag` (with `--git`, an on-disk worktree has `git.branch`); `TestInfoJSONCachedState` (Jira resource with cached `priority:"Critical"` → `resources[0].priority`); `TestResourcesListAll` (one resource followed by two worktrees appears once with two `worktrees`).
- [ ] **Step 2: Run** `go test ./cmd/` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./cmd/` — PASS. Run `go run . list --json | jq .schema_version` → `1`.
- [ ] **Step 5: Commit** — `feat(cli): --json on list, info, ports, jira; resources list --all`.

---

### Task 7: `worktree status`

**Files:**
- Create: `cmd/status.go`, `cmd/status_test.go`

**Interfaces:**
- Consumes: `Server.WatcherStatuses()`, `serverAlreadyListening(port)` from `cmd/ui.go`, and `config.Load()`.
- Output `--json`: `{"schema_version":1,"ui_running":bool,"ui_url":"http://127.0.0.1:<port>","stale":bool,"services":[{"name","enabled","last_success","error","stale"}]}`. A service is `stale` when enabled and (`last_success` is empty or older than 15 minutes). The top-level `stale` = `!ui_running || any service stale`. Text mode prints one line per service and, when `stale`, the hint `Start \`worktree ui\` so the watchers poll; activity below may be out of date.`
- `func staleness(now time.Time, lastSuccess string, enabled bool) bool` (pure, tested).

- [ ] **Step 1: Write failing tests**: `TestStaleness` table: disabled → false; empty → true; 14m ago → false; 16m ago → true; unparseable → true. `TestStatusJSONDisabledService`: config with `watchers.slack: false` → slack `enabled:false, stale:false`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./cmd/` — PASS.
- [ ] **Step 5: Commit** — `feat(cli): worktree status — UI running, last poll, staleness`.

---

### Task 8: `worktree activity`

**Files:**
- Create: `cmd/activity.go`, `cmd/activity_test.go`

**Interfaces:**
- Consumes: `Server.Timeline(TimelineQuery)` (Task 5), `ErrNothingFound`, `printJSON`, and `resourceurl` to parse `--resource`.
- Flags: `--worktree <path>`; `--resource <url|type:id>`; `--since <dur|RFC3339>` (a duration means now minus it); `--unread`; `--source github|jira|slack|tasks` (repeatable; github→`pr`, jira→`jira`, slack→`slack`, tasks→`task`); `--limit` (default 50); `--json`.
- `--json` → `{"schema_version":1,"events":[TimelineEvent]}`. Text: `<local time>  <source>  <resource label>  <author>: <title>` with a `•` prefix on unread.
- `func parseSince(now time.Time, v string) (string, error)` (pure).
- Returns `ErrNothingFound` after printing when `--unread` is set and there are no events.

- [ ] **Step 1: Write failing tests**: `TestParseSince` (`"24h"` → now−24h in RFC 3339; an RFC 3339 value passes through; `"x"` → error); `TestActivityUnreadEmptyExit1`; `TestActivitySourceMapping`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./cmd/` — PASS.
- [ ] **Step 5: Commit** — `feat(cli): worktree activity`.

---

### Task 9: `internal/attention` and `worktree attention`

**Files:**
- Create: `internal/attention/attention.go`, `internal/attention/attention_test.go`
- Create: `internal/webui/attention.go` (gathers input), `internal/webui/attention_test.go`
- Create: `cmd/attention.go`, `cmd/attention_test.go`

**Interfaces:**
- `internal/attention` (pure, no DB):
```go
type Resource struct {
    Type, ID, URL, Title, CustomName string
    Worktrees     []string // paths
    State, ReviewDecision, CIStatus string // PR
    Mine          bool                    // PR author or Jira assignee is self
    AssignedToMe  bool                    // Jira
    ReviewRequestedFromMe bool            // PR, from RequestedReviewerIDs
    Status, Priority string; PriorityRank *int // Jira
    UnreadCount   int; NewestUnreadTS string
    Unread        []Event // newest first, all unread events
    Tasks         []Task
    DraftComments int // this PR's worktree's unposted review comments
}
type Event struct{ ID, TS, Source, Type, Author, Title, Body string }
type Task struct{ ID, Title, State, Priority, Due string }
type OpenTask struct {
    Task
    Worktrees         []string // linked + implicit
    UnblockedUnread   bool     // an unread automatic blocker resolution
}
type Item struct {
    Kind     string    `json:"kind"`               // "resource" | "task"
    Resource *Resource `json:"resource,omitempty"` // Kind == "resource"
    Task     *OpenTask `json:"task,omitempty"`     // Kind == "task"
    Signals  []string  `json:"signals"`
    Rank     *int      `json:"priority_rank,omitempty"` // effective
    Events   []Event   `json:"events"`                  // up to 5
}
func Build(now time.Time, self Self, rs []Resource, ts []OpenTask, linkedJira map[string][]int) []Item
type Self struct{ SlackID string }
```
  `linkedJira` maps a PR key (`pr:<id>`) to the priority ranks of Jira issues sharing a worktree with it; a PR's effective rank is the minimum of its own (none) and those. Signals, exactly these names: `review_requested` (ReviewRequestedFromMe && strings.EqualFold(State,"open")), `changes_requested` (Mine && ReviewDecision=="CHANGES_REQUESTED"), `ci_failing` (Mine && CIStatus=="FAILURE", the value watcher's `deriveCIStatus` returns), `assigned_to_you` (AssignedToMe && UnreadCount>0), `mentioned` (an unread Slack event body contains `"<@"+self.SlackID+">"`; verified: stored Slack bodies keep `<@UXXXX>`), and `stale_draft` (DraftComments>0). Resource items with no signals and UnreadCount==0 are dropped.

  **Task items** (my call: a due or newly unblocked task deserves attention even with no resource, e.g. "Compliance Training, due 2026-11-06"): one per open task with at least one of `task_due_soon` (Due, a `YYYY-MM-DD` date, is within 3 days of now in local time, or past) or `blocker_resolved` (UnblockedUnread). A task's rank: priority high→1, medium→2, low→3, none→nil, which lines up with a typical Jira scheme's Critical/Major/Normal. Order (both kinds together): effective rank ascending (nil last), then len(Signals) descending, then the newest unread time descending (a task item uses its updated_at), then Kind+Type+ID.
- `func (s *Server) AttentionInput(worktreePath string) ([]attention.Resource, []attention.OpenTask, map[string][]int, attention.Self, error)` — from `AllResources()` (filtered to resources the worktree follows when the path is non-empty), `Timeline{UnreadOnly:true, Limit:500}`, `tasks` open links, `reviewcomments.List` per worktree, and `selfid.Load` (sources `github`, `jira`, `slack`). Open tasks come from the same load `openTaskCountsPriming` uses; `UnblockedUnread` = some event from `tasks.FeedEvents(conn, tasks.FeedQuery{UnreadActorsOnly: true, SinceTS: <task cursor>})` passes `isUnblockEvent` (`notify_unblock.go:61`) and is newer than the task's cursor (`unread.Cursors`, key `unread.Key("task", id)`). `Mine` reuses `isMine`; `ReviewRequestedFromMe` = the self GitHub ID is in `RequestedReviewerIDs`.
- `worktree attention [--worktree <path>] [--json]`: the default scope is every worktree (my call, per the spec). `--json` → `{"schema_version":1,"items":[Item],"status":{…same as status --json…}}` so one call carries the staleness. Text: one block per item: `[rank name] <title>  <signals>` then up to 3 event lines. Returns `ErrNothingFound` when there are no items.

- [ ] **Step 1: Write failing tests** in `internal/attention`: one test per signal (positive and negative case); `TestTaskItemDueSoon` (due tomorrow → item; due in 5 days → none; overdue → item); `TestTaskRankMapping`; `TestOrderPriorityThenSignalsThenRecency`; `TestPRInheritsLinkedJiraRank`; `TestNeverPolledResourceNoSignals` (Review Focus 2: an empty state with UnreadCount 0 is dropped, and with UnreadCount 2 it is kept with no signals); `TestEventsCappedAtFive`.
- [ ] **Step 2: Run** `go test ./internal/attention/` — FAIL.
- [ ] **Step 3: Implement `Build`.**
- [ ] **Step 4: Write failing `TestAttentionInputScopes`** in webui (parallel): a fixture with two worktrees; the path filter limits the resources; a resource followed only by a `task:` hold is excluded; with a path, only tasks whose `Worktrees` include it are kept.
- [ ] **Step 5: Implement `AttentionInput`**, then `cmd/attention.go`. Add `TestAttentionEmptyExit1` in cmd.
- [ ] **Step 6: Run** `go test ./internal/attention/ ./cmd/ && go test -race ./internal/webui/` — PASS. Smoke test: `go run . attention --json | jq '.items[0]'`.
- [ ] **Step 7: Commit** — `feat(cli): worktree attention`.

---

### Task 10: Unread by scope, bulk mark-read

**Files:**
- Modify: `cmd/unread.go`, `cmd/resources.go` (mark-read), `internal/webui/unread_summary.go`
- Test: `cmd/unread_test.go`, `cmd/resources_test.go`

**Interfaces:**
- `func (s *Server) UnreadBy(by string) (map[string]int, error)` — `by` is `"worktree"` (key = path, value = the same count `WorktreeSummaries` reports) or `"resource"` (key = `type:id`, value = `UnreadCount`, non-zero only).
- `unread --json --by worktree|resource` → `{"schema_version":1,"unread":bool,"count":n,"by":{…}}`. Without `--by`, the shape is unchanged. Always exits 0.
- `resources mark-read` gains `--worktree <path>` (every non-Slack resource the worktree follows) and `--all` (every followed non-Slack resource), each marked through its own `UnreadThroughTS` with `unread.MarkRead`. Mutually exclusive with the positional resource. It prints the count marked and `skipped N Slack thread(s): their read state is Slack's`. The long help explains that the cursor is per resource and shared across worktrees.

- [ ] **Step 1: Write failing tests**: `TestUnreadByWorktree`; `TestUnreadExitZeroWhenNothing`; `TestMarkReadWorktreeSkipsSlack` (a PR and a Slack thread both unread → the PR cursor moves, Slack's state is untouched, the output mentions 1 skipped).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./cmd/ && go test -race ./internal/webui/` — PASS.
- [ ] **Step 5: Commit** — `feat(cli): unread --by, mark-read --worktree/--all`.

---

### Task 11: `notes`, `review-comments list`, `ports --listening`

**Files:**
- Create: `cmd/notes.go`, `cmd/review_comments.go`
- Modify: `cmd/ports.go`; `internal/webui/review_comments_api.go` (export `func (s *Server) ReviewComments(path string) ([]ReviewCommentItem, error)` from `handleListReviewComments`'s core, with alias `type ReviewCommentItem = reviewCommentItem`)
- Test: `cmd/notes_test.go`, `cmd/review_comments_test.go`, `cmd/ports_test.go`

**Interfaces:**
- `notes show [--worktree] [--json]` → `{"schema_version":1,"notes":{"text","sync_cmux","show_on_home"}}` via `notes.Get`. `notes set <text> [--worktree]` (`-` reads stdin) → `notes.Set`, keeping the existing `syncCmux`/`showOnHome` values. It does not push to cmux; the help text says the web UI syncs on its next save.
- `review-comments list [--worktree] [--json]` → `{"schema_version":1,"comments":[ReviewCommentItem]}`; text: `file:line  [current|moved|outdated]  body-first-line`.
- `ports --listening [--json]` → `{"schema_version":1,"allocations":[…],"listeners":Snapshot}` via `Server.ScanListeners`; text adds lines `  :<port>  <command> (pid)  <worktree or "(none)">` with an out-of-range marker.

- [ ] **Step 1: Write failing tests**: `TestNotesShowJSON`; `TestNotesSetKeepsFlags` (set with show_on_home=false stored → still false after `notes set`); `TestReviewCommentsListJSON` (a `testgit.Worktree` fixture with one comment → status `current`); `TestPortsListeningUsesSnapshot` (stub `listeners.Runner` via a package var `listenersRunner` defaulting to `listeners.ExecRunner`; the test stays serial).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./cmd/ && go test -race ./internal/webui/` — PASS.
- [ ] **Step 5: Commit** — `feat(cli): notes, review-comments list, ports --listening`.

---

### Task 12: `pr-threads list`, `linked`

**Files:**
- Create: `cmd/pr_threads.go`, `cmd/linked.go`
- Modify: `internal/webui/pr_comments_api.go` (export `func (s *Server) PRThreads(dir string) (PRThreadsResponse, error)`, the core of `handlePRCommentThreads` with `view == nil`, plus alias `type PRThreadsResponse = prThreadsResponse`), `internal/webui/linked_api.go` (export `func (s *Server) Linked(ctx context.Context, resType, id string, resolveLinks bool) (any, error)`)
- Test: `cmd/pr_threads_test.go`, `cmd/linked_test.go`

**Interfaces:**
- `PRThreads` already reports the watcher toggle through `loadPRComments`' state (`off`, `no_token`, `no_pr`, `error`, `ok`; `pr_comments_api.go:44-48, 187-200`), checked before any token read. The CLI maps them: `off` → print `setup.WatcherOffMessage("github")`, exit 2; `no_token` → print the message, exit 2; `no_pr` → print `no open PR for this worktree's branch`, `ErrNothingFound` (exit 1); `error` → exit 2 with the message.
- `Linked` returns a new exported `ErrWatcherOff{Service string}` when the type's service is off (the check `handleLinkedResources` does now). The handler maps it to the existing `watcherOffError` response; the CLI prints `setup.WatcherOffMessage(svc)` and exits 2.
- `pr-threads list [--worktree <path>] [--all] [--json]` (the worktree's own PR only, as in the diff view) → `{"schema_version":1,"pr":PRThreadsResponse.PR,"threads":[prThreadDTO]}`, open threads only unless `--all`.
- `linked <url|type:id> [--resolve-links] [--json]` → `{"schema_version":1,"linked":<Builder result>}`.

- [ ] **Step 1: Write failing tests**: `TestPRThreadsRefusedWhenGitHubOff` (Review Focus 3: config with `watchers.github:false` → exit 2, message contains `WatcherOffMessage("github")`, and the stubbed `FetchReviewThreads` is never called); `TestLinkedRefusedWhenJiraOff`; `TestPRThreadsJSONOpenOnly` (stub returns one resolved and one open thread → one in the output). The `ghLib` seam and `TestMain` already keep tests off GitHub; cmd tests need the same seam via `Server.FetchReviewThreads`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test ./cmd/ && go test -race ./internal/webui/` — PASS.
- [ ] **Step 5: Commit** — `feat(cli): pr-threads list, linked (live, gated on watcher toggles)`.

---

### Task 13: The skill — content, `agent-help`, setup install/update/uninstall, consumer unregister

**Files:**
- Create: `internal/agentskill/SKILL.md` (embedded), `internal/agentskill/agentskill.go`, `internal/agentskill/agentskill_test.go`
- Create: `cmd/agent_help.go`
- Create: `internal/setup/agentskill.go`, `internal/setup/agentskill_test.go`
- Modify: `internal/setup/setup.go` (`Plan`, `BuildPlan`, `Preview`, `Execute`, `PreviewUninstall`, `ExecuteUninstall`), `cmd/setup.go` (`runUninstall`: unregister the watcher consumer)

**Interfaces:**
- `agentskill`: `//go:embed SKILL.md` → `var Content []byte`; `func Hash() string` (sha256 hex of Content); `type Target struct{ Dir string; Symlink bool }`; `func Targets(home string, getenv func(string) string, exists func(string) bool, realpath func(string) (string, error)) []Target`. The canonical copy is `Target{Dir: home+"/.agents/skills/worktree"}`, which Codex and pi read directly. Symlink targets `<d>/worktree` for each `d` in [`$CLAUDE_CONFIG_DIR/skills` when the variable is set, `~/.claude/skills`] that exists, deduplicated by `realpath(d)` (Mike's `~/.claude-personal/skills` and `~/.claude/skills` share content through symlinks, so one link must not be made twice). Put this comment next to `Targets`, verified 2026-10-31:
  - Codex reads `$HOME/.agents/skills` at user scope and follows symlinked skill folders (developers.openai.com/codex/skills → learn.chatgpt.com/docs/build-skills).
  - pi (≥ 1.3.0) reads `~/.agents/skills/` (`@earendil-works/pi-coding-agent` docs/skills.md).
  - Claude Code reads only `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) at user scope, hence the symlinks.
- Install never overwrites: if a symlink target path already exists and isn't a symlink to the canonical dir, it is left alone and setup prints `~/.claude/skills/worktree exists and isn't worktree's; leaving it`.
- The installed copy gets a `.worktree-skill-hash` file beside `SKILL.md` holding `Hash()` at install time.
- `setup`: `Plan.AgentSkill AgentSkillAction` with `AgentSkillNone | AgentSkillOfferInstall | AgentSkillUpdate | AgentSkillEditedSkip`, decided by pure `decideAgentSkill(installed bool, installedHash, fileHash, embeddedHash string, nonInteractive bool) AgentSkillAction`:
  - not installed + interactive → OfferInstall ("Install the worktree skill for AI agents (Claude Code, Codex, pi…)?", default yes); not installed + non-interactive → None
  - installed, the file's hash equals the recorded hash, and the recorded hash differs from the embedded one → Update (silent)
  - the file's hash differs from the recorded hash (the user edited it) → EditedSkip, which prints `skill edited; not updating (delete it to get the new version)`
- Uninstall: `PreviewUninstall` lists the canonical dir and each symlink that points at it. `ExecuteUninstall` removes the symlinks first (only ones whose `os.Readlink` target is the canonical dir), then the canonical dir. An edited copy is still removed, and the preview notes `(edited)`. `runUninstall` also loads the watcher config, calls `UnregisterConsumer(consumerName)`, and saves; the preview line is `• Unregister worktree's database from the watcher config`.
- Audit: after this task, every step in `Plan.Execute` is either undone by `ExecuteUninstall` or listed among the "Preserve …" preview lines. Add `TestUninstallCoversEverySetupStep`, which enumerates the `Plan` struct's action fields by reflection against a hand-kept map of `field → "removed" | "preserved: <reason>"` and fails when a field has no entry, so a future setup step can't be added without an uninstall decision.
- `worktree agent-help` prints `agentskill.Content` without the frontmatter.

**SKILL.md content** (write it at about 80–120 lines; the spec's "Content" list is the outline, in this order):
1. frontmatter: `name: worktree`; `description: Use when the user asks about their worktrees, PRs, Jira issues, Slack threads, tasks, unread activity, or "what needs my attention" — answers from the worktree CLI's local database.`
2. Start with `worktree status --json`. If `stale`, tell the user to start `worktree ui` so the watchers poll, then answer from the cache anyway.
3. Attention recipe: `worktree attention --json`. Judge each item's `events` (does it actually need a response?), group a PR with its Jira issue, lead with the lowest `priority_rank`, keep it short, and link URLs.
4. Drill-down recipes: activity since yesterday (standup), `resources list --all --json` (where is X), `list --json --git` (hygiene: merged/closed and not dirty → candidates), `info --json` + `notes show` + `review-comments list` (where did I leave off), `ports --listening`.
5. Always `--json`. Exit 1 means nothing found; 2 is an error.
6. **Never write without the user's explicit permission**, listing the write commands. Always pass `--as-agent`. Read state is shared with the web UI.

- [ ] **Step 1: Write failing tests**: `TestDecideAgentSkill` (table covering every row above); `TestTargetsClaudeConfigDir` (`CLAUDE_CONFIG_DIR=/x` with `/x/skills` existing → symlink target `/x/skills/worktree`; without it → only the canonical one); `TestTargetsDedupesByRealpath` (both skills dirs resolve to the same real path → one symlink target); `TestInstallLeavesForeignEntry`; `TestInstallThenUninstallLeavesNothing` (temp HOME: install creates the dir, hash file and symlink; uninstall removes all three); `TestUninstallLeavesForeignSymlink` (a `~/.claude/skills/worktree` symlink pointing elsewhere survives); `TestUninstallCoversEverySetupStep`; `TestSkillFrontmatter` (Content starts with `---\nname: worktree\n`).
- [ ] **Step 2: Run** `go test ./internal/agentskill/ ./internal/setup/` — FAIL.
- [ ] **Step 3: Write SKILL.md and implement.**
- [ ] **Step 4: Run** `go test ./internal/agentskill/ ./internal/setup/ ./cmd/` — PASS.
- [ ] **Step 5: Commit** — `feat: worktree agent skill, installed and uninstalled by setup`.

---

### Task 14: Docs

**Files:**
- Modify: `.claude/CLAUDE.md` (Project Structure: `attention`, `agentskill`; the headless-method pattern in one paragraph under `webui`), `README.md` (CLI section: new commands, `--json`, the skill), `docs/web-ui-architecture.md` (a note in the timeline and unread sections that the CLI calls the same methods)

- [ ] **Step 1: Edit** the three files. Describe the current state only; don't mention removed things like `--local` (see the "no tests for removed code" preference).
- [ ] **Step 2: Run** `make build && make test` — PASS.
- [ ] **Step 3: Commit** — `docs: agent-friendly CLI`.
