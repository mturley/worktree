# Writing to the PR from the diff view: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Comment, reply and submit PR reviews on GitHub from the diff view. New comments get three save buttons (local, PR review, comment now), replies get two, and a submit dialog handles the review. PRs are matched by number, and local comments are reconciled so none is lost or posted twice.

**Architecture:**
- **Library:** the watcher library gains a PR write context (the PR's node id, viewer-is-author, Mike's pending review and its commit and comments), plus write calls:
  - GraphQL for pending-review operations;
  - REST for single comments and replies.

  It's released as v0.18.0 and re-pinned here.
- **Server:**
  - matches the worktree's PR by number, via its `refs/pull/<N>/head` tracking;
  - decides postability against a target commit (the pending review's commit, else the PR head) and the PR's diff hunks;
  - serves check, comment, reply and submit routes.
- **UI:**
  - adds the editor buttons, Reply on threads, and the submit modal;
  - shows the pending review on the toolbar button, the PR tab and the Code tab button.

**Tech Stack:** Go (watcher library, worktree `internal/`), SQLite, GitHub GraphQL and REST, React + Mantine + react-query, vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-submit-review-design.md`. Context: `docs/superpowers/specs/2026-10-26-pr-comments-design.md`, `docs/web-ui-architecture.md` ("PR comments", "Review comments").

## Global Constraints

- **Gating:** every GitHub call goes through the watcher library and is gated on `s.WatcherEnabled(config.ServiceGitHub)`.
- **Releasing the library:** library changes go in `~/git/watcher` with tests, then a commit and the tag `v0.18.0`. **Ask Mike before pushing**, then `go get github.com/mturley/watcher@v0.18.0 && go mod tidy` here.
- **No GitHub writes against real PRs during development.** Tests use `httptest` servers and stubs only. Mike verifies live at the end.
- **No PR, no GitHub buttons:** every GitHub button (PR review, Comment on PR, Reply on PR, Submit review) is **hidden** when the worktree has no PR. With a PR but the watcher off, they are disabled, with a tooltip saying why.
- **Exact button labels** (PR number substituted):
  - Local: `Start local review` with no local comments, else `Add local comment`.
  - PR review: `Start a PR review on #1234` with no pending review, else `Add to PR review #1234`.
  - Comment now: `Comment on PR #1234`.
  - Reply now: `Reply on PR #1234`.
  - Submit: `Submit review to PR #1234…`.
- **Exact tooltips (enabled):**
  - Local: `Save this comment only in worktree, as part of your local review. Nothing is posted to GitHub. You can copy your local review for an agent, or include it when you submit a PR review.`
  - PR review: `Add this comment to your pending review on PR #1234. Only you can see it until you submit the review.`
  - Comment now: `Post this comment on PR #1234 now, as a single comment everyone can see.`
  - Reply now: `Post this reply on PR #1234 now. Everyone can see it.`
  - Submit: `Submit your pending review on PR #1234, with a message and Comment, Approve or Request changes.`
- **Unpostable reasons, exact:** `on uncommitted changes`, `on a commit not pushed to the PR`, `newer than your pending review`, `out of date`, `not part of the PR's changes`.
  - `newer than your pending review` applies when a pending review exists on an older commit, and the comment's rev is a commit in the PR (an ancestor of the PR head) that came after the pending review's commit.
- **Stale pending review notice** (submit dialog, PR tab, and the PR-review button's tooltip while it's disabled): `Your pending review on PR #1234 is on an older commit (abc1234). Comments on newer code can't be added to it; submit it to start a new one.` It's shown whenever the pending review's commit ≠ the PR head.
- **Review events, with GitHub's wording:**
  - `Comment`: "Submit general feedback without explicit approval."
  - `Approve`: "Give your approval to merge these changes."
  - `Request changes`: "Submit feedback that must be addressed before merging."

  Approve and Request changes are disabled on Mike's own PR.
- **Pending-review copy:**
  - Toolbar suffix: `pending PR review (N comments)`.
  - Tab label: `PR comments (N) · pending review`.
  - Code tab suffix: `pending PR review`.
  - Notice: `You have a pending review on PR #1234 (N comments)`.
  - Toast: `Review submitted to PR #1234`.
  - Head moved: `PR #1234 has new commits — review the list again`.
  - Missing commit: `Fetch the PR's latest commits first`.
- **Reconcile:** a local comment is deleted only once GitHub's pending (or submitted) review contains the comment id its add returned, and only if its `version` is unchanged since it was sent.
- **Never shift code on a poll.** Writes are user actions, and reload only the threads, never the patch.
- **Commits:** `--signoff`, files named one by one, with the trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01SuJzq5SpFU21xdG96SXY6e`.
- **Commands:**
  - Library: `cd ~/git/watcher && go test ./...`.
  - Worktree: `go build ./... && go vet ./... && go test -timeout 30m ./...`, `npm --prefix ui test -- --run`, `npm --prefix ui run build`.
- **Tests:** don't add tests that assert removed code stays removed.

## Review Focus

1. **A pending review created on an older commit:** comments added to it must be positioned against **that review's commit**, not the current head. Otherwise lines land in the wrong place. Pinned in Task 4.
2. **A submit retried after a partial failure** (some adds succeeded, then an error): nothing is duplicated, and only confirmed comments are cleared locally. Pinned in Task 6.
3. **A review worktree whose branch is `review/pr-N-slug`** shows the PR's comments, and its buttons target PR #N. Pinned in Task 3.
4. **A multi-line comment that crosses two hunks** is "not part of the PR's changes", never sent. Pinned in Task 4.
5. **A local comment edited while the submit is in flight** stays local, even though GitHub received the older text. Pinned in Task 6.

---

### Task 1: Library: PR write context and pending-review writes (GraphQL)

**Files:** Create `~/git/watcher/github/reviews.go` and `~/git/watcher/github/reviews_test.go`.

**Interfaces, produced:**
```go
type PRWriteContext struct {
	PullRequestID   string // GraphQL node id
	HeadRefOid, BaseRefOid string
	ViewerDidAuthor bool
	Pending         *PendingReview // nil when Mike has none
}
type PendingReview struct {
	ID        string // node id
	CommitOid string // the commit the review is against
	Comments  []PendingComment
}
type PendingComment struct{ DatabaseID int64; Path, Body string }
type NewReviewComment struct {
	Path string
	Side string // "LEFT" | "RIGHT"
	Line, StartLine int // StartLine 0 for a single line
	Body string
}
func FetchPRWriteContext(token string, ref PRRef, apiURL ...string) (*PRWriteContext, error)
func StartReview(token, pullRequestID, commitOid string, apiURL ...string) (reviewID string, err error)
func AddReviewThread(token, reviewID string, c NewReviewComment, apiURL ...string) (commentID int64, err error)
func AddReviewReply(token, reviewID, threadID, body string, apiURL ...string) (commentID int64, err error)
func SubmitReview(token, reviewID, event, body string, apiURL ...string) error // event: COMMENT | APPROVE | REQUEST_CHANGES
```

- [ ] **Step 1: Failing tests,** with `httptest`, in the style of `threads_test.go`.
  - `TestFetchPRWriteContext`: the query contains `viewerDidAuthor` and `reviews(states: PENDING`. Asserts the fields map, including the pending review's `commit.oid` and its comments' `fullDatabaseId`, and `Pending == nil` when `reviews.nodes` is empty.
  - `TestStartReview`: the mutation is `addPullRequestReview` with `pullRequestId` and `commitOID` and **no** `event`. It returns the review id.
  - `TestAddReviewThread`: `addPullRequestReviewThread` sends `pullRequestReviewId`, `path`, `line`, `side`, `body`, plus `startLine`/`startSide` only when `StartLine > 0`. It returns the comment's `fullDatabaseId`.
  - `TestAddReviewReply`: `addPullRequestReviewThreadReply` sends `pullRequestReviewId` and `pullRequestReviewThreadId`.
  - `TestSubmitReview`: `submitPullRequestReview` sends `event` and `body`.
  - `TestWriteErrorsSurface`: GraphQL `errors` with HTTP 200 gives an error carrying the first message. HTTP 401 wraps `ErrAuth`.
- [ ] **Step 2:** Run the tests and confirm they fail.
- [ ] **Step 3: Implement.**
  - Reuse `postGraphQL` and the `fullDatabaseID` decoder.
  - Mutations always check the `errors` array.
  - Strings go into queries through GraphQL variables (`{"query":…,"variables":…}`), never by interpolating them.
  - Extend `postGraphQL` with an optional variables map, keeping its existing callers unchanged.
- [ ] **Step 4:** `go test ./...` passes.
- [ ] **Step 5: Commit:** `feat(github): PR write context and pending-review writes`.

### Task 2: Library: single comments and replies (REST), and release

**Files:** Modify `~/git/watcher/github/reviews.go` and `reviews_test.go`.

**Interfaces, produced:**
```go
func PostComment(token string, ref PRRef, commitOid string, c NewReviewComment, apiURL ...string) (commentID int64, err error)
// REST POST /repos/{o}/{r}/pulls/{n}/comments {body, commit_id, path, line, side[, start_line, start_side]}
func PostReply(token string, ref PRRef, inReplyTo int64, body string, apiURL ...string) (commentID int64, err error)
// REST POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies {body}
```
- [ ] **Step 1: Failing tests.**
  - `TestPostComment`: method, path and JSON body as above. Sends `start_line`/`start_side` only for a range. Returns `id`.
  - `TestPostReply`: path and `{body}`.
  - An error status gives an error with the response's `message`.
  - The REST base defaults to `https://api.github.com`, and `apiURL` overrides it.
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement, with a small `postREST(token, url string, body any) ([]byte, error)`, using the `Authorization: Bearer` and `Accept: application/vnd.github+json` headers. **Step 4:** `go test ./...` passes.
- [ ] **Step 5: Commit:** `feat(github): post single PR comments and replies`.
- [ ] **Step 6:** Tag `v0.18.0`. **Ask Mike** before `git push origin main && git push origin v0.18.0`.

### Task 3: Re-pin, PR matching by number, and the pending review in the summary

**Files:**
- Modify: `go.mod`, `go.sum`, `internal/gitutil/refs.go`, `internal/gitutil/diff.go`, `internal/prcomments/prcomments.go`, `internal/webui/pr_comments_api.go`
- Tests: alongside each of those.

**Interfaces, produced:**
```go
// gitutil
func TrackedPRNumber(dir string) (int, bool) // branch.<current>.merge == refs/pull/<N>/head
type Hunk struct{ OldStart, OldLines, NewStart, NewLines int }
func DiffHunks(dir, oldRev, newRev string) (map[string][]Hunk, error) // keyed by new path; deleted files by old path; default context (3)
// prcomments
type Candidate struct { ID string; Primary bool; UpdatedAt string; HeadRefName string; Number int; RepoIsRemote bool }
func PickPR(cands []Candidate, branch string, trackedNumber int) (Candidate, bool)
func PendingCount(t *wgithub.PRReviewThreads) int // comments with Pending == true
```
`PickPR`'s rule:
1. A candidate with `Number == trackedNumber && RepoIsRemote` wins, and only those are considered.
2. Otherwise it's the head-branch match as before.
3. Ties go primary first, then newest.

The summary DTO gains `"pending_comments": N` (0 when none), and `prCommentsSummaryDTO`/`prThreadsResponse` gain `"viewer_is_author": bool`. `viewer_is_author` comes from `FetchPRWriteContext`, cached under `prctx|<id>` for 60s with the 20s error TTL (`cachedPRWriteContext(token, id, ref)`, which Tasks 4–6 reuse). `pending_comments` is `prcomments.PendingCount(threads)`, so it costs no extra call.

- [ ] **Step 1: Failing tests.**
  - `TestTrackedPRNumber`, on a `testgit` repo: set `branch.<b>.merge refs/pull/42/head` and assert 42. Assert false for a normal upstream.
  - `TestDiffHunks`: two edits 20 lines apart in one file give two hunks, with correct starts and counts.
  - `TestPickPRByNumber`:
    - The tracked number wins over a head-branch match.
    - A number match whose `RepoIsRemote` is false is ignored.
    - With no number, it falls back to the branch.
  - `TestPRCommentsReviewWorktree`: a worktree on `review/pr-7-x` tracking `refs/pull/7/head`, with tracked PR `o/r#7` and a remote URL ending `o/r`. Assert `state: "ok"`, `pr.number: 7`, and `pending_comments` counted from stub threads.
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Run `go get github.com/mturley/watcher@v0.18.0 && go mod tidy`, then implement. `RepoIsRemote` uses `gitutil.MatchesRemote(dir, owner, repo)`. **Step 4:** `go build ./... && go vet ./... && go test -timeout 30m ./...` passes.
- [ ] **Step 5: Commit:** `feat(webui): match a worktree's PR by number; pending review count`.

### Task 4: Postability against the target commit

**Files:** Create `internal/webui/pr_post.go` and `internal/webui/pr_post_test.go`.

**Interfaces, produced:**
```go
type prTarget struct {
	ref        wgithub.PRRef
	ctx        *wgithub.PRWriteContext
	commit     string // ctx.Pending.CommitOid when a pending review exists, else ctx.HeadRefOid
	mergeBase  string // gitutil.MergeBaseOf(dir, ctx.BaseRefOid, commit)
	hunks      map[string][]gitutil.Hunk // gitutil.DiffHunks(dir, mergeBase, commit)
}
type prPlacement struct {
	ok     bool
	reason string // one of the exact reasons; "" when ok
	comment wgithub.NewReviewComment // Path/Side/Line/StartLine filled when ok
}
func (s *Server) loadPRTarget(dir string, pc prComments) (*prTarget, error) // errMissingCommit when commit or mergeBase isn't local after one fetch nudge
func placeForPR(dir string, t *prTarget, c reviewcomments.Comment, lines func(rev, file string) []string, isAncestor func(rev string) bool) prPlacement
```
The rules are the spec's "Which comments can be posted":
- Re-check the anchor on the target commit, or on `mergeBase` for old-side comments, with `reviewcomments.Resolve`.
- Give reasons in this order:
  1. an `uncommitted` rev;
  2. not an ancestor of the target commit (new side only): `newer than your pending review` if the rev is an ancestor of the PR head and the target is an older pending review's commit, else `on a commit not pushed to the PR`;
  3. not resolved: `out of date`;
  4. outside the hunks, or crossing two hunks: `not part of the PR's changes`.
- `prTarget` also exposes `stale bool` (pending review's commit ≠ `ctx.HeadRefOid`) and `pendingCommit string`, for the notice.
- New side maps to `RIGHT` and old side to `LEFT`.

- [ ] **Step 1: Failing tests,** using `forkRepo`/`commitFile` helpers like `pr_threads_place_test.go`.
  - `TestPlaceForPRPostable`: a comment on a changed line at head gives `ok`, `RIGHT`, and the right `Line`.
  - `TestPlaceForPRUncommitted` and `TestPlaceForPRNotPushed`: a rev not an ancestor of the target gives the exact reasons.
  - `TestPlaceForPROutOfDate`: the line was changed after the comment.
  - `TestPlaceForPRContextOnly`: a line outside every hunk gives `not part of the PR's changes`.
  - `TestPlaceForPRCrossesHunks`: a range spanning two hunks gives `not part of the PR's changes`.
  - `TestPlaceForPROldSide`: a removed line resolves at `mergeBase` and gives `LEFT`.
  - `TestPRTargetUsesPendingCommit`: with `ctx.Pending.CommitOid` older than head, `commit` is the pending review's commit and `stale` is true. A line that moved between the two is placed at the pending commit's line.
  - `TestPlaceForPRNewerThanPending`: a comment on a commit made after the pending review's commit (still in the PR) gives `newer than your pending review`.
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement. Ancestry is `git merge-base --is-ancestor`; add `gitutil.IsAncestor(dir, a, b string) bool`, with its own test. **Step 4:** `go test ./internal/webui -run PlaceForPR` passes.
- [ ] **Step 5: Commit:** `feat(webui): decide which comments GitHub will accept`.

### Task 5: Check, comment and reply routes

**Files:**
- Create: `internal/webui/pr_write_api.go`, `internal/webui/pr_write_api_test.go`
- Modify: `internal/webui/server.go` (routes; seams `StartReview`, `AddReviewThread`, `AddReviewReply`, `PostComment`, `PostReply`, `FetchPRWriteContext`, defaulting to the library)

**Routes:**
- `GET /api/pr-write/check?path=&file=&side=&start_line=&end_line=&old_rev=&new_rev=` returns `{review: {postable, reason?}, single: {postable, reason?}}`. `review` is placed against the pending-aware target, and `single` against the PR head (amended in Task 5's fix round).
  - It captures an anchor from the view's rev (as review-comments create does, requiring the revs in `revSet`), then calls `placeForPR`.
  - It returns `{postable:false, reason:"Fetch the PR's latest commits first"}` on `errMissingCommit`.
- `POST /api/pr-write/comment {path, mode: "review"|"single", file, side, start_line, end_line, body, old_rev, new_rev}` returns `{comment_id}`.
  - `review`: `StartReview` (when there's no pending review) then `AddReviewThread`.
  - `single`: `PostComment` at the target commit.
  - Refuses an unpostable placement with 409 `{reason}`.
- `POST /api/pr-write/reply {path, thread_id, in_reply_to, mode: "review"|"single", body}` returns `{comment_id}`.
  - `review`: start a review if needed, then `AddReviewReply`.
  - `single`: `PostReply(in_reply_to)`.
- Every route:
  - answers 404 when the worktree has no PR;
  - answers 409 `{state:"off"}` when the watcher is off, with no GitHub call;
  - after a successful write, deletes the `prthreads|<id>` and `prctx|<id>` cache entries;
  - caps the body at `maxReviewCommentBody`.

- [ ] **Step 1: Failing tests,** with stubbed seams and real repos.
  - `TestPRWriteCheck`: covers both postable and each reason.
  - `TestPRWriteCommentReviewStartsReview`: there's no pending review. `StartReview` is called with the target commit, then `AddReviewThread` with the placed lines.
  - `TestPRWriteCommentReviewAddsToExisting`: there's a pending review. `StartReview` isn't called.
  - `TestPRWriteCommentSingle`: `PostComment` gets the target commit.
  - `TestPRWriteReplyModes`: covers both modes.
  - `TestPRWriteOffMakesNoCall`.
  - `TestPRWriteNoPR404`.
  - `TestPRWriteInvalidatesCache`.
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement. **Step 4:** `go test ./internal/webui -run PRWrite` passes.
- [ ] **Step 5: Commit:** `feat(webui): comment and reply on the PR from the diff view`.

### Task 6: The submit route, with reconciliation

**Files:** Modify `internal/webui/pr_write_api.go` and `internal/webui/pr_write_api_test.go`. Modify `internal/reviewcomments/store.go`: add `DeleteIfVersion(conn, path, id, version) (bool, error)`, with a test.

**Routes:**
- `GET /api/pr-write/review?path=` returns the dialog's data:
```json
{"pr":{…},"viewer_is_author":bool,"head":"<target commit>","stale_pending_commit":"<short sha>"|null,
 "pending":{"comments":[{"id","file","line","body"}]}|null,"blocked_reason":"Fetch the PR's latest commits first"|null,
 "local":[{"id","version","file","side","start_line","end_line","body","postable","reason"}]}
```
- `POST /api/pr-write/submit {path, head, event, body, include_local}` returns `{submitted_review_id, posted_local_ids:[…], kept_local_ids:[…]}`.
  1. Re-read the write context. If the target commit ≠ `head`, return 409 `{reason: "PR #N has new commits — review the list again"}`.
  2. If `include_local`, add each postable local comment to the pending review (start one if needed), recording `local id → (comment id, version)`. Keep going past individual failures, collecting the first error.
  3. **Reconcile:** re-fetch the context. For each recorded pair whose comment id is in `ctx.Pending.Comments`, `DeleteIfVersion`. Only those are posted.
  4. If step 2 hit an error, return 502 with it, plus the reconciled `posted_local_ids`. The review isn't submitted.
  5. `SubmitReview(event, body)`, then invalidate the caches and return. A submit failure returns 502. The posted locals are already deleted, since they're pending on GitHub.
- An empty "Comment" (no body, no pending comments, nothing added) returns 400. Event values are `COMMENT|APPROVE|REQUEST_CHANGES`, and APPROVE/REQUEST_CHANGES return 400 when `viewer_is_author`.

- [ ] **Step 1: Failing tests.**
  - `TestSubmitHappyPath`: two postable and one unpostable comment. Two `AddReviewThread` calls, both deleted locally, one kept, `SubmitReview` called.
  - `TestSubmitExcludeLocal`: `include_local:false` adds nothing and deletes nothing.
  - `TestSubmitPartialAddFailure`: the second add errors. The first is deleted, the rest kept, there's no submit, and the response is 502.
  - `TestSubmitRetryNoDuplicate`: a retry after that adds only the kept ones.
  - `TestSubmitEditedMidFlight`: the version changes between the add and the reconcile. The comment is kept (`DeleteIfVersion` false).
  - `TestSubmitHeadMoved`: 409 with the exact reason, and no writes.
  - `TestSubmitSubmitFails`: the adds are reconciled (deleted) and the response is 502.
  - `TestSubmitOwnPRApproveRefused`.
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement. **Step 4:** `go test ./internal/webui -run 'Submit|PRWrite' ./internal/reviewcomments` passes.
- [ ] **Step 5: Commit:** `feat(webui): submit a PR review, reconciling local comments`.

### Task 7: UI data layer and labels

**Files:**
- Modify: `ui/src/api/types.ts`, `ui/src/api/client.ts`, `ui/src/lib/reviewCounts.ts` and its test
- Create: `ui/src/hooks/usePRWrite.ts` and its test

**Interfaces, produced:**
- `PRCommentsSummary` gains `pending_comments: number` and `viewer_is_author?: boolean`.
- Types `PRWriteCheck`, `PRReviewDialog` and `SubmitResult`, mirroring Tasks 5 and 6.
- Client:
  - `prWriteCheck(path, target: {file, side, start_line, end_line, old_rev, new_rev})`
  - `prWriteComment(req)`
  - `prWriteReply(req)`
  - `prReviewDialog(path)`
  - `prSubmit(req)`
- `usePRWriteCheck(path, target | undefined)` (returns `{review, single}` verdicts): react-query `["pr-write-check", path, …target]`, `staleTime: 30_000`, enabled only with a target and a PR.
- `usePRWriteMutations(path)`: `comment`, `reply` and `submit` mutations. On success they invalidate `["pr-comments", path]`, `["pr-threads", path]` and `["review-comments", path]`.
- Labels:
  - `toolbarLabel(local, pr, unread, pending)` appends `, pending PR review (N comment[s])`.
  - `codeTabLabel(local, pr, unread, pending)` appends `, pending PR review` inside the parentheses.
  - `countsAreUnread(local, unread, pending)` is true when any of the three is > 0.

- [ ] **Step 1: Failing tests** in `reviewCounts.test.ts`:
  - `toolbarLabel(2,5,3,2) === "2 pending local review comments, 5 PR review comments (3 unread), pending PR review (2 comments)"`
  - `toolbarLabel(0,0,0,1) === "pending PR review (1 comment)"`
  - `codeTabLabel(0,4,0,2) === "Review changes (4 PR comments, pending PR review)"`
  - `codeTabLabel(0,0,0,0) === "Review changes"`
  - `countsAreUnread(0,0,1) === true`

  Update the existing callers' tests to pass `pending` (0).
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement, then update the callers (`DiffView.tsx` toolbar, `ReviewActions.tsx`) to pass `summary.pending_comments`. **Step 4:** UI tests and the build pass.
- [ ] **Step 5: Commit:** `feat(ui): PR write data hooks; pending review in the button labels`.

### Task 8: Editor buttons and replies

**Files:**
- Modify: `ui/src/components/gitdiff/CommentEditor.tsx`, `ReviewCommentCard.tsx` (`NewCommentCard`), `PRThreadCard.tsx`, and their tests.

**Interfaces, produced:**
- `CommentEditor` gains `actions?: EditorAction[]`, used instead of `submitLabel`/`submitTooltip` when given:
```ts
type EditorAction = { key: string; label: string; tooltip: string; disabledReason?: string; onSubmit: (text: string) => void; variant?: "filled" | "light" }
```
  - Each action is a button.
  - A disabled action keeps its button, and its tooltip shows `disabledReason`.
  - Ctrl/Cmd+Enter runs the first enabled action.
  - The existing `submitLabel` path is unchanged.
- `NewCommentCard` has three actions when the worktree has a PR, in this order: local, PR review, comment now.
  - Labels and tooltips are the Global Constraints' exact copy. The local label depends on the local comment count. The PR review label depends on `summary.pending_comments > 0`.
  - The PR review action is disabled with the check's `review.reason`, and Comment now with `single.reason` (`usePRWriteCheck`), or with `The GitHub watcher is off` when `summary.state === "off"`.
  - Without a PR there's only the local action (`Start local review`/`Add local comment`), and no GitHub buttons render.
- `PRThreadCard` gets a `Reply` link under the thread (on resolved threads, once expanded). It opens a `CommentEditor` with two actions: PR review (`mode: "review"`) and `Reply on PR #1234` (`mode: "single"`).
  - Typed reply text uses `useEditorDraft(path, "reply:" + thread.id)`.
  - On success the editor closes. On failure the error shows and the text is kept.
  - It's hidden when the PR state is off or there's no PR.

- [ ] **Step 1: Failing tests.**
  - `CommentEditor`: actions render, a disabled action's tooltip shows its reason, and Ctrl+Enter runs the first enabled one.
  - `NewCommentCard`:
    - With a PR and no pending review: the labels are `Start local review`, `Start a PR review on #12` and `Comment on PR #12`.
    - With local comments and a pending review: `Add local comment` and `Add to PR review #12`.
    - Without a PR: only the local button.
    - When the check says `on uncommitted changes`: both GitHub buttons are disabled with that tooltip.
    - Clicking the PR review button calls `prWriteComment` with `mode:"review"`.
  - `PRThreadCard`: Reply opens the editor with the two labels. Posting calls `prWriteReply` with `in_reply_to` set to the first comment's id. There's no Reply without a PR.
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement. **Step 4:** UI tests pass.
- [ ] **Step 5: Commit:** `feat(ui): save new comments locally, to a PR review, or on the PR; reply to threads`.

### Task 9: The submit dialog

**Files:** Create `ui/src/components/gitdiff/SubmitReviewModal.tsx` and its test.

**Interfaces, produced:** `SubmitReviewModal({ path, opened, onClose })`. It loads `prReviewDialog(path)` when opened, and lays out the spec's dialog top to bottom. The whole modal scrolls (`Modal` with `scrollAreaComponent` left default and no inner `ScrollArea`/`max-height`).
1. A message `Textarea`.
2. A `Radio.Group` with the three events and their exact descriptions. Approve and Request changes are disabled with a tooltip when `viewer_is_author`.
3. The `Include my N local comments` checkbox. It's checked by default when any local comment is postable, and hidden when there are no local comments.
4. `In this review (N)`:
   - pending comments, labelled `Pending on GitHub` with the grape edge;
   - then, when included, the postable local comments, labelled `Local` with the blue edge;
   - each with `file:line` and its body.
5. The pending notice `Your pending review on PR #1234 (N comments) will be submitted.` When `stale_pending_commit` is set, the stale pending review notice (Global Constraints) is shown too.
6. The warning `N of M local comments can't be posted and will stay here`, listing each with its reason. It shows only when included.
7. `Cancel` and `Submit review`, with the count when there are comments. Submit is disabled for an empty Comment.

On success: close, toast `Review submitted to PR #1234`, invalidate (Task 7). On a 409 head-moved: show the reason and refetch the dialog data. On 502: show the error, keep the dialog open, and refetch, so already-pending comments now show as pending.

- [ ] **Step 1: Failing tests:**
  - The layout order.
  - The checkbox default, and its effect on the list and the warning.
  - Own-PR disabling.
  - An empty Comment is disabled.
  - Success: the toast text and the submit payload `{event:"APPROVE", include_local:true, head}`.
  - 409: the reason shows and the data is refetched.
  - No element in the modal has an inner scroll container (no `overflow: auto`/`scroll` style).
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement. **Step 4:** UI tests pass.
- [ ] **Step 5: Commit:** `feat(ui): submit a PR review from the diff view`.

### Task 10: Sidebar, toolbar, Code tab and PR link wiring

**Files:**
- Modify: `ui/src/components/gitdiff/ReviewSidebar.tsx`, `PRCommentsTab.tsx`, `DiffView.tsx`, `ui/src/components/gitdiff/ReviewActions.tsx`, and their tests.

- **Local tab:** `Submit review to PR #1234…` beside `Copy comments for agent`, with the tooltip. Hidden without a PR, and disabled (tooltip) when off. It opens `SubmitReviewModal`.
- **PR tab:**
  - The label is `PR comments (N) · pending review` while `pending_comments > 0`.
  - At the top, the notice `You have a pending review on PR #1234 (N comments)` with the same submit button.
  - The `PR #1234` link navigates to the worktree page's resource view: leave the diff (`useDiffView().leave`) and set `resource=pr:<id>` in the same navigation (`leave({ resource: "pr:" + id })`).
- **Toolbar and Code tab:** pass `pending_comments` to the labels (Task 7). The button shows when there are local comments, open threads, or pending comments.

- [ ] **Step 1: Failing tests.**
  - The local tab's submit button shows with a PR and is absent without one.
  - The PR tab label and notice show with `pending_comments: 2`.
  - Clicking `PR #12` navigates to `?resource=pr%3Ao%2Fr%2312` (or equivalent) with no `diff`.
  - The toolbar label includes `pending PR review (2 comments)` and is filled.
  - `ReviewActions` includes `pending PR review` and is filled.
- [ ] **Step 2:** Run the tests and confirm they fail. **Step 3:** Implement. **Step 4:** UI tests and the build pass.
- [ ] **Step 5: Commit:** `feat(ui): show and submit a pending PR review from the sidebar; PR link opens its resource view`.

### Task 11: Docs and full verification

**Files:** Modify `docs/web-ui-architecture.md` ("PR comments", "Review comments"), `.claude/CLAUDE.md` (the webui routes sentence: `/api/pr-write/*`), and `docs/superpowers/specs/2026-10-23-review-comments-roadmap.md` (phases 2b and 3 done).

- [ ] **Step 1:** Write the docs. Cover:
  - PR matching by number;
  - the target commit (pending review's commit or head);
  - the postability reasons and hunks;
  - the routes and their states;
  - reconciliation;
  - the pending-review indicators;
  - the button labels and tooltips.
- [ ] **Step 2:** Run the Global Constraints commands. All must pass.
- [ ] **Step 3: Commit:** `docs: writing to the PR from the diff view`.
- [ ] **Step 4:** `NONINTERACTIVE=1 make install`, then notify and alert Mike that it's ready for a live check against a test PR.
