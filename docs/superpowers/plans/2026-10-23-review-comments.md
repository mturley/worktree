# Review Comments (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draft line/range review comments in the web UI's diff view, persisted in worktree's DB, re-anchored server-side as the code changes, listed in a sidebar, and copied out as a terse agent prompt.

**Architecture:** A new `internal/reviewcomments` package owns the table, CRUD and the pure anchor-matching algorithm. `internal/webui` adds `/api/review-comments*` routes and a resolver that computes each comment's *view position* (against the frozen view's revs) and *prompt position* (against the working tree on disk), caching immutable file contents under a per-worktree lock. The UI adds a comment layer to the pierre `FileDiff`s (gutter "+" → editor annotation; comments as annotations), a right sidebar (Drawer when narrow), and two modals; the prompt is built client-side by a pure function.

**Tech Stack:** Go 1.22+ (`net/http` method patterns, `database/sql` + SQLite), React + Mantine + react-query, `@pierre/diffs` 1.6.1, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-23-review-comments-design.md` (roadmap: `docs/superpowers/specs/2026-10-23-review-comments-roadmap.md`)

## Global Constraints

- Table name must not start with `watcher_` (`internal/db/migrate.go` collision check). Use `review_comments`.
- Rows are keyed by `wdb.Subscriber(path)` (column `worktree`), never a raw path.
- Comments are deleted with the worktree and on unregister (hooked in `resources.RemoveAll`), unlike notes.
- Anchors are immutable once written; clients never write positions. Only `body` (and `version`, `updated_at`) change.
- Matching context is **3** lines each side (`ContextLines = 3`).
- Low-information snippet: every line contains no Unicode letter or digit. Such a snippet never moves on the snippet alone.
- Edits carry `version`; stale → **409** with the current comment; missing → **404**. Delete of a missing comment succeeds (deletes win).
- Other clients catch up by polling the list every **5000 ms** while the diff view is open, plus invalidation after own writes. No push.
- No `{wildcard}` path params in routes (`TestEveryAPIRouteRequiresASession`); POST bodies are JSON (`guardMutations`).
- No new config keys, no new frontend dependencies.
- Read-only git goes through `internal/gitutil` (which already prepends `--no-optional-locks`).
- Copy (exact strings): button `Review comments (N)`; sidebar actions `Send comments to agent`, `Clear comments`; modal titles `Send comments to agent`, `Clear comments`; badges `Out of date`; notes `Not in this view`, `Outside the changes`; copy button `Copy to clipboard` / `Copied`; conflict notes `Changed elsewhere — your text is kept below` and `Deleted elsewhere`.
- Prompt format is pinned in Task 5 (`buildPrompt`); the header uses the `~`-form `directory` from `/api/worktree-git`.
- Commits: `git commit --signoff`, message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; add files by name, never `git add -A`/`.`.
- UI checks are `npm --prefix ui test` and `npm --prefix ui run build` (no lint script exists). Go: `go test ./...`.

## Decisions made while planning (rulings, binding for implementers)

- **Caching:** the spec asks to cache view positions per view and prompt positions per working fingerprint. The plan caches *inputs* instead: file contents at immutable revs (keyed rev+file) and changed-file sets per rev pair / per (base, full fingerprint). Positions are recomputed per request by a pure function from those inputs, under a per-worktree mutex. This is deterministic and cheaper to keep correct; working-tree files are read from disk each request (microseconds).
- **"Uncommitted":** at create time the server stores `rev = <sha>` if the anchored side's rev is a commit (`gitutil.IsCommit`), else `"uncommitted"` (a snapshot tree).
- **Server captures the snippet and context**, from the handed-out rev (`revSet.has`), so clients cannot store a snippet that doesn't match the code.
- **Context-line clicks on the old side** (split view's left column) are converted to the new side when every selected line is unchanged context; a range containing any removed line stays old-side. A range with `side !== endSide` is clamped to the starting side.
- **Collapsed regions:** pierre's React `FileDiff` exposes no instance; a file with a shown comment whose lines lie outside every hunk renders with `options.expandUnchanged: true`.
- **"Not in this view" vs "Outside the changes":** if the comment's file isn't changed in the current view, it is `not_in_view` when the file is changed in "All changes" against the comment's own base, else `outside_changes`. Jump on `not_in_view` = `setBase(comment.base)` (which resets the range to All) + reload, then scroll once it shows.
- **"Still matches" on an unchanged position whose context changed** is reported as `moved` with the same lines (context is required for "current").
- Sidebar open state lives in sessionStorage key `worktree.reviewSidebar`; it is forced closed when the loaded list becomes empty, so "flag set" always equals "sidebar rendered".

## Review Focus

1. Two comments on the same line (or ranges ending on the same line) both render, grouped in one annotation, and neither hides the other → Task 8 test `groups comments ending on the same line`.
2. A click on an unchanged context line in split view's left column must become a **new-side** comment, so the prompt never calls it "removed" → Task 6 test `old-side context-only range maps to new side`.
3. The commented file was renamed or deleted in the working tree → prompt position `outdated` with original lines, no 500 → Task 4 test `TestReviewCommentsPromptFileGone`.
4. A snippet that itself contains a ```` ``` ```` fence (markdown/docs files) → the prompt's fence is lengthened so the snippet doesn't break out → Task 5 test `lengthens the fence around backticks`.
5. Saving an edit after another client deleted the comment → the typed text stays visible with `Deleted elsewhere` until dismissed → Task 7 test `keeps typed text when the comment was deleted elsewhere`.

---

### Task 1: Anchor matching (pure Go)

**Files:**
- Create: `internal/reviewcomments/anchor.go`
- Test: `internal/reviewcomments/anchor_test.go`

**Interfaces:**
- Produces:
  ```go
  const ContextLines = 3
  var ErrOutOfRange = errors.New("lines out of range")
  type Anchor struct { Start, End int; Snippet, Before, After []string } // 1-based inclusive
  type Match string
  const ( MatchCurrent Match = "current"; MatchMoved Match = "moved"; MatchOutdated Match = "outdated" )
  type Position struct { Match Match; Start, End int } // Start/End are 0 when outdated
  func SplitLines(content []byte) []string
  func Capture(lines []string, start, end int) (Anchor, error)
  func Resolve(a Anchor, lines []string) Position
  ```

Algorithm (exact):
- `SplitLines`: split on `"\n"`; drop the final empty element when content ends with `"\n"`; empty content → empty slice. `"\r"` stays part of a line.
- `Capture(lines, s, e)`: `ErrOutOfRange` unless `1 <= s <= e <= len(lines)`. `Snippet = lines[s-1:e]`, `Before` = up to 3 lines immediately before (fewer at file start), `After` = up to 3 after. Slices are copies.
- A candidate start `p` **fully matches** when `Capture(lines, p, p+len(Snippet)-1)` succeeds and its Snippet, Before and After all equal the anchor's.
- `Resolve`: (1) `a.Start` fully matches → `current` at `a.Start..a.End`. (2) Exactly one `p` fully matches → `moved` there. (3) Else, if the snippet is not low-information and exactly one `p` has an equal Snippet (ignoring context) → `moved`. (4) Else `outdated`.
- Low-information: every snippet line has no rune for which `unicode.IsLetter || unicode.IsDigit`.

- [ ] **Step 1: Write the failing tests** (table-driven `TestResolve` plus `TestCapture`, `TestSplitLines`). Cases, each asserting the full `Position`:
  - `unchanged` → `{current, 5, 6}`
  - `two lines inserted above` → `{moved, 7, 8}`
  - `snippet edited` → `{outdated, 0, 0}`
  - `snippet+context duplicated twice, original position changed` → outdated
  - `brace snippet "}" shifted, context intact` → moved to the new lines
  - `brace snippet "}" with context changed, another "}" elsewhere` → outdated
  - `brace snippet "}" unique but context changed` → outdated (low-information never moves alone)
  - `informative snippet unique, context changed, same lines` → `{moved, 5, 5}`
  - `file now shorter than the anchor` → outdated, no panic
  - `anchor at line 1 (Before empty)` unchanged → current
  - `TestCapture`: `(lines, 0, 1)` and `(lines, 2, 1)` and end > len → `ErrOutOfRange`; `(10 lines, 2, 3)` → Before has 1 line, After has 3.
  - `TestSplitLines`: `"a\nb\n"` → `["a","b"]`; `"a\nb"` → `["a","b"]`; `""` → `[]`; `"a\r\n"` → `["a\r"]`.
- [ ] **Step 2: Run** `go test ./internal/reviewcomments/ -run 'TestResolve|TestCapture|TestSplitLines' -v` — expect FAIL (package doesn't compile).
- [ ] **Step 3: Implement** the interfaces above in `anchor.go`, with a package doc comment saying the anchor is immutable and positions are derived.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `internal/reviewcomments/anchor.go internal/reviewcomments/anchor_test.go` — `feat(reviewcomments): anchor capture and re-anchoring`.

### Task 2: Storage, CRUD and cleanup

**Files:**
- Modify: `internal/db/migrate.go` (append after `self_identity`), `internal/db/db_test.go:17` (table list)
- Create: `internal/reviewcomments/store.go`
- Test: `internal/reviewcomments/store_test.go`
- Modify: `internal/resources/resources.go:218-236` (`RemoveAll`), `internal/resources/resources_test.go`

**Interfaces:**
- Consumes: `Anchor` (Task 1).
- Produces:
  ```go
  type Side string
  const ( SideOld Side = "old"; SideNew Side = "new" )
  const SourceDraft = "draft"
  const RevUncommitted = "uncommitted"
  var ErrNotFound = errors.New("review comment not found")
  var ErrConflict = errors.New("review comment changed elsewhere")
  type Comment struct {
      ID int64; File string; Side Side; Rev string
      Base, BaseRef, RangeFrom, RangeTo string // RangeFrom/To "" = All changes
      Anchor Anchor
      Body, Source string; Version int; CreatedAt, UpdatedAt string // RFC3339 UTC
  }
  type NewComment struct { File string; Side Side; Rev, Base, BaseRef, RangeFrom, RangeTo string; Anchor Anchor; Body string }
  func List(conn *sql.DB, path string) ([]Comment, error)            // ORDER BY file, start_line, id
  func Create(conn *sql.DB, path string, n NewComment) (Comment, error) // Version 1, Source draft
  func Update(conn *sql.DB, path string, id int64, version int, body string) (Comment, error)
  func Delete(conn *sql.DB, path string, id int64) error            // missing → nil
  func DeleteAll(conn *sql.DB, path string) error
  ```
  `Update`: single `UPDATE … SET body=?, version=version+1, updated_at=? WHERE id=? AND worktree=? AND version=?`; on 0 rows, load the row: absent → `ErrNotFound`; present → return the current `Comment` **and** `ErrConflict`.

Table (append to `stmts` with a comment saying it is removed by `resources.RemoveAll`, unlike `worktree_notes`):
```sql
CREATE TABLE IF NOT EXISTS review_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worktree TEXT NOT NULL,            -- wdb.Subscriber(path)
  file TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('old','new')),
  start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  rev TEXT NOT NULL, base TEXT NOT NULL, base_ref TEXT NOT NULL,
  range_from TEXT NOT NULL DEFAULT '', range_to TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL, context_before TEXT NOT NULL, context_after TEXT NOT NULL, -- JSON arrays of lines
  body TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_comments_worktree ON review_comments(worktree);
```
(Two separate `stmts` entries.)

- [ ] **Step 1: Write failing tests** (open the DB as `notes_test.go` does: `wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))`):
  - `TestCreateListRoundTrip`: create two comments (files `b.go`, `a.go`) → `List` returns `a.go` first, anchors round-trip (incl. a line `""` and a `"\r"` line), `Version == 1`, `Source == "draft"`.
  - `TestListScopedToWorktree`: comment under path A is not listed under B.
  - `TestListCanonicalizesPath`: create via a symlinked path, list via the real path → found.
  - `TestUpdateVersioning`: update with version 1 → Version 2 and new body; update again with version 1 → returns current comment (body from first update) and `errors.Is(err, ErrConflict)`.
  - `TestUpdateDeleted`: delete then update → `ErrNotFound`.
  - `TestDeleteMissingIsNoop` → nil.
  - `TestDeleteAll`: two worktrees, `DeleteAll(A)` leaves B's.
  - In `internal/resources/resources_test.go`: `TestRemoveAllDeletesReviewComments` — create a comment for the worktree, `RemoveAll` → `List` empty.
  - Add `"review_comments"` to `TestOpenAtCreatesTables`' list.
- [ ] **Step 2: Run** `go test ./internal/reviewcomments/ ./internal/resources/ ./internal/db/` — expect FAIL.
- [ ] **Step 3: Implement** migration, `store.go`, and in `RemoveAll` call `reviewcomments.DeleteAll(conn, worktreePath)` before the `notifyprefs.RemoveAll` return (return its error if non-nil).
- [ ] **Step 4: Run** the same command — expect PASS; also `go test ./internal/worktreedel/ ./cmd/...` stays green.
- [ ] **Step 5: Commit** the five files — `feat(reviewcomments): review_comments table, CRUD, removed with the worktree`.

### Task 3: Write routes (create / update / delete / clear) and plain list

**Files:**
- Modify: `internal/gitutil/` — add `IsCommit` to `internal/gitutil/diff.go` (test in `internal/gitutil/diff_test.go`)
- Modify: `internal/webui/worktree_diff_api.go` (extract `baseRefFor`)
- Create: `internal/webui/review_comments_api.go`
- Modify: `internal/webui/server.go` (routes after the notes routes, ~:278)
- Test: `internal/webui/review_comments_api_test.go`

**Interfaces:**
- Consumes: Task 2 store; `s.revSet().has(dir, rev)`; `gitutil.ShowFile`; `reviewcomments.Capture/SplitLines`.
- Produces:
  ```go
  func IsCommit(dir, rev string) bool // `git cat-file -t <rev>` == "commit"
  // in webui; diffTargetFor keeps its exact responses by calling it:
  func baseRefFor(dir, base string) (ref string, status int, msg string)
  ```
  Routes:
  ```
  GET  /api/review-comments?path=[&old_rev=&new_rev=]  → 200 {"comments": [item…]}
  POST /api/review-comments          {path,file,side,start_line,end_line,body,base,from?,to?,old_rev,new_rev} → 201 comment
  POST /api/review-comments/update   {path,id,version,body} → 200 comment | 409 {"error":"changed elsewhere","comment":comment} | 404
  POST /api/review-comments/delete   {path,id} → 204
  POST /api/review-comments/clear    {path} → 204
  ```
  Comment JSON (`reviewCommentDTO`): `id, source, editable (always true for drafts), file, side, start_line, end_line, rev, base, base_ref, range_from (omitempty), range_to (omitempty), snippet ([]string), body, version, created_at, updated_at`. `author` is omitted for drafts (`omitempty`; phase 2 sets it). Context lines are never sent. List items embed the comment plus `view` (omitempty) and `prompt` — this task returns items **without** them; Task 4 fills them.

Create validation, in order: registered worktree (`registry.Get`, 404 `not a registered worktree`); `strings.TrimSpace(body) == ""` → 400; side not old/new → 400; `!filepath.IsLocal(file)` → 400; base not `merge-base`/`tracking` → 400; rev := old_rev (old side) or new_rev (new side); `!s.revSet().has(dir, rev)` → 404 `unknown rev`; `ShowFile` error → 400 `file not found at that rev`; `Capture` → `ErrOutOfRange` → 400; stored `Rev` = rev if `gitutil.IsCommit` else `reviewcomments.RevUncommitted`; `BaseRef` from `baseRefFor` (its status/msg on failure).

- [ ] **Step 1: Write failing tests** using `gitTestServer(t, forkRepo(t), nil)` and `getPatch` to obtain handed-out revs; POSTs through `ts` with `Content-Type: application/json`:
  - `TestIsCommit` (gitutil): HEAD sha → true; `SnapshotWorkingTree` tree sha → false; `"nope"` → false.
  - `TestReviewCommentsCreateCapturesSnippet`: create on a new-side line of a file in the patch → 201; `snippet` equals that line of the file at `new_rev`; list returns it.
  - `TestReviewCommentsCreateUncommitted`: modify a tracked file in the worktree, `getPatch` for All changes (a dirty tree makes `new_rev` a snapshot tree), comment on the new side → stored `rev == "uncommitted"`; an old-side comment in the same view stores the merge-base sha.
  - `TestReviewCommentsCreateRejects`: empty body 400; `file: "../x"` 400; `start_line: 0` 400; unknown `new_rev` 404; unregistered path 404.
  - `TestReviewCommentsUpdateConflict`: update v1 → 200 v2; update v1 again → 409 with `comment.body` = the saved body; after delete → 404.
  - `TestReviewCommentsDeleteAndClear`: delete → 204 and gone; delete again → 204; clear → 204 and list empty.
  - Existing `TestEveryAPIRouteRequiresASession` and diff API tests stay green.
- [ ] **Step 2: Run** `go test ./internal/gitutil/ ./internal/webui/ -run 'IsCommit|ReviewComments|EveryAPIRoute|Diff'` — expect FAIL.
- [ ] **Step 3: Implement** `IsCommit`, `baseRefFor` (moving the switch out of `diffTargetFor` unchanged in behaviour), the handlers and routes.
- [ ] **Step 4: Run** the same — expect PASS.
- [ ] **Step 5: Commit** the six files — `feat(webui): review comment routes`.

### Task 4: Resolver — view and prompt positions

**Files:**
- Create: `internal/webui/review_comments_resolve.go`
- Modify: `internal/webui/server.go` (fields `review *reviewResolver; reviewMu sync.Mutex`, lazy getter `s.reviewResolver()` like `s.revSet()`)
- Modify: `internal/webui/review_comments_api.go` (list fills `view` / `prompt`)
- Test: `internal/webui/review_comments_resolve_test.go`

**Interfaces:**
- Consumes: Task 1 `Resolve`; Task 3 `baseRefFor`; `gitutil.DiffFiles`, `ShowFile`, `ComputeFingerprint`, `ResolveRange`, the existing `commitsAndListID`.
- Produces (list item JSON):
  ```
  view?:  {"status": "shown"|"outdated"|"not_in_view"|"outside_changes", "start_line"?, "end_line"?, "moved"?: bool}
  prompt: {"status": "current"|"moved"|"outdated"|"removed", "start_line", "end_line"}
  ```
  List sort: by `file`, then `view.start_line` when shown else anchored `start_line`, then `id`.

Rules:
- `view` only when both `old_rev` and `new_rev` are given; either not in `revSet` → 404 `unknown rev`.
- Changed files of the view: `DiffFiles(dir, old, new)`. A new-side comment's file is "in the view" when a change has `Path == file` and `Status != "D"`; an old-side comment's when `OldPath == file` (renames) or `Path == file`, and `Status != "A"`.
- In the view: resolve against that side's content (`ShowFile` at `new_rev`/`old_rev`). current/moved → `shown` (+`moved`); outdated → new side `outdated`, old side `not_in_view`.
- Not in the view: `not_in_view` if the file is changed in All changes for the comment's `base` (resolved via `baseRefFor` + `commitsAndListID` + `ResolveRange(…, gitutil.Range{})` + `DiffFiles`, with the same side rules), else `outside_changes`. If `baseRefFor` fails, `outside_changes`.
- `prompt`: old side → `removed` with anchored lines. New side → read `filepath.Join(dir, file)` with `os.Lstat` first (not a regular file / missing → `outdated`), `SplitLines`, `Resolve`: current/moved with resolved lines, outdated with anchored lines.
- Caches on `reviewResolver` (all bounded; on reaching 512 entries clear that map): contents by `rev+"\x00"+file` (only for revs from `revSet`, which are immutable SHAs; a missing file caches as nil); changed files by `old+"\x00"+new`; All-changes file sets by `dir+"\x00"+base+"\x00"+fingerprint.Full` where the fingerprint is `ComputeFingerprint(dir, baseRef)`. Compute everything for one list request under a per-worktree `*sync.Mutex` (map keyed by `dir`).

- [ ] **Step 1: Write failing tests** (forkRepo + getPatch + create via the API, then commit/edit files and re-list):
  - `TestReviewCommentsViewShown`: list with the same revs → `view.status == "shown"`, lines equal anchored, `moved` false; `prompt.status == "current"`.
  - `TestReviewCommentsPromptMoved`: insert 2 lines above in the working tree (no new patch) → `prompt` `moved` with +2; `view` still `shown` at old lines (frozen view).
  - `TestReviewCommentsViewMovedAfterRefresh`: after the edit, fetch a new patch (All changes incl. uncommitted) and list with its revs → `view` `shown`, `moved: true`, +2.
  - `TestReviewCommentsOutdated`: change the commented line, new patch → `view.outdated`, `prompt.outdated` with anchored lines.
  - `TestReviewCommentsNotInView`: comment made in All changes; list with revs of a single-commit range that doesn't touch the file → `not_in_view`.
  - `TestReviewCommentsOutsideChanges`: revert the file to the merge base content (so it's unchanged everywhere), new patch → `outside_changes`.
  - `TestReviewCommentsRemovedSide`: old-side comment → `prompt.status == "removed"` with anchored lines.
  - `TestReviewCommentsPromptFileGone`: `git mv` the file in the worktree → `prompt.outdated`, response 200.
  - `TestReviewCommentsListUnknownRev`: `new_rev=deadbeef` → 404.
  - `TestReviewResolverConcurrentLists`: 8 goroutines list concurrently → identical bodies, no race (`go test -race`).
- [ ] **Step 2: Run** `go test -race ./internal/webui/ -run ReviewComments -v` — expect FAIL.
- [ ] **Step 3: Implement** the resolver and wire it into the list handler.
- [ ] **Step 4: Run** the same, then `go test ./...` — expect PASS.
- [ ] **Step 5: Commit** — `feat(webui): resolve review comment positions for the view and the working tree`.

### Task 5: UI data layer and prompt builder

**Files:**
- Modify: `ui/src/api/types.ts` (new section after "Code tab: git status and diff"), `ui/src/api/client.ts`
- Create: `ui/src/hooks/useReviewComments.ts`, `ui/src/hooks/useReviewSidebar.ts`, `ui/src/components/gitdiff/buildPrompt.ts`
- Test: `ui/src/hooks/useReviewComments.test.tsx`, `ui/src/hooks/useReviewSidebar.test.ts`, `ui/src/components/gitdiff/buildPrompt.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CommentSource = "draft"
  export type CommentSide = "old" | "new"
  export interface ReviewComment { id: number; source: CommentSource; author?: string; editable: boolean; file: string; side: CommentSide; start_line: number; end_line: number; rev: string; base: DiffBase; base_ref: string; range_from?: string; range_to?: string; snippet: string[]; body: string; version: number; created_at: string; updated_at: string }
  export type ViewStatus = "shown" | "outdated" | "not_in_view" | "outside_changes"
  export interface ReviewCommentItem extends ReviewComment { view?: { status: ViewStatus; start_line?: number; end_line?: number; moved?: boolean }; prompt: { status: "current" | "moved" | "outdated" | "removed"; start_line: number; end_line: number } }
  export interface NewReviewComment { path: string; file: string; side: CommentSide; start_line: number; end_line: number; body: string; base: DiffBase; from?: string; to?: string; old_rev: string; new_rev: string }
  // client.ts
  class HttpError { …; readonly body?: unknown }  // fetchJSON passes the parsed error JSON
  api.reviewComments(path: string, view?: { oldRev: string; newRev: string }): Promise<{ comments: ReviewCommentItem[] }>
  api.createReviewComment(req: NewReviewComment): Promise<ReviewComment>
  api.updateReviewComment(req: { path: string; id: number; version: number; body: string }): Promise<ReviewComment>
  api.deleteReviewComment(path: string, id: number): Promise<void>
  api.clearReviewComments(path: string): Promise<void>
  // hooks
  export function useReviewComments(path: string, view: { oldRev: string; newRev: string } | undefined): UseQueryResult<ReviewCommentItem[]>
  //   key ["review-comments", path, view?.oldRev, view?.newRev]; refetchInterval 5000; placeholderData keeps the previous data for the same path
  export function useReviewCommentMutations(path: string): { create; update; remove; clear } // useMutation each; onSettled invalidates ["review-comments", path]
  export function useReviewSidebar(): [boolean, (open: boolean) => void] // sessionStorage "worktree.reviewSidebar", pattern of useFollowCmux.ts
  export function buildPrompt(input: { directory: string; branch?: string; baseRef: string; comments: ReviewCommentItem[] }): string
  export function conflictComment(err: unknown): ReviewComment | undefined // 409 HttpError body.comment, validated
  ```
  The 204 endpoints need a fetch that tolerates an empty body; add a `postJSON<T>` helper (like `putJSON`) and a `postNoContent` variant, or make `fetchJSON` return `undefined` on 204 — implementer's choice, tested.

`buildPrompt` format (exact):
```
Review comments on {directory} (branch {branch}, changes vs {baseRef}):

1. {file}:{start}[-{end}]
   ```{lang}
   {snippet lines, each indented 3 spaces}
   ```
   {body lines, each indented 3 spaces}

2. …
```
- Omit `branch {branch}, ` when `branch` is undefined.
- Location by `prompt.status`: current/moved → `{file}:{s}` or `{file}:{s}-{e}` using `prompt` lines; removed → `{file} (removed line, previously {s})` or `{file} (removed lines, previously {s}–{e})` (en dash); outdated → `{file}:{s}[-{e}] (out of date — this code has since changed; it was:)` with the anchored lines (`start_line`/`end_line`).
- Order: the input order (the server's diff order).
- Fence: three backticks, lengthened to one more than the longest backtick run in the snippet. Language from the extension via a small map (`go`, `ts`, `tsx`, `js`, `jsx`, `json`, `md`→`markdown`, `py`→`python`, `sh`, `yaml`/`yml`→`yaml`, `css`, `html`, `sql`, `rs`→`rust`); unknown → no language.
- Comments separated by one blank line; trailing newline at the end of the whole text.

- [ ] **Step 1: Write failing tests:**
  - `buildPrompt.test.ts`: `formats the header with branch` / `omits branch when detached`; `single-line and range locations`; `removed line and removed lines with en dash`; `out of date uses the anchored lines`; `indents multi-line bodies`; `lengthens the fence around backticks` (snippet containing ```` ``` ```` → fence of four); `no language for unknown extensions`. Assert whole-string equality against literals.
  - `useReviewComments.test.tsx` (vi.mock `../api/client` as DiffView.test does): passes the view revs; refetches on a 5s interval (fake timers); a successful `update` invalidates the list; `conflictComment` returns the comment from a 409 `HttpError` and `undefined` for a 404 or malformed body.
  - `useReviewSidebar.test.ts`: defaults to false; persists to sessionStorage; falls back to memory when sessionStorage throws.
- [ ] **Step 2: Run** `npm --prefix ui test -- src/components/gitdiff/buildPrompt.test.ts src/hooks/useReviewComments.test.tsx src/hooks/useReviewSidebar.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — expect PASS.
- [ ] **Step 5: Commit** — `feat(ui): review comments API, hooks and prompt builder`.

### Task 6: Range helpers for pierre

**Files:**
- Create: `ui/src/components/gitdiff/commentRange.ts`
- Test: `ui/src/components/gitdiff/commentRange.test.ts`

**Interfaces:**
- Consumes: `DiffFile` / `parseDiff(patch, cacheKey)` from `parsedPatch.ts`; pierre `FileDiffMetadata`, `Hunk`, `SelectedLineRange`.
- Produces:
  ```ts
  export interface CommentTarget { file: string; side: CommentSide; start: number; end: number }
  export function toCommentTarget(f: DiffFile, range: SelectedLineRange): CommentTarget | null
  export function lineInHunks(meta: FileDiffMetadata, side: CommentSide, line: number): boolean
  export const pierreSide = (s: CommentSide): "deletions" | "additions"
  ```
- `toCommentTarget`: normalise `start <= end`; if `endSide` is set and differs from `side`, clamp to the starting side (keep `start`, set `end` to the last line of the starting side that the selection covered — or `start` when unknown). `side` undefined → additions. `deletions` side: if every line in the range is unchanged context (not a deletion), convert to the `new` side by adding the offset `(additionStart - deletionStart)` of the hunk containing the lines (or, in a collapsed gap, the offset carried after the previous hunk); otherwise `old`. `file` = `meta.prevName ?? meta.name` for old, `meta.name` for new. Returns null for binary files.
- `lineInHunks`: true when the line lies in any hunk's `[start, start+count-1]` on that side (`additionStart/additionCount` or `deletionStart/deletionCount`).

- [ ] **Step 1: Write failing tests** with patches parsed by `parseDiff`: `single new-side line`; `reversed range is normalised`; `range across sides clamps to the starting side`; `old-side context-only range maps to new side` (a hunk with 2 added lines above → new numbers are old + 2); `old-side range with a removed line stays old`; `renamed file uses prevName on the old side`; `lineInHunks` true inside a hunk and false in the gap between two hunks.
- [ ] **Step 2: Run** `npm --prefix ui test -- src/components/gitdiff/commentRange.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(ui): map pierre line selections to comment targets`.

### Task 7: The comment component and editor

**Files:**
- Create: `ui/src/components/gitdiff/CommentEditor.tsx`, `ui/src/components/gitdiff/ReviewCommentCard.tsx`
- Test: `ui/src/components/gitdiff/CommentEditor.test.tsx`, `ui/src/components/gitdiff/ReviewCommentCard.test.tsx`

**Interfaces:**
- Consumes: Task 5 types, `useReviewCommentMutations`, `conflictComment`.
- Produces:
  ```ts
  export function CommentEditor(props: { initial: string; submitLabel: string; onSubmit: (text: string) => void; onCancel: () => void; busy?: boolean; error?: string }): JSX.Element
  export function ReviewCommentCard(props: { path: string; comment: ReviewCommentItem; variant: "inline" | "sidebar"; onJump?: () => void; jumpDisabledReason?: string }): JSX.Element
  export function NewCommentCard(props: { path: string; target: CommentTarget; view: { base: DiffBase; range: DiffRange; oldRev: string; newRev: string }; onDone: () => void }): JSX.Element
  export const SOURCE_STYLE: Record<CommentSource, { borderColor: string; label?: string }>
  ```
- `CommentEditor`: Mantine `Textarea` (`autoFocus`, `resize="vertical"`, rows as in `NotesPanel`); `Escape` → `preventDefault()` + `stopPropagation()` + `onCancel`; `Cmd/Ctrl+Enter` → `onSubmit(text)` unless the trimmed text is empty; submit button disabled while empty; `Cancel` button.
- `ReviewCommentCard`: shows `file:lines` (sidebar only; view lines when shown, else anchored), `(old)` when `side === "old"`, an `Out of date` badge when `view.status === "outdated"` or `prompt.status === "outdated"`, `Not in this view` / `Outside the changes` notes (sidebar only), the body (`white-space: pre-wrap`), and Edit / Delete / Jump (sidebar only; disabled with `jumpDisabledReason` as tooltip) controls. Edit swaps in `CommentEditor` with `submitLabel="Save"` and calls `update` with the comment's `version`. On 409: show `Changed elsewhere — your text is kept below` above the newer body and keep the editor open with the typed text, now carrying the newer version. On 404: show `Deleted elsewhere` with the typed text read-only and a `Dismiss` button. Delete has no confirmation. Root element gets `data-review-comment-id={id}`.
- `NewCommentCard`: `CommentEditor` with `submitLabel="Comment"`; submit calls `create` with the target and view; success → `onDone`; failure → `error` shown, text kept.

- [ ] **Step 1: Write failing tests** (MantineProvider + QueryClientProvider inline, `vi.mock("../../api/client")`):
  - Editor: `Cmd+Enter submits`, `Ctrl+Enter submits`, `empty text does not submit`, `Escape cancels and is not propagated` (a document keydown listener does not see it / `defaultPrevented`).
  - Card: `edit saves with the version`; `shows newer text and keeps typing on 409`; `keeps typed text when the comment was deleted elsewhere`; `delete calls remove without confirmation`; `out of date badge`; `not in this view note in the sidebar variant`; `jump disabled with reason`.
  - NewCommentCard: `creates with target and view revs`; `keeps text on failure`.
- [ ] **Step 2: Run** `npm --prefix ui test -- src/components/gitdiff/CommentEditor.test.tsx src/components/gitdiff/ReviewCommentCard.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(ui): review comment card and editor`.

### Task 8: Comments inside the diff (DiffBody)

**Files:**
- Modify: `ui/src/components/gitdiff/DiffBody.tsx`
- Test: `ui/src/components/gitdiff/DiffBody.test.tsx` (extend the `@pierre/diffs/react` mock to render `renderAnnotation` for each `lineAnnotations` entry into a slotted light-DOM div, and to expose `options` for assertions)

**Interfaces:**
- Consumes: Tasks 6 and 7.
- Produces (new DiffBody props):
  ```ts
  comments: ReviewCommentItem[]                 // full list; DiffBody shows those with view.status === "shown"
  pending: CommentTarget | null
  onStartComment: (t: CommentTarget) => void
  onPendingDone: () => void
  view: { base: DiffBase; range: DiffRange; oldRev: string; newRev: string }
  openFile: { file: string; n: number } | null // a change opens (unfolds) that file
  export interface CommentAnnotation { items: ReviewCommentItem[]; pending?: CommentTarget }
  ```
- Per file: `lineAnnotations` built by grouping shown comments of that file (matching side; old side matches `prevName ?? name`) by `(side, view.end_line)`, plus the pending target at `(side, end)`; `renderAnnotation` renders each item as `ReviewCommentCard variant="inline"` and the pending one as `NewCommentCard`. `options` add `enableGutterUtility: true` and `onGutterUtilityClick: range => { const t = toCommentTarget(f, range); if (t) onStartComment(t) }`, and `expandUnchanged: true` when any shown comment of the file fails `lineInHunks`. Keep options objects stable (memoise per file) so pierre doesn't re-render every poll.

- [ ] **Step 1: Write failing tests:** `renders a shown comment as an annotation at its end line`; `groups comments ending on the same line`; `does not render outdated or not-in-view comments inline`; `gutter click starts a comment with the mapped target`; `pending target renders the new-comment editor`; `expands unchanged lines when a comment is outside the hunks`; `openFile unfolds a collapsed file`.
- [ ] **Step 2: Run** `npm --prefix ui test -- src/components/gitdiff/DiffBody.test.tsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS (existing DiffBody tests too).
- [ ] **Step 5: Commit** — `feat(ui): review comments inline in the diff`.

### Task 9: Sidebar, modals, jump and recheck summary (DiffView)

**Files:**
- Create: `ui/src/components/gitdiff/ReviewSidebar.tsx`, `ui/src/components/gitdiff/SendToAgentModal.tsx`, `ui/src/components/gitdiff/ClearCommentsModal.tsx`
- Modify: `ui/src/components/gitdiff/DiffView.tsx`, `ui/src/components/gitdiff/scrollToFile.ts`
- Test: `ui/src/components/gitdiff/ReviewSidebar.test.tsx`, `ui/src/components/gitdiff/DiffView.test.tsx`, `ui/src/components/gitdiff/scrollToFile.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 7, 8; `useWorktreeGit` (`directory`, `branch`); `useDiffSelection(...).setBase`; DiffView's `reload`, `shown`, `request`, `commits.data.base_ref`.
- Produces:
  ```ts
  export function scrollToComment(file: string, id: number): () => void // scrollToFile, then retry per frame (≤4s) until [data-review-comment-id=id] exists, scrollIntoView({block:"center"})
  export function ReviewSidebar(props: { path: string; comments: ReviewCommentItem[]; prompt: string; onJump: (c: ReviewCommentItem) => void; onClose?: () => void; escHint: boolean }): JSX.Element
  export function SendToAgentModal(props: { opened: boolean; onClose: () => void; prompt: string }): JSX.Element
  export function ClearCommentsModal(props: { opened: boolean; onClose: () => void; path: string; count: number }): JSX.Element
  // DiffView gains prop: sidebarEscHint?: boolean (default false)
  ```
- DiffView:
  - `useReviewComments(path, shown ? { oldRev: shown.old_rev, newRev: shown.new_rev } : undefined)`.
  - Breadcrumb: `Review comments (N)` button (`ml="auto"`, `size="compact-xs"`, `variant` filled when open else light) shown only when N ≥ 1; toggles `useReviewSidebar`. When the loaded list is empty, set the flag false.
  - Wide: `ReviewSidebar` as the third child of the bordered row, width 340, left border. Narrow: Mantine `Drawer position="right" size="85%" title="Review comments"`.
  - Sidebar top action row: `Send comments to agent` (opens `SendToAgentModal`), `Clear comments` (opens `ClearCommentsModal`), close `ActionIcon` (wide only) with `<KeyHint>Esc</KeyHint>` when `escHint`.
  - `SendToAgentModal`: read-only `Textarea` (`autosize`, `minRows 10`, `maxRows 24`) holding `prompt`, Mantine `CopyButton` labelled `Copy to clipboard` / `Copied`.
  - `ClearCommentsModal`: text `Delete all {count} review comments? This can't be undone.`; `Cancel` (`variant="default"`) and red `Clear comments` (`data-autofocus`, `loading` while pending) calling `clear`.
  - Prompt: `buildPrompt({ directory: git.directory, branch: git.branch || undefined, baseRef: commits.data.base_ref, comments })`.
  - Jump: `shown` → set `openFile` and `scrollToComment`; `outdated` → `scrollToFile(file)`; `not_in_view` → `setBase(c.base)` + `reload()` and remember `pendingJump = c.id`, performing the jump when that comment's `view.status` becomes `shown` (drop it on the next view change otherwise); `outside_changes` → disabled, reason `Outside the changes — this file has no changes to show`.
  - Pending new comment: `pending` state passed to DiffBody; starting a new one replaces it; cleared on view change.
  - Recheck summary: when the user clicks Refresh (stale banner) and the list for the new revs arrives, show `{a} still match, {b} moved, {c} out of date` (only non-zero parts, joined by `, `; nothing when there are no comments) as dimmed text in the toolbar, `data-testid="comment-recheck"`, until the next view change. Counts: `shown && !moved`, `shown && moved`, `outdated`.

- [ ] **Step 1: Write failing tests:**
  - `ReviewSidebar.test.tsx`: `lists comments in the given order`; `send opens the modal with the prompt and a copy button`; `clear asks for confirmation then clears`; `close shows the Esc hint only when escHint`.
  - `DiffView.test.tsx` (mock `useReviewComments` / client): `hides the review button with no comments`; `shows Review comments (2) and toggles the sidebar`; `sidebar is a drawer when narrow`; `jump to a not-in-view comment switches to All changes for its base`; `jump disabled for outside the changes`; `reports the recheck after Refresh`; `sidebar closes when the list becomes empty`.
  - `scrollToFile.test.ts`: `scrollToComment scrolls to the comment once it renders`.
- [ ] **Step 2: Run** `npm --prefix ui test -- src/components/gitdiff/` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(ui): review comments sidebar, prompt and clear`.

### Task 10: Esc ladder

**Files:**
- Modify: `ui/src/pages/WorktreeDetailPage.tsx` (~:112 `escDiff`, ~:585 `escapeIdle`)
- Test: `ui/src/pages/WorktreeDetailPage.test.tsx` (or the existing page test file that covers the diff Esc ladder; extend it)

**Interfaces:**
- Consumes: `useReviewSidebar` (Task 5); DiffView's `escHint` and new `sidebarEscHint` (Task 9).
- Behaviour: `escapeIdle`: `if (inDiff && sidebarOpen) { setSidebarOpen(false); return }` before `diffView.leave()`. Hints: `escHint={escDiff && !sidebarOpen}`, `sidebarEscHint={escDiff && sidebarOpen}` — one Esc hint at a time. Esc inside a comment editor never reaches the ladder (Task 7 stops it; `escOwnedElsewhere` also skips focused editables). On narrow screens the Drawer (role=dialog) owns Esc already.

- [ ] **Step 1: Write failing tests:** `Esc closes the review sidebar before leaving the diff`; `only the sidebar's Esc hint shows while it is open`; `Esc in a comment editor does not close the sidebar or leave`.
- [ ] **Step 2: Run** `npm --prefix ui test -- src/pages/` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm --prefix ui test` (full suite) — PASS.
- [ ] **Step 5: Commit** — `feat(ui): Esc closes the review sidebar first`.

### Task 11: Docs and full verification

**Files:**
- Modify: `docs/web-ui-architecture.md` ("Code tab and diff view", lines ~2253–2368: add a "Review comments" subsection — table, routes, DTOs, the two positions, caches/lock, polling, Esc), `.claude/CLAUDE.md` (package list: `reviewcomments` entry; `webui` bullet mentions `/api/review-comments*`), `docs/superpowers/specs/2026-10-23-review-comments-roadmap.md` (phase 1 status → Done, with the merge note left for the controller)

- [ ] **Step 1: Write the docs** (state the rulings at the top of this plan where they differ from the spec's wording: content caching, server-captured snippets, context-click mapping, `expandUnchanged`).
- [ ] **Step 2: Verify:** `go test -race ./...`, `npm --prefix ui test`, `npm --prefix ui run build`, `make build` — all PASS.
- [ ] **Step 3: Commit** the three docs — `docs: review comments in the architecture doc and package list`.
- [ ] **Step 4 (controller):** `NONINTERACTIVE=1 make install`; Playwright check of the real UI on a worktree with changes (Mike logs in himself): create a single-line and a range comment, edit, delete, open the sidebar, jump, copy the prompt, edit the file and Refresh to see the recheck line, Clear. Report results; no commit.
