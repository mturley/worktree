# PR comments in the diff view: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a tracked PR's review threads read-only in the diff view: inline and in a "PR comments" sidebar tab, with unread state, counts on the Code tab and toolbar buttons, and a jump from the activity modal.

**Architecture:**
- **Library:** the watcher library gets an on-demand, paginated `FetchReviewThreads`. Its poller also tags `pr_review_comment` events with the GitHub comment id. This is released as v0.17.0 and re-pinned here.
- **Server:**
  - A pure package, `internal/prcomments`, picks the PR, counts, fingerprints, and matches events to comments.
  - `internal/webui` caches the fetch per PR (60s) and places threads with phase 1's resolver.
  - It serves three routes: a polled summary, a pinned per-view thread list, and an event locator.
- **UI:** the UI polls the summary every 5s, for counts, unread ids and the fingerprint. It pins the thread list per view, the way the patch is pinned. A changed fingerprint raises the existing Refresh.

**Tech Stack:** Go (watcher library, worktree `internal/`), SQLite, React + Mantine + react-query, `@pierre/diffs`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-pr-comments-design.md`. The plan's phase-1 context is in `docs/superpowers/specs/2026-10-23-review-comments-design.md` and `docs/web-ui-architecture.md` ("Code tab and diff view", "Review comments", "Unread").

## Global Constraints

- **GitHub gating:** every GitHub call goes through the watcher library and is gated on `s.WatcherEnabled(config.ServiceGitHub)`. Nothing contacts GitHub while it's off.
- **Library changes:** done in `~/git/watcher` with tests. Commit, tag `v0.17.0`, push both `main` and the tag (**ask Mike before pushing**), then `go get github.com/mturley/watcher@v0.17.0 && go mod tidy` here.
- **No stored PR data:** nothing about PR comments is persisted in worktree's DB. Read state comes from the existing unread cursor.
- **Never shift code under Mike:** new or changed threads raise Refresh. They never re-render the pinned view. Unread state alone may update live.
- **Accent:** PR comments use Mantine `grape` (`var(--mantine-color-grape-6)` border, grape links). Drafts keep blue.
- **Exact copy:**
  - Author line: `@<login> on PR #<n>`.
  - Links: `View all` and `View on GitHub`.
  - Labels: `Pending` and `Outdated`. Resolved one-liner: `Resolved · @<login> · <file>:<line> — <first words…>`.
  - Tabs: `Local comments (N)` and `PR comments (N)`. Switch: `Show in diff view`. Button: `Mark all read`.
  - Activity modal button: `Go to comment in diff view`.
  - PR tab empty states: `No tracked PR for branch <branch>` and `The GitHub watcher is off, so PR comments aren't shown`.
- **Counts:** open (unresolved) threads, and unread **comments** in open threads. Mike's own comments are never unread.
- **Button labels** (parts omitted at 0, singular at 1, `(N unread)` only when > 0):
  - Code tab: `Review changes (N pending local comments, N PR comments (N unread))`, or plain `Review changes`.
  - Toolbar: `N pending local review comments, N PR review comments (N unread)`, and `Close comments sidebar` while open.
  - Both are unread-blue (filled, `--button-hover: var(--mantine-color-blue-4)`) only if local > 0 or unread > 0.
- **Commits:** `--signoff`, named files only, and these trailers:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01SuJzq5SpFU21xdG96SXY6e`.
- **Commands:**
  - Library tests: `cd ~/git/watcher && go test ./...`.
  - Worktree: `go build ./... && go vet ./... && go test ./...`, then `npm --prefix ui test -- --run` and `npm --prefix ui run build`.
- **Docs:** update `docs/web-ui-architecture.md`, plus `.claude/CLAUDE.md`'s package list for the new package and routes.

## Review Focus

1. **A force-pushed PR:** the comment's `originalCommit` isn't in the local repo. The thread is listed in the sidebar with "View on GitHub" and no jump, and nothing errors. This is pinned in Task 5.
2. **A worktree on a branch with no tracked PR, or with the GitHub watcher off:** the summary answers a state (not an error), and the UI shows the empty-state copy. No GitHub call is made when off. This is pinned in Task 6.
3. **A thread whose only comments are Mike's pending ones:** it counts as open, is never unread, and shows `Pending`. This is pinned in Tasks 4 and 8.
4. **The GitHub fetch fails, from rate limit or network:** the summary returns `state: "error"` with the message, the local tab keeps working, and the error isn't cached. This is pinned in Task 6.
5. **Old events with no `comment:` tag:** they still match by author, path and createdAt, so unread and "Go to comment" work for them. This is pinned in Task 4.

---

### Task 1: Library: `FetchReviewThreads`

**Files:**
- Create: `~/git/watcher/github/threads.go`, `~/git/watcher/github/threads_test.go`

**Interfaces:**
- Produces:
```go
type PRReviewThreads struct {
	HeadRefName, HeadRefOid, BaseRefOid string
	Threads []ReviewThread
}
type ReviewThread struct {
	ID                 string
	IsResolved, IsOutdated bool
	Path               string
	DiffSide           string // "LEFT" | "RIGHT"
	Line, StartLine, OriginalLine, OriginalStartLine int // 0 when GitHub returns null
	Comments           []ThreadComment // oldest first
}
type ThreadComment struct {
	DatabaseID                                  int64
	Author, AuthorType, AuthorID, AvatarURL     string
	Body, CreatedAt, UpdatedAt, URL             string
	Commit, OriginalCommit                      string // oids; "" when null
	Pending                                     bool   // state == PENDING
}
func FetchReviewThreads(token string, ref PRRef, apiURL ...string) (*PRReviewThreads, error)
```

- [ ] **Step 1: Write failing tests** in `threads_test.go`, against an `httptest` server like `summaries_test.go`'s.
  - `TestFetchReviewThreadsPaginates`: the first response has `reviewThreads.pageInfo{hasNextPage:true,endCursor:"c1"}`. The test asserts that the second request's query contains `after: "c1"`. It asserts that the result has the threads from both pages in order, and that `HeadRefName`, `HeadRefOid` and `BaseRefOid` come from the first page.
  - `TestFetchReviewThreadsFields`: one thread with `isResolved:true`, `diffSide:"LEFT"`, `line:null`, `originalLine:12`, `originalStartLine:10`, and a comment with `state:"PENDING"`, `databaseId:99`, `url`, `author.avatarUrl`, `commit:null` and `originalCommit.oid:"abc"`. The test asserts `Line == 0`, `OriginalLine == 12`, `OriginalStartLine == 10`, `Pending`, `DatabaseID == 99` and `Commit == ""`.
  - `TestFetchReviewThreadsMoreComments`: a thread whose `comments.pageInfo.hasNextPage` is true. The test asserts that a follow-up `node(id: "<thread id>")` query fetches the rest, and that `Comments` holds all of them.
  - `TestFetchReviewThreadsUnauthorizedIsErrAuth`: a 401 gives an error that wraps `ErrAuth`.
  - `TestFetchReviewThreadsMissingPR`: `pullRequest: null` gives an error.
- [ ] **Step 2:** `go test ./github -run FetchReviewThreads` fails, because the function isn't defined.
- [ ] **Step 3: Implement.**
  - GraphQL: `repository(owner,name){pullRequest(number){headRefName headRefOid baseRefOid reviewThreads(first:100, after:$c){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path diffSide line startLine originalLine originalStartLine comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId body createdAt updatedAt url state commit{oid} originalCommit{oid} author{__typename login avatarUrl ... on User{databaseId} ... on Bot{databaseId}}}}}}}}`.
  - Loop until `hasNextPage` is false. A thread with more comments is fetched through `node(id:){... on PullRequestReviewThread{comments(first:100, after:)}}`.
  - Reuse `authorType` and the author-id helper from `graphql.go`. Use the request and status handling of `FetchPRSummaries`, but factored into a small shared `postGraphQL(token, endpoint, query string) ([]byte, error)` that `FetchPRSummaries` also uses.
- [ ] **Step 4:** `go test ./...` in `~/git/watcher` passes.
- [ ] **Step 5: Commit:** `feat(github): FetchReviewThreads for a PR's review threads, paginated`.

### Task 2: Library: comment ids on review comment events, lookup by type, and release

**Files:**
- Modify: `~/git/watcher/github/graphql.go` (poll query and `ReviewComment`), `~/git/watcher/github/poller.go` (review comment emit), `~/git/watcher/db/subscriptions.go`
- Test: `~/git/watcher/github/poller_test.go`, `~/git/watcher/db/subscriptions_test.go` (or the file that tests `RecentEventsForResource`)

**Interfaces:**
- Produces:
  - `ReviewComment.DatabaseID int64`.
  - `pr_review_comment` events carry `Tags = "comment:<databaseId>"` when the id is known.
  - `func EventsForResourceByType(conn *sql.DB, resourceType, resourceID, eventType string) ([]watcher.Event, error)` returns every event of that type for the resource, oldest first, with no limit.
  - Release `v0.17.0`.

- [ ] **Step 1: Failing tests.**
  - The poller test gives a review comment with `databaseId: 4242` in the fixture. It asserts that the emitted event's `Tags` is `"comment:4242"`.
  - The db test inserts three events, two of type `pr_review_comment` and one `pr_comment`. It asserts that `EventsForResourceByType` returns the two in `ts` order.
- [ ] **Step 2:** Run them and confirm they fail.
- [ ] **Step 3: Implement.**
  - Add `databaseId` to the poll query's `reviewThreads … comments … nodes`.
  - Add a `tags *string` argument path. Either a new `emitEventTagged`, or a `tags` parameter on `emitEvent`, updating all its callers.
  - Dedup is unchanged.
- [ ] **Step 4:** `go test ./...` passes.
- [ ] **Step 5: Commit:** `feat(github): tag review comment events with the comment id; db: EventsForResourceByType`.
- [ ] **Step 6: Release.** Tag `v0.17.0`. **Ask Mike** before `git push origin main && git push origin v0.17.0`.

### Task 3: Re-pin, and git helpers

**Files:**
- Modify: `go.mod`, `go.sum`, `internal/gitutil/refs.go`
- Test: `internal/gitutil/refs_test.go`

**Interfaces:**
- Produces: `func MergeBaseOf(dir, a, b string) (string, bool)` runs `git merge-base a b` through `git()`, so `--no-optional-locks` applies. `IsCommit(dir, rev)` already exists, so reuse it.

- [ ] **Step 1:** Run `go get github.com/mturley/watcher@v0.17.0 && go mod tidy`, then `go build ./... && go test ./...` (green).
- [ ] **Step 2: Failing test `TestMergeBaseOf`.** In a `testgit` repo with branch `a` and branch `b` forked from commit `m`, it asserts `MergeBaseOf(dir, "a", "b") == m`. It also asserts that an unknown rev gives `ok == false`.
- [ ] **Step 3:** Implement. **Step 4:** `go test ./internal/gitutil` passes.
- [ ] **Step 5: Commit:** `chore: pin watcher v0.17.0; gitutil.MergeBaseOf`.

### Task 4: `internal/prcomments`, the pure logic

**Files:**
- Create: `internal/prcomments/prcomments.go`, `internal/prcomments/prcomments_test.go`

**Interfaces:**
- Consumes: `wgithub.PRReviewThreads`, `wgithub.ReviewThread`, `wgithub.ThreadComment`, and `watcher.Event`.
- Produces:
```go
// Candidate is a tracked PR resource that might be the worktree's.
type Candidate struct { ID string; Primary bool; UpdatedAt string; HeadRefName string }
func PickPR(cands []Candidate, branch string) (Candidate, bool) // head == branch; primary first, then newest UpdatedAt
func Fingerprint(t *wgithub.PRReviewThreads) string             // sha256 hex over sorted thread id, resolved, outdated, comment ids + UpdatedAt
func OpenThreads(t *wgithub.PRReviewThreads) int
// MatchEvents maps comment DatabaseID → event, by "comment:<id>" tag, else author + path + CreatedAt == ExternalTS
// with the title "Review comment by <author> on <path>".
func MatchEvents(t *wgithub.PRReviewThreads, events []watcher.Event) map[int64]watcher.Event
// UnreadIDs: comment ids in OPEN threads whose matched event isUnread says so; Pending comments never.
func UnreadIDs(t *wgithub.PRReviewThreads, matched map[int64]watcher.Event, isUnread func(watcher.Event) bool) []int64
```

- [ ] **Step 1: Failing tests.**
  - `TestPickPR`: two candidates on the branch, one related and newer, one primary and older. Asserts that the primary wins. With none on the branch, asserts `ok == false`. With two related, asserts that the newer `UpdatedAt` wins.
  - `TestFingerprintChanges`: the fingerprint changes when a thread's `IsResolved` flips and when a comment's `UpdatedAt` changes. It's stable under thread order.
  - `TestOpenThreads`: three threads, one resolved, gives 2. A thread whose only comment is `Pending` counts.
  - `TestMatchEventsByTag` and `TestMatchEventsFallback`: an untagged event with the matching title, author and `ExternalTS` matches. One with a different `ExternalTS` doesn't.
  - `TestUnreadIDs`: comments in resolved threads and `Pending` comments are never included, even when `isUnread` returns true.
- [ ] **Step 2:** Run them and confirm they fail. **Step 3:** Implement. **Step 4:** `go test ./internal/prcomments` passes.
- [ ] **Step 5: Commit:** `feat(prcomments): pick the worktree's PR, count, fingerprint and match events`.

### Task 5: Place PR threads in the view

**Files:**
- Modify: `internal/webui/review_comments_resolve.go`
- Create: `internal/webui/pr_threads_place.go`
- Test: `internal/webui/pr_threads_place_test.go`

**Interfaces:**
- Consumes:
  - `reviewResolver` and its `viewPosition`, `allChanges`, `fileInChanges` and `linesAt`.
  - `gitutil.MergeBaseOf` and `gitutil.IsCommit`.
  - `reviewcomments.Capture`.
- Produces:
  - Refactor: `func (r *reviewResolver) placeInView(dir string, c reviewcomments.Comment, view *reviewView, viewFiles []gitutil.FileChange, allByBase map[string]allResult) *reviewViewDTO`, extracted from `resolve`'s loop body, with `allResult` moved to package level. `resolve` calls it, and its behaviour doesn't change.
  - `func prThreadAnchor(dir string, t wgithub.ReviewThread, baseOid string, lines func(rev, file string) []string) (reviewcomments.Comment, bool)`:
    - It builds a synthetic `Comment{File: t.Path, Side, Base: "merge-base", Anchor}` from the first comment.
    - RIGHT means `SideNew` at `OriginalCommit`. LEFT means `SideOld` at `MergeBaseOf(dir, OriginalCommit, baseOid)`.
    - The lines are `OriginalStartLine` (or `OriginalLine` when it's 0) through `OriginalLine`.
    - It returns false when the commit isn't local (`!IsCommit`), the merge-base fails, or `Capture` errors.
  - `func (r *reviewResolver) placeThreads(dir string, t *wgithub.PRReviewThreads, view *reviewView) ([]prThreadView, error)` uses `type prThreadView struct { anchor *reviewcomments.Comment; view *reviewViewDTO }`, in thread order.
    - Unplaceable threads get `view = {Status: "unavailable"}`.
    - A thread with GitHub's `IsOutdated` gets `"outdated"`, unless the status would be `not_in_view` or `outside_changes`.

- [ ] **Step 1: Failing tests,** using `testgit` repos with real commits.
  - `TestPlaceThreadsRight`: the comment is on the new side at commit C1. The view is the merge-base to the working tree, with an unchanged line. Asserts `shown` with the same lines.
  - `TestPlaceThreadsMoved`: two lines are inserted above the commented line after C1. Asserts `shown`, `moved`, and the start shifted by 2.
  - `TestPlaceThreadsLeft`: a LEFT comment on a removed line. Asserts `shown` on the old side.
  - `TestPlaceThreadsMissingCommit`: `OriginalCommit` is `"deadbeef…"`. Asserts `unavailable` and no error.
  - `TestPlaceThreadsGitHubOutdated`: `IsOutdated:true` with lines that still match. Asserts `outdated`.
  - `TestResolveUnchangedAfterRefactor`: the existing `review_comments_resolve_test.go` passes unchanged.
- [ ] **Step 2:** Run them and confirm they fail. **Step 3:** Implement. **Step 4:** `go test ./internal/webui -run 'PlaceThreads|Review'` passes.
- [ ] **Step 5: Commit:** `feat(webui): place PR review threads in the diff view`.

### Task 6: PR comments API

**Files:**
- Create: `internal/webui/pr_comments_api.go`, `internal/webui/pr_comments_api_test.go`
- Modify: `internal/webui/server.go` (routes, plus a `prThreadsCache *ttlCache` field and seams)

**Interfaces:**
- Consumes: Tasks 4 and 5, `resources.Load`, `gitutil.CurrentBranch`, the `unreadIndex` (`s.newUnreadIndex().IsUnread`), `wdb.EventsForResourceByType`, and `ttlCache`.
- Seams on `Server`, for tests:
  - `FetchPRSummaries func(token string, refs []wgithub.PRRef) (map[wgithub.PRRef]wgithub.PRSummary, error)`
  - `FetchReviewThreads func(token string, ref wgithub.PRRef) (*wgithub.PRReviewThreads, error)`
  - Both default to the library functions.
- Candidates: the worktree's tracked `pr` resources (`resources.Load`). `HeadRefName` comes from the cached `FetchPRSummaries`, and `UpdatedAt` from the resource's cached watcher state (`watcherdb.GetResourceState`, its row's update time).
- Caching (`ttlCache.get`, with errors not cached):
  - `"prsum|"+id` for 10 min.
  - `"prthreads|"+id` for 60s.
- Produces three routes.
  - `GET /api/pr-comments?path=` returns a summary:
```json
{"state":"ok|off|no_token|no_pr|error","branch":"…","message":"…",
 "pr":{"id":"o/r#1","number":1,"url":"…"},
 "fingerprint":"…","open_threads":3,"unread_comments":2,"unread_ids":[11,12]}
```
  - `GET /api/pr-comments/threads?path=&old_rev=&new_rev=`. The revs are optional, and both must be in `revSet` (404 otherwise, as with review-comments). It returns `{state, pr, fingerprint, threads:[prThreadDTO]}`:
```json
{"id":"T_1","resolved":false,"outdated":false,"file":"a.go","side":"new",
 "start_line":10,"end_line":12,
 "view":{"status":"shown","start_line":10,"end_line":12,"moved":false},
 "comments":[{"id":11,"author":"octo","avatar_url":"…","body":"…","created_at":"…",
              "url":"…","pending":false}]}
```
    - `start_line`/`end_line` are the anchor's, or GitHub's `OriginalStartLine`/`OriginalLine` when unplaceable.
    - Threads are sorted open first, then by file and line.
  - `GET /api/pr-comments/locate?event_id=` returns `{path, comment_id}` or 404.
    - It loads the event (`wdb.GetEvent`), takes its resource from `watcher_event_resources`, and finds worktrees tracking that PR whose current branch equals the PR's head.
    - It prefers `?prefer_path=` when given, then the first such worktree.
    - It matches the comment through `MatchEvents` against that PR's cached threads.

- [ ] **Step 1: Failing tests**, with an `httptest` server and the seams stubbed.
  - `TestPRCommentsOffMakesNoCall`: `watchers.github:false` gives `state:"off"`, and the fetch stubs are never called.
  - `TestPRCommentsNoPR`: a tracked PR whose head isn't the branch gives `state:"no_pr"` with `branch`.
  - `TestPRCommentsSummary`: two open threads and one resolved, with one unread event tagged `comment:11` past the cursor and one own event. Asserts `open_threads:2`, `unread_ids:[11]`, and the fingerprint equals `prcomments.Fingerprint`.
  - `TestPRCommentsCachesFetch`: two summary calls within 60s give one `FetchReviewThreads` call.
  - `TestPRCommentsErrorNotCached`: the first fetch errors, giving `state:"error"` with a message. The second call fetches again.
  - `TestPRCommentsThreadsView`: given revs from a real `/api/worktree-diff/patch`, asserts a thread's `view.status == "shown"`. Unknown revs give 404.
  - `TestPRCommentsLocate`: an untagged event matches by fallback and returns the worktree path and comment id. An event of another type gives 404.
- [ ] **Step 2:** Run them and confirm they fail. **Step 3:** Implement and register the routes. **Step 4:** `go build ./... && go vet ./... && go test ./...` passes.
- [ ] **Step 5: Commit:** `feat(webui): PR comments summary, threads and locate routes`.

### Task 7: UI data layer

**Files:**
- Modify: `ui/src/api/types.ts`, `ui/src/api/client.ts`, `ui/src/hooks/useReviewSidebar.ts`
- Create:
  - `ui/src/hooks/usePRComments.ts`
  - `ui/src/hooks/usePRComments.test.ts`
  - `ui/src/lib/reviewCounts.ts`
  - `ui/src/lib/reviewCounts.test.ts`

**Interfaces:**
- Produces:
```ts
// types.ts
export type CommentSource = "draft" | "pr"
export interface PRRefDTO { id: string; number: number; url: string }
export interface PRCommentsSummary { state: "ok"|"off"|"no_token"|"no_pr"|"error"; branch?: string; message?: string;
  pr?: PRRefDTO; fingerprint?: string; open_threads: number; unread_comments: number; unread_ids: number[] }
export interface PRThreadComment { id: number; author: string; avatar_url?: string; body: string; created_at: string; url: string; pending: boolean }
export interface PRThread { id: string; resolved: boolean; outdated: boolean; file: string; side: CommentSide;
  start_line: number; end_line: number; view?: { status: ViewStatus | "unavailable"; start_line?: number; end_line?: number; moved?: boolean };
  comments: PRThreadComment[] }
export interface PRThreads { state: PRCommentsSummary["state"]; pr?: PRRefDTO; fingerprint?: string; threads: PRThread[] }
// client.ts
prComments(path: string): Promise<PRCommentsSummary>
prThreads(path: string, view?: { oldRev: string; newRev: string }): Promise<PRThreads>
locatePRComment(eventId: string, preferPath?: string): Promise<{ path: string; comment_id: number }>
// usePRComments.ts
usePRCommentsSummary(path: string)           // ["pr-comments", path], refetchInterval 5000
usePRThreads(path: string, view: {oldRev,newRev} | undefined, refreshKey: number) // ["pr-threads", path, oldRev, newRev, refreshKey], staleTime Infinity
useShowPRComments(): [boolean, (on: boolean) => void]  // localStorage "worktree.showPRComments", default true, storage-blocked safe
// useReviewSidebar.ts
export type ReviewTab = "local" | "pr"
useReviewSidebarTab(): [ReviewTab, (t: ReviewTab) => void] // sessionStorage "worktree.reviewSidebarTab", default "local"
// reviewCounts.ts
codeTabLabel(local: number, pr: number, unread: number): string
toolbarLabel(local: number, pr: number, unread: number): string
countsAreUnread(local: number, unread: number): boolean
```

- [ ] **Step 1: Failing tests.**
  - `reviewCounts.test.ts`:
    - `codeTabLabel(0,0,0) === "Review changes"`
    - `codeTabLabel(2,5,3) === "Review changes (2 pending local comments, 5 PR comments (3 unread))"`
    - `codeTabLabel(1,1,0) === "Review changes (1 pending local comment, 1 PR comment)"`
    - `codeTabLabel(0,4,0) === "Review changes (4 PR comments)"`
    - `toolbarLabel(2,5,3) === "2 pending local review comments, 5 PR review comments (3 unread)"`
    - `toolbarLabel(0,1,1) === "1 PR review comment (1 unread)"`
    - `countsAreUnread(0,0) === false`, `countsAreUnread(0,1) === true`, `countsAreUnread(1,0) === true`
  - `usePRComments.test.ts`:
    - `useShowPRComments` defaults to true and persists false.
    - With `getItem` throwing, it still toggles.
- [ ] **Step 2:** Run them and confirm they fail. **Step 3:** Implement. **Step 4:** `npm --prefix ui test -- --run` passes.
- [ ] **Step 5: Commit:** `feat(ui): PR comments data hooks, sidebar tab store and count labels`.

### Task 8: `PRThreadCard`

**Files:**
- Modify: `ui/src/components/gitdiff/ReviewCommentCard.tsx` (export `Frame` and `Body`, and add `SOURCE_STYLE.pr`)
- Create: `ui/src/components/gitdiff/PRThreadCard.tsx`, `ui/src/components/gitdiff/PRThreadCard.test.tsx`
- Modify: `ui/src/components/MarkAllReadButton.tsx` (optional `onMarked?: () => void`, called after a successful mark)

**Interfaces:**
- Consumes: Task 7's types, `UnreadMarkerDot`, `MarkAllReadButton` (single form), `useReviewSidebar`, and `useReviewSidebarTab`.
- Produces:
```tsx
PRThreadCard({ path, thread, pr, variant, unreadIds, prResource, onJump }: {
  path: string; thread: PRThread; pr: PRRefDTO; variant: "inline" | "sidebar";
  unreadIds: ReadonlySet<number>; prResource?: ResourceDTO; onJump?: () => void })
```
  - `SOURCE_STYLE.pr = { borderColor: "var(--mantine-color-grape-6)", author: "", authorTip: "A comment on the PR, from GitHub." }`. The author line is built per comment.
  - The `Frame` takes the source, so the PR card's frame is grape.
  - **Each comment:** avatar (`Avatar` size 16), `@login on PR #n`, relative time, a `Pending` badge when pending, and an unread dot when its id is in `unreadIds`.
  - **First comment's line** also has `View all`, inline only. It calls `setReviewOpen(true)` and `setTab("pr")`. It also has `View on GitHub`, an anchor to `comment.url` with `target="_blank" rel="noreferrer"`.
  - **Sidebar variant:** a `file:line` jump anchor (disabled for `unavailable`/`outside_changes`) instead of `View all`.
  - `Outdated` badge when `view.status === "outdated"` or `thread.outdated`.
  - **Unread threads:** when any comment is unread and `prResource` is given, `<MarkAllReadButton single resources={[prResource]} feed={{ worktree: path, path, showResource: false }} taskScope={{ kind: "resource", type: "pr", id: prResource.id }} onMarked={…invalidate ["pr-comments", path]} />` renders under the thread.
  - **A resolved thread** renders collapsed as one `UnstyledButton` line: `Resolved · @login · file:line — <first 40 chars>…`. Clicking expands it.

- [ ] **Step 1: Failing tests**, using `PRThreadCard.test.tsx` with a `MarkAllReadButton` mock.
  - It renders `@octo on PR #12`, with `View on GitHub` linking to `comment.url` and opening a new tab.
  - The inline variant shows `View all`. Clicking it sets sidebar open and tab `pr`.
  - Replies render under the first comment.
  - A pending comment shows `Pending`.
  - With unread ids, there's an unread dot and the `Mark all read` button is rendered. With none, there's no button.
  - A resolved thread starts collapsed with the one-line text, and a click shows its body.
  - The frame's border uses `grape`.
- [ ] **Step 2:** Run them and confirm they fail. **Step 3:** Implement. **Step 4:** UI tests pass.
- [ ] **Step 5: Commit:** `feat(ui): read-only PR thread card`.

### Task 9: Sidebar tabs and the PR tab

**Files:**
- Modify: `ui/src/components/gitdiff/ReviewSidebar.tsx`
- Create: `ui/src/components/gitdiff/PRCommentsTab.tsx`
- Test: `ui/src/components/gitdiff/ReviewSidebar.test.tsx` (extend or create)

**Interfaces:**
- Consumes: Tasks 7 and 8.
- Produces:
  - New `ReviewSidebar` props: `pr: { summary?: PRCommentsSummary; threads?: PRThreads; prResource?: ResourceDTO; onJumpThread: (t: PRThread) => void }`.
  - The local tab body is phase 1's content, unchanged.
  - Mantine `Tabs` with `Local comments (N)` and `PR comments (N)`, where N is `open_threads`. The value comes from `useReviewSidebarTab`.
  - `PRCommentsTab({ path, summary, threads, prResource, onJumpThread })`:
    - The `Show in diff view` `Switch` (from `useShowPRComments`).
    - Then `PR #n` linking to `pr.url`.
    - Then cards, with open threads first and resolved last.
    - The empty or state copy comes from the Global Constraints. For `state:"error"`, it shows `Couldn't load PR comments: <message>`.

- [ ] **Step 1: Failing tests.**
  - Both tabs render with counts. Switching tabs persists through `useReviewSidebarTab`.
  - The PR tab with `state:"no_pr", branch:"x"` shows `No tracked PR for branch x`.
  - With `state:"off"`, it shows the off copy.
  - Toggling the switch calls the setter.
  - The local tab still shows `Copy comments for agent`.
- [ ] **Step 2:** Run them and confirm they fail. **Step 3:** Implement. **Step 4:** UI tests pass.
- [ ] **Step 5: Commit:** `feat(ui): Local / PR comments tabs in the review sidebar`.

### Task 10: Diff view integration

**Files:**
- Modify: `ui/src/components/gitdiff/DiffView.tsx`, `ui/src/components/gitdiff/DiffBody.tsx`
- Test: `ui/src/components/gitdiff/DiffView.test.tsx`, `ui/src/components/gitdiff/DiffBody.test.tsx`

**Interfaces:**
- Consumes: Tasks 7, 8 and 9.
- Behaviour:
  - **Thread data:**
    - The thread list is `usePRThreads(path, shown ? {oldRev,newRev} : undefined, prRefresh)`, and `usePRCommentsSummary(path)` is polled.
    - `prStale = summary.fingerprint !== undefined && threads.fingerprint !== undefined && summary.fingerprint !== threads.fingerprint`.
  - **Stale view:**
    - The existing stale strip shows when `stale || prStale`. Its text is `Files changed on disk ·`, `New PR comments ·`, or `Files changed on disk, new PR comments ·`.
    - Refresh does what it does today, and also bumps `prRefresh`.
  - **Annotations:**
    - `CommentAnnotation` gains `threads: PRThread[]`.
    - When `useShowPRComments()` is on, threads with `view.status === "shown"` are added at `view.end_line` on their side, with the same fold-expansion rule as drafts.
    - `renderAnnotation` renders `PRThreadCard variant="inline"` for each.
  - **File tree dots:** `commentedFiles` includes shown thread files while the switch is on.
  - **Toolbar button:**
    - Shown when `local > 0 || open_threads > 0`.
    - Its label is `toolbarLabel(local, open_threads, unread_comments)`, and it's filled blue only when `countsAreUnread`.
    - Mounting and auto-closing the sidebar use the same condition. The phone drawer's title is `Review comments`.
  - **Jump to a thread:** `onJumpThread` scrolls to the thread like `showComment`. The card carries `data-pr-thread-id`, and `scrollToComment` gets a selector variant.
  - **`&prcomment=<id>` in the URL:** on mount, it does `setShowPR(true)`, `setReviewOpen(true)` and `setTab("pr")`. Once threads load, it jumps to the thread containing that comment id, or scrolls the sidebar card into view when the thread isn't `shown`. Then it drops the param with `replace`.
  - **The PR `ResourceDTO`:** for Mark all read, it's taken from the worktree's resources query (`["resources", path]`, `api.worktreeResources`) by `summary.pr.id`.

- [ ] **Step 1: Failing tests,** in `DiffView.test.tsx`, mocking the client.
  - A summary with `open_threads:2, unread_comments:1` and no local comments gives a button with text `2 PR review comments (1 unread)` and `data-variant="filled"`.
  - With `unread_comments:0` and no local comments, the variant is `light`.
  - A summary fingerprint that differs from the threads' fingerprint shows `New PR comments ·` with Refresh. Clicking it refetches the threads.
  - With the switch off, no `data-pr-thread-id` is inline.
  - `?diff&prcomment=11` opens the sidebar on the PR tab.
  - `DiffBody.test.tsx`: a shown thread becomes an annotation at its `end_line`, with the pierre mock recording `lineAnnotations`.
- [ ] **Step 2:** Run them and confirm they fail. **Step 3:** Implement. **Step 4:** UI tests and the build pass.
- [ ] **Step 5: Commit:** `feat(ui): PR threads inline in the diff view, stale on new comments, toolbar counts`.

### Task 11: Code tab button

**Files:**
- Modify: `ui/src/components/gitdiff/GitDiffPanel.tsx`, `ui/src/components/gitdiff/GitDiffPanel.test.tsx`

- [ ] **Step 1: Failing tests,** with `api.prComments` mocked.
  - Two local comments plus `open_threads:5, unread_comments:3` give a button named `Review changes (2 pending local comments, 5 PR comments (3 unread))`, filled.
  - Zero local comments with `open_threads:4, unread_comments:0` give `Review changes (4 PR comments)` with the `light` variant.
  - Existing tests still pass, with `prComments` mocked to `state:"no_pr"`.
- [ ] **Step 2:** Run them and confirm they fail. **Step 3:** Use `usePRCommentsSummary(path)`, `codeTabLabel` and `countsAreUnread`. **Step 4:** UI tests pass.
- [ ] **Step 5: Commit:** `feat(ui): Code tab button counts PR comments`.

### Task 12: "Go to comment in diff view" from the activity modal

**Files:**
- Modify: `ui/src/components/EventDetailsModal.tsx`, `ui/src/components/EventDetailsModal.test.tsx`

- [ ] **Step 1: Failing tests.**
  - For `type: "pr_review_comment"`, with `api.locatePRComment` resolving `{path:"/w/a", comment_id:11}`, a `Go to comment in diff view` button appears. Clicking it closes the modal and navigates to `/worktree/%2Fw%2Fa?diff&prcomment=11`.
  - When locate rejects (404), there's no button.
  - Other event types never call locate.
- [ ] **Step 2:** Run them and confirm they fail. **Step 3:** Implement with `useQuery(["pr-comment-locate", e.id, path], …, { enabled: e?.type === "pr_review_comment", retry: false })`, beside the "Make task" button. **Step 4:** UI tests pass.
- [ ] **Step 5: Commit:** `feat(ui): jump from a PR review comment event to the diff view`.

### Task 13: Docs, install and full verification

**Files:**
- Modify: `docs/web-ui-architecture.md` ("Code tab and diff view", "Review comments", "Unread"), `.claude/CLAUDE.md` (the `prcomments` package line and the `webui` routes sentence)
- Modify: `docs/superpowers/specs/2026-10-23-review-comments-roadmap.md` (phase 2 status: Done, with the design link)

- [ ] **Step 1:** Write the docs. Cover:
  - the routes and their states;
  - the 60s/10m cache;
  - the fingerprint-raises-Refresh rule;
  - the event `comment:` tag and the fallback match;
  - the counts rule;
  - the `worktree.showPRComments` and `worktree.reviewSidebarTab` keys;
  - the `&prcomment=` param.
- [ ] **Step 2:** Run `go build ./... && go vet ./... && go test ./...`, `npm --prefix ui test -- --run` and `npm --prefix ui run build`. All must pass.
- [ ] **Step 3: Commit:** `docs: PR comments in the diff view`.
- [ ] **Step 4:** `NONINTERACTIVE=1 make install`. Then notify Mike (`notify -k done`) that it's ready to try.
