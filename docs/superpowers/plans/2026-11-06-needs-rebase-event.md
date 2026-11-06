# "Needs rebase" PR Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a `pr_needs_rebase` event when a followed PR has merge conflicts, flag it `[out of date] ` when the conflict stops being current, and surface conflict state as a `needs_rebase` attention signal (own PRs) and a `conflicts` badge on PR cards.

**Architecture:** Detection lives in the watcher library's PR poller (`~/git/watcher/github/poller.go`): it fetches `mergeable`, caches it per head SHA, emits/marks events. The CI out-of-date SQL is generalised so both families share it. worktree re-pins the release, reads `mergeable` from cached state into its DTO and attention input, and renders it.

**Tech Stack:** Go (watcher lib, worktree backend), SQLite, GitHub GraphQL; React + Mantine + Vitest (worktree `ui/`).

**Spec:** `docs/superpowers/specs/2026-11-06-needs-rebase-event-design.md`

**Where the work happens (Mike's instruction):** watcher tasks (1-4) commit directly on `main` in `~/git/watcher`. worktree tasks (5-6) happen in a **new worktree + branch** of the worktree repo (e.g. `worktree add needs-rebase-event`), never on worktree's `main`.

## Global Constraints

- Event type string: `pr_needs_rebase`; Go constant `watcher.EventTypePRNeedsRebase`; display name `"needs rebase"`.
- Event title: `Needs rebase: PR #<number> @ <first 7 chars of head SHA>`; tag `commit:<full head SHA>`.
- Out-of-date prefix: exactly the existing `"[out of date] "` (`db/cibundle.go` `outOfDatePrefix`). Title-only; never touch `ts`/`external_ts`.
- `external_ts` of the event = `prData.Commits.LatestDate` (never poll time); `ts` = poll time (what `emitEvent` already does).
- `mergeable` values: `CONFLICTING` | `MERGEABLE` | `UNKNOWN` from GitHub; cached `mergeable` is `""` when unknown for the current head.
- Cached state keys: `mergeable`, `mergeable_sha`.
- Attention signal name `needs_rebase`, only when `Mine && open && Mergeable == "CONFLICTING"`, ordered right after `ci_failing`.
- Card badge text `conflicts`, color `orange`, tooltip `Merge conflicts with the base branch: needs a rebase`.
- Watcher release: `v0.22.0`. Pushing `main` and the tag requires asking Mike first (CLAUDE.md: pushes always need approval).
- Commits: `git commit --signoff`, add files by name, end message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- PR was conflicting, author pushes, GitHub says `UNKNOWN` → cached `mergeable` becomes `""`, old event marked, no new event, no badge/signal. Pinned in Task 3 (`TestProcessPR_NeedsRebase_PushThenUnknown`).
- Cached state written by an older library version (no `mergeable`/`mergeable_sha` keys) → treated as unknown, no marking, no panic. Pinned in Task 1 (`TestResolveMergeable` "legacy state" case) and Task 3.
- Closed/merged PR still reported `CONFLICTING` → no event (Task 3 `TestProcessPR_NeedsRebase_NotOpen`), no badge (Task 6), no signal (Task 5).
- PR with no commits data (`LatestSHA == ""`) → no event (a `commit:` tag would match nothing). Pinned in Task 3 `TestProcessPR_NeedsRebase_NoSHA`.
- Re-marking an already-prefixed event (every poll while superseded) → never double-prefixes. Pinned in Task 2 `TestMarkOutOfDate_Idempotent`.

---

## Watcher library (`~/git/watcher`)

### Task 1: Fetch `mergeable` and cache it per head SHA

**Files:**
- Modify: `github/graphql.go` (PR query alias ~L255 add `mergeable`; `prNode` ~L452 add field; `PRData` ~L23 add field; `parsePRNode` ~L595 copy it)
- Modify: `github/poller.go` (`buildPRStateJSON` ~L766; call site ~L646; new `resolveMergeable`)
- Test: `github/poller_test.go`, `github/graphql_test.go`

**Interfaces:**
- Produces: `PRData.Mergeable string`; `func resolveMergeable(prev map[string]interface{}, prData PRData) string`; `func buildPRStateJSON(prData PRData, mergeable string) string` (adds `"mergeable": mergeable, "mergeable_sha": prData.Commits.LatestSHA`).

- [ ] **Step 1: Write failing tests**

`TestResolveMergeable` (table) in `poller_test.go`, current head `"sha2"`:
| case | prev | prData.Mergeable | want |
|---|---|---|---|
| fresh conflicting | nil | `CONFLICTING` | `CONFLICTING` |
| fresh mergeable | nil | `MERGEABLE` | `MERGEABLE` |
| unknown, no prev | nil | `UNKNOWN` | `""` |
| unknown, same head | `{mergeable: CONFLICTING, mergeable_sha: sha2}` | `UNKNOWN` | `CONFLICTING` |
| unknown, head moved | `{mergeable: CONFLICTING, mergeable_sha: sha1}` | `UNKNOWN` | `""` |
| empty treated as unknown | `{mergeable: MERGEABLE, mergeable_sha: sha2}` | `""` | `MERGEABLE` |
| legacy state | `{latest_commit_sha: sha2}` | `UNKNOWN` | `""` |

`TestBuildPRStateJSON_Mergeable`: unmarshal `buildPRStateJSON(PRData{Commits: CommitInfo{LatestSHA: "sha2"}}, "CONFLICTING")` → `m["mergeable"] == "CONFLICTING"`, `m["mergeable_sha"] == "sha2"`.

In `graphql_test.go`, extend the existing `parsePRNode` test fixture (or add `TestParsePRNode_Mergeable`) with `"mergeable": "CONFLICTING"` → `data.Mergeable == "CONFLICTING"`.

- [ ] **Step 2: Run, expect FAIL** — `go test ./github/ -run 'ResolveMergeable|BuildPRStateJSON_Mergeable|Mergeable'` (compile errors / undefined).

- [ ] **Step 3: Implement.** Add `mergeable` after `reviewDecision` in the query; `Mergeable string \`json:"mergeable"\`` on `prNode`; copy in `parsePRNode`. `resolveMergeable`: return `prData.Mergeable` if `CONFLICTING`/`MERGEABLE`; else return prev `mergeable` only if prev `mergeable_sha == prData.Commits.LatestSHA` (both strings, type-asserted defensively); else `""`. Fix every `buildPRStateJSON` caller (tests included); in `processPRWith` compute `mergeable := resolveMergeable(prevStateMap, prData)` before the state write and pass it.

- [ ] **Step 4: Run** `go test ./...` → PASS.

- [ ] **Step 5: Commit** `feat(github): fetch mergeable and cache it per head commit`.

### Task 2: Generalise the out-of-date marker

**Files:**
- Modify: `db/cibundle.go` (~L162-202)
- Test: `db/cibundle_test.go`

**Interfaces:**
- Produces: `func MarkOutOfDate(conn *sql.DB, commitSHA string, r watcher.Resource, types []watcher.EventType) error` — same SQL as today with the type list parameterised. `MarkCIBundlesOutOfDate(conn, sha, r)` stays as a one-line wrapper passing both CI families (existing callers/tests unchanged).

- [ ] **Step 1: Write failing tests.** `TestMarkOutOfDate_OnlyListedTypes`: insert two events tagged `commit:old` on one resource, types `pr_needs_rebase` and `ci_failed`; `MarkOutOfDate(c, "old", res, []watcher.EventType{watcher.EventTypePRNeedsRebase})` → needs-rebase title starts with `"[out of date] "`, CI title unchanged, both `ts`/`external_ts` unchanged. `TestMarkOutOfDate_Idempotent`: call twice → title has the prefix exactly once. (`EventTypePRNeedsRebase` is added in this task: constant in `eventtype.go` after `EventTypePRNewCommits`, display name `"needs rebase"` in `eventTypeDisplayNames`.)

- [ ] **Step 2: Run, expect FAIL** — `go test ./db/ -run MarkOutOfDate`.

- [ ] **Step 3: Implement** `MarkOutOfDate`; reduce `MarkCIBundlesOutOfDate` to a wrapper; move the doc comment to `MarkOutOfDate`. If a test asserts every `EventType` has a display name, it now covers the new one.

- [ ] **Step 4: Run** `go test ./...` → PASS.

- [ ] **Step 5: Commit** `feat(db): generalise the out-of-date title marker; add pr_needs_rebase type`.

### Task 3: Emit and mark `pr_needs_rebase` in the poller

**Files:**
- Modify: `github/poller.go` (`processPRWith`: new-commits marking ~L612; new block before the state write ~L645)
- Test: `github/poller_test.go`

**Interfaces:**
- Consumes: Task 1 `resolveMergeable`, `PRData.Mergeable`; Task 2 `db.MarkOutOfDate`, `watcher.EventTypePRNeedsRebase`.
- Produces: `func needsRebaseTitle(number int, sha string) string` (`"Needs rebase: PR #%d @ %s"`, SHA truncated to 7 when longer).

- [ ] **Step 1: Write failing tests.** Each seeds a cursor with a first `processPR` (as `TestProcessPR_CIBundleUpsert` does), then polls with `State: "OPEN"`, `Commits: CommitInfo{LatestSHA: ..., LatestDate: ...}`; read events with the file's existing helpers.
  - `TestProcessPR_NeedsRebase_Emits`: `Mergeable: "CONFLICTING"`, SHA `"85a4638deadbeef"` → exactly one `pr_needs_rebase`, title `"Needs rebase: PR #123 @ 85a4638"`, tags `"commit:85a4638deadbeef"`, `external_ts == LatestDate`, author nil.
  - `TestProcessPR_NeedsRebase_NoRepeatSameHead`: three CONFLICTING polls at same SHA (different `UpdatedAt`) → one event.
  - `TestProcessPR_NeedsRebase_UnknownIsNoChange`: CONFLICTING then UNKNOWN at same SHA → one event, title un-prefixed, cached `mergeable == "CONFLICTING"`.
  - `TestProcessPR_NeedsRebase_ClearedMarksOutOfDate`: CONFLICTING then MERGEABLE at same SHA → title `"[out of date] Needs rebase: PR #123 @ 85a4638"`, `ts` unchanged from before the second poll.
  - `TestProcessPR_NeedsRebase_PushThenUnknown`: CONFLICTING @ sha1, then UNKNOWN @ sha2 → sha1 event prefixed, no sha2 event, cached `mergeable == ""`.
  - `TestProcessPR_NeedsRebase_PushStillConflicting`: CONFLICTING @ sha1, then CONFLICTING @ sha2 → sha1 prefixed, one un-prefixed sha2 event.
  - `TestProcessPR_NeedsRebase_ReconflictSameHead`: CONFLICTING, MERGEABLE, CONFLICTING at one SHA → two events, first prefixed, second not.
  - `TestProcessPR_NeedsRebase_NotOpen`: `State: "MERGED"`, CONFLICTING → no event.
  - `TestProcessPR_NeedsRebase_NoSHA`: `LatestSHA: ""`, CONFLICTING → no event.
  - `TestProcessPR_NeedsRebase_DoesNotAdvanceCursor`: after the emit, `db.EventCursor` ≤ `LatestDate` when that is the newest real timestamp.

- [ ] **Step 2: Run, expect FAIL** — `go test ./github/ -run NeedsRebase`.

- [ ] **Step 3: Implement.**
  - In the new-commits block, replace `db.MarkCIBundlesOutOfDate(conn, prevSHA, resource)` with `db.MarkOutOfDate` over both CI families plus `EventTypePRNeedsRebase`.
  - New block (after new-commits, before the state write), using `mergeable` from Task 1 and `prevMergeable`/`prevMergeableSHA` read from `prevStateMap`:
    - if `prevMergeable == "CONFLICTING" && prevMergeableSHA == LatestSHA && mergeable == "MERGEABLE"` → `db.MarkOutOfDate(conn, LatestSHA, resource, []watcher.EventType{watcher.EventTypePRNeedsRebase})` (log a WARNING on error, like the CI call).
    - if `strings.EqualFold(prData.State, "OPEN") && LatestSHA != "" && mergeable == "CONFLICTING"` → `db.IsDuplicate` with `Type: EventTypePRNeedsRebase` and `Title: &title` (title match only, so a prefixed event no longer counts); if not duplicate, `emitEvent(conn, EventTypePRNeedsRebase, title, &body, prData.Commits.LatestDate, nil, nil, nil, &tag, resource)` with body `fmt.Sprintf("PR #%d: %s", Number, Title)`, `eventCount++`, log line.

- [ ] **Step 4: Run** `go test ./...` → PASS.

- [ ] **Step 5: Commit** `feat(github): emit pr_needs_rebase and mark it out of date`.

### Task 4: Release v0.22.0

- [ ] **Step 1:** Update the library README/CHANGELOG if it lists event types or state keys (`grep -rn pr_new_commits *.md`), commit `docs: pr_needs_rebase event and mergeable state`.
- [ ] **Step 2:** `go test ./...` → PASS; `git tag v0.22.0`.
- [ ] **Step 3:** **Ask Mike**, then `git push origin main && git push origin v0.22.0`.

---

## worktree (`~/git/worktree`)

### Task 5: Re-pin, DTO field, attention signal, docs

**Files:**
- Modify: `go.mod`/`go.sum`; `internal/webui/resources_api.go` (DTO ~L29, state read ~L171); `internal/webui/attention.go` (~L76); `internal/attention/attention.go` (`Resource`, `resourceSignals`); `cmd/attention.go` (~L32 help text); `internal/agentskill/SKILL.md` (~L56); `README.md` (~L159); `.claude/CLAUDE.md` (attention entry ~L88: add `needs_rebase`, bump "Needs watcher >= v0.21.0" to `v0.22.0`)
- Test: `internal/attention/attention_test.go`, `internal/webui/` test covering the PR DTO state read (find the one asserting `CIStatus`/`ci_status`)

**Interfaces:**
- Produces: `ResourceDTO.Mergeable string \`json:"mergeable,omitempty"\``; `attention.Resource.Mergeable string \`json:"mergeable,omitempty"\``.

- [ ] **Step 1:** `go get github.com/mturley/watcher@v0.22.0 && go mod tidy`; `go test ./internal/webui/ -run SettingsModal` → PASS (no config change expected; if it fails, follow CLAUDE.md "Config files ↔ Settings modal").
- [ ] **Step 2: Write failing tests.** In `TestSignals` add rows: `{"needs rebase", Resource{Type:"pr",ID:"1",State:"OPEN",Mine:true,Mergeable:"CONFLICTING"}, "needs_rebase", true}`, plus false rows for not mine (with `UnreadCount:1`), `State:"MERGED"`, `Mergeable:"MERGEABLE"`, `Mergeable:""`. In `TestSignalsInFixedOrder` add `Mergeable:"CONFLICTING"` and expect `needs_rebase` right after `ci_failing`. In the DTO test, cached state `{"mergeable":"CONFLICTING"}` → `dto.Mergeable == "CONFLICTING"`; and the attention input carries it.
- [ ] **Step 3: Run, expect FAIL** — `go test ./internal/attention/ ./internal/webui/ -run 'Signals|<dto test name>'`.
- [ ] **Step 4: Implement** the DTO read (`m["mergeable"].(string)`), the `AttentionInput` copy, the signal, and the doc/help-text updates listed above.
- [ ] **Step 5: Run** `make test` → PASS (and `go test -race ./internal/webui/` if any webui test changed parallelism).
- [ ] **Step 6: Commit** `feat(attention): needs_rebase signal from watcher v0.22.0 mergeable state`.

### Task 6: UI — card badge, event meta, filters

**Files:**
- Modify: `ui/src/api/types.ts` (~L133 add `mergeable?: string`); `ui/src/components/ResourceCard.tsx` (`PRCardBody` ~L129, and its comment); `ui/src/lib/eventMeta.tsx` (~L83); `ui/src/lib/eventTypeFilter.ts` (Commits category); `ui/src/lib/resourceListFilter.ts` (`PR_CONDITIONS` + `prCondition`)
- Test: `ui/src/components/ResourceCard.test.tsx` ("status badge placement"), `ui/src/lib/eventMeta.test.ts`, the existing `resourceListFilter` / `eventTypeFilter` tests

- [ ] **Step 1: Write failing tests.**
  - ResourceCard, in "status badge placement": `"shows a conflicts badge on a list card, in the type line"` (`{...pr, mergeable: "CONFLICTING"}` list card → `typeLine()` contains `getByText("conflicts")`); `"shows a conflicts badge on the detail card"`; `"shows no conflicts badge when mergeable or unknown"` (`"MERGEABLE"` and `undefined` → `queryByText("conflicts")` null); `"shows no conflicts badge on a merged PR"` (`state: "MERGED", mergeable: "CONFLICTING"` → null).
  - eventMeta: `eventMeta("pr_needs_rebase")` → `label === "needs rebase"`, `color === "orange"`.
  - eventTypeFilter: PR "Commits" category `types` contains `"pr_needs_rebase"`.
  - resourceListFilter: a `conflicts` PR condition matches `mergeable: "CONFLICTING"` and not `"MERGEABLE"`/missing.
- [ ] **Step 2: Run, expect FAIL** — `cd ui && npx vitest run src/components/ResourceCard.test.tsx src/lib/` (or the matching `package.json` test script).
- [ ] **Step 3: Implement.** Badge: `size="xs" variant="light" color="orange"`, wrapped in Mantine `Tooltip` with the Global Constraints label, rendered when `r.state` is open (case-insensitive) and `r.mergeable === "CONFLICTING"`. Position (spec): on a list card (`inline`) right after the state badge, so it lands in the type line; on the detail card after the CI badge. Build the element once and place it at both spots in the `badges` fragment, gated on `inline` / `!inline`. Add a detail-card test asserting it follows `ci: success`. Update the "A list card shows only the PR's state" comment to name the exception and why (rare and actionable). eventMeta: `pr_needs_rebase: { color: "orange", Icon: IconAlertTriangle, label: "needs rebase" }`. Add `"pr_needs_rebase"` to the PR Commits category. Add `{ value: "conflicts", label: "Conflicts" }` to `PR_CONDITIONS` and its `prCondition` case.
- [ ] **Step 4: Run** the UI test + lint/typecheck scripts from `ui/package.json`, then `make build` → PASS.
- [ ] **Step 5: Commit** `feat(ui): conflicts badge, needs-rebase event meta and filters`.
