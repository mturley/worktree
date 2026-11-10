# PR-derived merge base and checked-out PR indicator: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a worktree's branch tracks one of its followed PRs, compare against that PR's base (`<base remote>/<base branch>`) and show the PR in the UI as checked out here. Otherwise, keep today's `main@{upstream}`.

**Architecture:**
- The watcher library's poller caches each PR's head repo, head branch and base branch in `watcher_resource_state`.
- A pure matcher in `internal/prcomments` picks the worktree's PR from those cached fields and the current branch's upstream.
- One `Server` method, `worktreePR`, wraps the matcher, and every consumer goes through it: base-ref choice, `/api/worktree-git`, PR comments and writes, and "go to comment".
- The UI reads a new `pr` field from `/api/worktree-git` to show a marker on the PR card and a PR row in the Git summary.

**Tech Stack:** Go (cobra, SQLite via the watcher library), React + Mantine + TanStack Query (Vitest), Tabler icons.

**Spec:** `docs/superpowers/specs/2026-11-10-pr-base-merge-base-design.md`

## Global Constraints

- Never contact GitHub to choose the worktree's PR or its base. Use cached `watcher_resource_state` plus local git only.
- Missing or unparseable cached fields mean the PR simply doesn't match. That is not an error.
- Base fallback is silent: no remote for the PR's base repo, or `<remote>/<base>` not resolving to a commit, gives `gitutil.MainUpstream` as today, with no warning.
- An unrelated followed PR must never match, even when it is the only one.
- Watcher library work is cross-repo (repo CLAUDE.md, "Watcher library"): change `~/git/watcher` with tests, tag the next minor (`v0.25.0`), then re-pin here. **Ask Mike before pushing** the watcher `main` and tag (pushes are never covered by plan approval).
- `internal/webui` tests call `t.Parallel()` first unless they use `t.Setenv`/globals. Git fixtures come from `testgit.Worktree`/`testgit.Template`, never built from scratch. Run `go test -race ./internal/webui/` after.
- Marker icon: Tabler `IconDeviceLaptop`. Tooltip text: exactly `Checked out in this worktree`.
- PR row label: exactly `PR`, in `GitSummary`'s left column directly under `Branch`.
- On removals, nothing asserts or documents that the old thing is gone (no tests or docs for removed code).
- Every commit uses `--signoff`.

## Review Focus

1. **Remote URL spellings.** `git@github.com:Owner/Repo.git`, `https://github.com/owner/repo` and `ssh://git@github.com/owner/repo.git` must all match `owner/repo`, case-insensitively. (Matcher test in Task 3; slug test in Task 2.)
2. **Cached state written by watcher ≤ v0.24.0, or garbage `state_json`.** No match, no panic, and the merge base falls back. (Task 4 test.)
3. **Base branch containing slashes** (`feature/x`). The ref `upstream/feature/x` must resolve and be used. (Task 5 test.)
4. **A branch tracking a local branch** (`branch.<b>.remote = .`), or a merge ref that is neither `refs/heads/*` nor `refs/pull/<N>/head`. No match, no crash. (Task 3 test.)
5. **The PR hidden by "Unreads only" or a source filter when its row is clicked.** The page's stale-selection effect clears a selection the list doesn't show, so the click would appear to do nothing. Expected behavior: the PR is shown and selected. (Task 8 test. Fix: the click also turns off the filters that hide it, using the page's existing clear-filters action. See Task 8.)

---

### Task 1: Watcher library caches head/base fields (in `~/git/watcher`)

**Files:**
- Modify: `~/git/watcher/github/graphql.go` (`buildBatchedPRQuery`, `prNode`, `PRData`, `parsePRNode`)
- Modify: `~/git/watcher/github/poller.go` (`buildPRStateJSON`)
- Test: `~/git/watcher/github/graphql_test.go`, `~/git/watcher/github/poller_test.go`

**Interfaces:**
- Produces new `PRData` fields: `HeadRefName`, `BaseRefName`, `HeadRepoOwner`, `HeadRepoName string`. The head repo fields are empty when GitHub returns `headRepository: null`, which happens for a deleted fork.
- Produces new state JSON keys: `head_ref_name`, `base_ref_name`, `head_repo_owner`, `head_repo_name` (strings, always present, possibly "").

- [ ] **Step 1: Write failing tests.**
  - `TestParsePRNodeHeadBase`: a node with `headRefName:"feat"`, `baseRefName:"main"` and `headRepository:{name:"odh-dashboard", owner:{login:"sridarna"}}` yields those four values. With `headRepository: null`, it yields empty owner and name.
  - `TestBuildPRStateJSONHeadBase`: the JSON from `buildPRStateJSON(PRData{HeadRefName:"feat", BaseRefName:"main", HeadRepoOwner:"o", HeadRepoName:"r"}, "", "")` has those four keys and values.
  - `TestBuildBatchedPRQueryHeadBase`: the query string contains `headRefName`, `baseRefName` and `headRepository { name owner { login } }`.
- [ ] **Step 2: Run** `cd ~/git/watcher && go test ./github/ -run 'HeadBase'`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the three selections to the batched query. Add the matching `prNode` fields; use a pointer for `headRepository` so `null` decodes. Copy them in `parsePRNode` and emit them in `buildPRStateJSON`.
- [ ] **Step 4: Run** `go test ./...` in `~/git/watcher`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit --signoff -m "feat(github): cache PR head repo/branch and base branch in state"`, then `git tag v0.25.0`. **Ask Mike**, then `git push origin main && git push origin v0.25.0`.
- [ ] **Step 6: Re-pin in the worktree repo.** `go get github.com/mturley/watcher@v0.25.0 && go mod tidy && go build ./... && go test ./internal/webui/ -run Settings`. Expected: PASS (no config keys changed). Commit `go.mod`/`go.sum`: `chore: pin watcher v0.25.0`.

### Task 2: gitutil — branch upstream and remote slug helpers

**Files:**
- Modify: `internal/gitutil/refs.go`, `internal/gitutil/repo.go`
- Test: `internal/gitutil/refs_test.go`, `internal/gitutil/repo_test.go` (create if missing)

**Interfaces:**
- Produces `func BranchUpstream(dir string) (remote, merge string, ok bool)`: the current branch's `branch.<b>.remote` and `branch.<b>.merge` config values. `ok` is false for a detached HEAD or when either value is unset.
- Produces `func RemoteSlug(repoRoot, remote string) string`: the lowercased `owner/repo` of the remote's URL, without `.git`; "" when unknown. Reuses `slugFromURL`.

- [ ] **Step 1: Write failing tests.**
  - `TestBranchUpstream`, using a `testgit` fixture: a branch configured with remote `sridarna` and merge `refs/heads/feat` returns those two values with ok=true. A detached HEAD returns ok=false. A branch with no config returns ok=false.
  - `TestRemoteSlug`: table over `git@github.com:Owner/Repo.git`, `https://github.com/owner/repo`, `ssh://git@github.com/owner/repo.git`. All give `owner/repo`. An unknown remote gives "".
- [ ] **Step 2: Run** `go test ./internal/gitutil/ -run 'BranchUpstream|RemoteSlug'`. Expected: FAIL.
- [ ] **Step 3: Implement both.** `BranchUpstream` uses `CurrentBranch`, then reads both keys with a single `git config --get-regexp` (one process).
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(gitutil): BranchUpstream and RemoteSlug helpers`

### Task 3: prcomments — match the PR the branch tracks

**Files:**
- Modify: `internal/prcomments/prcomments.go` (replace `Candidate` and `PickPR`)
- Test: `internal/prcomments/prcomments_test.go`

**Interfaces:**
- Produces:
  ```go
  type Candidate struct {
      ID        string // resource ID, "owner/repo#N"
      Primary   bool
      UpdatedAt string
      Number    int
      BaseSlug  string // lowercased owner/repo from the resource ID
      HeadSlug  string // lowercased head_repo_owner/head_repo_name; "" for a deleted fork
      HeadRef   string // head_ref_name
      BaseRef   string // base_ref_name
  }
  // Upstream is what the current branch tracks: the remote's slug (RemoteSlug) and the merge ref.
  type Upstream struct{ Slug, Merge string }
  func PickPR(cands []Candidate, up Upstream) (Candidate, bool)
  ```
- Rule: `Merge` is `refs/heads/<h>` → the candidate matches when `HeadSlug == up.Slug` (both non-empty) and `HeadRef == h`. `Merge` is `refs/pull/<N>/head` → the candidate matches when `BaseSlug == up.Slug` and `Number == N`. Any other `Merge`, or an empty `Slug`, matches nothing. Ties are broken by the existing `better` (primary, then newest `UpdatedAt`). Slug comparisons are case-insensitive.

- [ ] **Step 1: Replace the old `PickPR` tests with failing ones:**
  - `TestPickPROwnPR`: up `{"mturley/odh-dashboard", "refs/heads/feat"}` matches the candidate with HeadSlug `mturley/odh-dashboard` and HeadRef `feat`.
  - `TestPickPRForkRenamedBranch`: HeadRef `main`, up `{"sridarna/odh-dashboard", "refs/heads/main"}` matches. The local branch name plays no part.
  - `TestPickPRDeletedFork`: HeadSlug "", BaseSlug `opendatahub-io/odh-dashboard`, Number 10598, up `{"opendatahub-io/odh-dashboard", "refs/pull/10598/head"}` matches.
  - `TestPickPRIgnoresUnrelated`: one matching candidate and one non-matching *primary* candidate. The matching one wins. With only the non-matching one, there is no match.
  - `TestPickPRNoMatchShapes`: Merge `refs/heads/feat` with Slug "" (local `.` remote), Merge `refs/tags/x`, and a candidate with empty HeadRef all give no match.
  - `TestPickPRCaseInsensitive`: HeadSlug `SriDarna/ODH-Dashboard` matches Slug `sridarna/odh-dashboard`.
  - `TestPickPRTieBreak`: two matches. The primary beats the related one; with equal primary, the newer UpdatedAt wins.
- [ ] **Step 2: Run** `go test ./internal/prcomments/`. Expected: FAIL to compile, because `Upstream` and the new fields don't exist yet. (The package tests only depend on this package, so they run green before `internal/webui` is updated.)
- [ ] **Step 3: Implement** the new `Candidate`/`Upstream`/`PickPR` and delete `RepoIsRemote` and the tracked-number branch. Update the package doc comment to describe the new rule.
- [ ] **Step 4: Run** `go test ./internal/prcomments/`. Expected: PASS.
- [ ] **Step 5: Commit together with Task 4** (`internal/webui` won't build in between).

### Task 4: webui — `worktreePR` and moving every consumer to it; retire `worktree-pr`

**Files:**
- Create: `internal/webui/worktree_pr.go`
- Modify: `internal/webui/pr_comments_api.go` (`offlinePR`, `loadPRComments`, `prWorktreesForPR`)
- Modify: `internal/gitutil/worktree.go` (`SetPRTracking` stops writing `prNumberKey`; delete `prNumberKey`)
- Modify: `internal/gitutil/refs.go` (delete `TrackedPRNumber`)
- Modify: `internal/gitutil/prtracking_test.go`, `internal/gitutil/refs_test.go` (drop the cases for deleted code; no "it's gone" assertions)
- Test: `internal/webui/worktree_pr_test.go`, plus the existing `pr_comments_api` tests updated

**Interfaces:**
- Consumes: Task 2's `BranchUpstream` and `RemoteSlug`; Task 3's `PickPR`, `Candidate` and `Upstream`; Task 1's state keys.
- Produces `func (s *Server) worktreePR(dir string) (prcomments.Candidate, bool)`. It works as follows:
  - Loads `resources.Load(s.DB, dir)` and `OfType(..., "pr")`, then `wgithub.ParsePRResourceID` (BaseSlug from that).
  - Reads `watcherdb.GetResourceState(s.DB, "pr", id)` and decodes its state JSON into a struct with the four keys. A decode error or missing fields leaves them empty.
  - Builds `Upstream{Slug: gitutil.RemoteSlug(dir, remote), Merge: merge}` from `BranchUpstream`, then calls `PickPR`.
  - Never contacts GitHub, and doesn't check the watcher toggle (DB only).

- [ ] **Step 1: Write failing tests** in `worktree_pr_test.go` (parallel; `testgit.Worktree`; state rows written with the watcher DB API the existing tests use):
  - `TestWorktreePRMatchesTrackedHead`: two followed PRs; the branch tracks the one whose cached head matches. That one is returned.
  - `TestWorktreePROldState`: the state JSON has no head fields → `ok == false`.
  - `TestWorktreePRGarbageState`: state_json `"not json"` → `ok == false`, no panic.
  - `TestWorktreePRNoUpstream`: the branch has no upstream → `ok == false`.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run WorktreePR`. Expected: FAIL.
- [ ] **Step 3: Implement `worktreePR`. Then switch the callers:**
  - `offlinePR` uses `worktreePR` for the choice. Title and URL still come from the summary cache when it's present, else the resource row's URL.
  - `loadPRComments` chooses with `worktreePR` *before* fetching anything, then fetches the summary (and threads) only for the chosen PR, keeping the existing cache keys. No match → `prStateNoPR`.
  - `prWorktreesForPR(id, head)` returns the active worktrees whose `worktreePR(path).ID == id`. The `head` parameter goes if nothing else needs it.
  - Delete `TrackedPRNumber` and `prNumberKey`, and stop writing it in `SetPRTracking`. Update the comments that mention it (`gitutil/worktree.go`, `pr_comments_api.go` doc comments).
- [ ] **Step 4: Run** `go build ./... && go test ./internal/prcomments/ ./internal/gitutil/ ./internal/worktreenew/ && go test -race ./internal/webui/`. Expected: PASS. Fix the existing PR comments and locate tests that seeded `worktree-pr` or relied on branch-name matching. They now seed cached head fields and a tracked upstream instead.
- [ ] **Step 5: Commit** Tasks 3 and 4 together: `feat: pick the worktree's PR from what its branch tracks`

### Task 5: Merge base from the PR, and `pr` in `/api/worktree-git`

**Files:**
- Create: `internal/webui/base_ref.go`
- Modify: `internal/webui/worktree_git_api.go` (DTO and handler), `internal/webui/worktree_diff_api.go` (`baseRefFor` becomes a `Server` method), `internal/webui/review_comments_api.go:241`, `internal/webui/review_comments_resolve.go:111` (callers)
- Modify: `docs/web-ui-architecture.md` ("Code tab and diff view", "PR comments"), `.claude/CLAUDE.md` (the `gitutil` and `prcomments` bullets: drop the "tracked PR number" wording and describe the new rule)
- Test: `internal/webui/base_ref_test.go`, `internal/webui/worktree_git_api_test.go`, `internal/webui/worktree_diff_api_test.go`

**Interfaces:**
- Consumes: Task 4's `worktreePR`.
- Produces `func (s *Server) mergeBaseRef(dir string) (ref string, pr *prcomments.Candidate, ok bool)`. It works as follows:
  - If there is a PR, its `BaseRef != ""`, `gitutil.FindRemoteForRepo(dir, baseOwner, baseRepo)` succeeds and `gitutil.RevSHA(dir, remote+"/"+BaseRef)` resolves, it returns `remote/BaseRef` and the PR.
  - Otherwise it returns `gitutil.MainUpstream(dir)`. The PR (if any) is still returned, so the UI shows the PR row even on fallback.
- `baseRefFor` becomes `func (s *Server) baseRefFor(dir, base string) (ref string, status int, msg string)`, with `merge-base` → `mergeBaseRef`.
- `worktreeGitDTO` gains `PR *string \`json:"pr,omitempty"\``: the matched PR's resource ID. `MainUpstream` carries `mergeBaseRef`'s ref. Background fetch needs no change: `gitfetch.RemotesFor` already maps `upstream/...` to its remote, and a remote's default refspec covers every branch.

- [ ] **Step 1: Write failing tests** (parallel; `testgit.Template` fixture with an `origin` and an `upstream` remote whose URLs end `mturley/repo` and `org/repo`, and branches `upstream/main` and `upstream/feature/x`):
  - `TestMergeBaseRefFromPR`: a PR with base `org/repo`, BaseRef `main`, and the branch tracking its head → `upstream/main`, with the PR returned.
  - `TestMergeBaseRefSlashBranch`: BaseRef `feature/x` → `upstream/feature/x`.
  - `TestMergeBaseRefNoBaseRemote`: base `someone/else` → `MainUpstream`'s value, with the PR still returned.
  - `TestMergeBaseRefUnfetchedBase`: BaseRef `gone` → fallback.
  - `TestMergeBaseRefNoPR`: an unrelated followed PR only → fallback, with pr nil.
  - `TestWorktreeGitReportsPR`: GET `/api/worktree-git` gives `pr == "org/repo#7"` and `main_upstream == "upstream/main"`.
  - `TestWorktreeDiffMergeBaseUsesPRBase`: `/api/worktree-diff/commits?base=merge-base` lists only the commits after `upstream/main`, even when `main@{upstream}` is an older `origin/main`.
- [ ] **Step 2: Run** `go test ./internal/webui/ -run 'MergeBaseRef|WorktreeGitReportsPR|MergeBaseUsesPRBase'`. Expected: FAIL.
- [ ] **Step 3: Implement** `mergeBaseRef`, the method form of `baseRefFor` and its three callers, and the DTO field. Update the two docs.
- [ ] **Step 4: Run** `go test ./... && go test -race ./internal/webui/`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: compare against the worktree PR's base branch`

### Task 6: UI — `pr` type and the checked-out marker on the PR card

**Files:**
- Modify: `ui/src/api/types.ts` (`WorktreeGit.pr?: string`, documented as the matched PR's resource ID)
- Modify: `ui/src/components/ResourceTypeLine.tsx` (export a `CheckedOutMarker`)
- Modify: `ui/src/components/ResourceCard.tsx` (`checkedOut?: boolean` prop → `PRCardBody` → `ResourceTypeLine`'s `trailing`)
- Modify: `ui/src/components/ResourceList.tsx`, `ui/src/components/ResourceDetailPane.tsx` (accept `checkedOutPR?: string` and pass `checkedOut={r.type === "pr" && r.id === checkedOutPR}`)
- Modify: `ui/src/pages/WorktreeDetailPage.tsx`. Call `useWorktreeGit(path, { fetch: detailTab.tab === "code" })`, the same key the card uses, so TanStack dedupes it and nothing extra is polled. Pass `.data?.pr` to both components.
- Test: `ui/src/components/ResourceCard.test.tsx`, `ui/src/components/ResourceList.test.tsx`

**Interfaces:**
- Produces `export function CheckedOutMarker(): JSX.Element`. It renders `IconDeviceLaptop` at size 14 with `aria-label="Checked out in this worktree"`, wrapped in a Mantine `Tooltip` labelled `Checked out in this worktree`. The color is the builder's choice (teal suggested).

- [ ] **Step 1: Write failing tests:**
  - `ResourceCard`: a PR card with `checkedOut` renders `getByLabelText("Checked out in this worktree")`. Without it, there is no such element. A Jira card with `checkedOut` renders none.
  - `ResourceList`: given two PRs and `checkedOutPR="o/r#2"`, exactly one marker appears, inside `o/r#2`'s card. Hovering it shows the tooltip text.
- [ ] **Step 2: Run** `cd ui && npx vitest run src/components/ResourceCard.test.tsx src/components/ResourceList.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** as listed above.
- [ ] **Step 4: Run** the same command, then `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(ui): mark the PR checked out in this worktree`

### Task 7: UI — PR row in the Git summary (Code tab and diff view sidebar)

**Files:**
- Create: `ui/src/components/gitdiff/PRRow.tsx`
- Create: `ui/src/hooks/useWorktreeResource.ts`
- Modify: `ui/src/components/gitdiff/GitSummary.tsx` (new optional `onOpenPR?: (key: ResourceKey) => void` prop; renders the row under Branch when `git.pr` is set)
- Test: `ui/src/components/gitdiff/GitSummary.test.tsx`

**Interfaces:**
- Produces `useWorktreeResource(path: string, type: string, id?: string): ResourceDTO | undefined`. It reads the existing `["resources", path]` query (`api.worktreeResources`), so it shares the cache.
- Produces `PRRow({ path, prId, onOpen }: { path: string; prId: string; onOpen?: () => void })`. It renders an `InfoRow` labelled `PR`. Inside: `ResourceStatusIcon` (when the resource is loaded), a link-styled button whose text is `#N` (from `shortResourceRef("pr", prId)`) and which calls `onOpen`, then the title truncated to one line (`lineClamp={1}` / ellipsis). The `#N` button is wrapped in `ResourceHoverCard({ type: "pr", id: prId })` from `ui/src/components/tasks/LinkHoverCards.tsx`.
- `GitSummary` needs `path`. Add a `path: string` prop and pass it from `GitDiffPanel` and `DiffView`.

- [ ] **Step 1: Write failing tests** in `GitSummary.test.tsx`:
  - With `git.pr = "o/r#7"` and the resource title `Add linting`: a row labelled `PR` appears directly after the `Branch` row and before `Working tree`. It contains `#7` and `Add linting`.
  - Without `git.pr`, there is no `PR` row.
  - With the resource not loaded, the row shows `#7` alone.
  - Clicking `#7` calls `onOpenPR` with `{ type: "pr", id: "o/r#7" }`.
  - With `oneColumn`, the row still renders, which covers the diff view sidebar.
- [ ] **Step 2: Run** `cd ui && npx vitest run src/components/gitdiff/GitSummary.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** as listed above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(ui): PR row in the Code tab and diff view summary`

### Task 8: UI — clicking the PR row selects the PR

**Files:**
- Modify: `ui/src/components/gitdiff/GitDiffPanel.tsx`. Lift `FilesChanged`'s `open` state (with `readFilesOpen`/`writeFilesOpen`) into `GitDiffPanel`, and pass `onOpenPR` to `GitSummary`.
- Modify: `ui/src/components/gitdiff/DiffView.tsx` (pass `onOpenPR` to its `GitSummary`)
- Modify: `ui/src/pages/WorktreeDetailPage.tsx` (Review Focus 5)
- Test: `ui/src/components/gitdiff/GitDiffPanel.test.tsx`, `ui/src/components/gitdiff/DiffView.test.tsx`, `ui/src/pages/WorktreeDetailPage.test.tsx`

**Interfaces:**
- Consumes: Task 7's `onOpenPR`; `useSelectedResource().select`; `useDiffView().leave(set, drop)`; `serializeResourceKey`.
- Code tab: `onOpenPR = (key) => { select(key); setOpen(false); writeFilesOpen(false) }`.
- Diff view: `onOpenPR = (key) => leave({ resource: serializeResourceKey(key) }, ["tab"])`. This is one navigation that closes the view and selects the PR.
- Review Focus 5: when the requested `?resource=` is a resource that exists in `items` but is hidden by "Unreads only" or source filters, the page clears those filters instead of clearing the selection. Change the stale-selection effect to check `items` (all resources) before `shownItems`, and call the existing `clearAll`-style filter reset (`setSources([])`, unread-only off) when the selection exists but is filtered out.

- [ ] **Step 1: Write failing tests:**
  - `GitDiffPanel`: with Files changed expanded, clicking the PR row's `#7` navigates to `?resource=pr:o%2Fr%237` (whatever `serializeResourceKey` gives) and collapses the list. `localStorage["worktree.filesChangedOpen"]` becomes `"false"`.
  - `DiffView`: at `?diff&file=a.go`, clicking `#7` leaves `diff`/`file` out of the URL and sets `resource`.
  - `WorktreeDetailPage`: with "Unreads only" on and the PR read, navigating to `?resource=<pr>` keeps the selection, shows the PR's detail pane, and turns "Unreads only" off.
- [ ] **Step 2: Run** `cd ui && npx vitest run src/components/gitdiff src/pages/WorktreeDetailPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** as listed above.
- [ ] **Step 4: Run** `cd ui && npm test && npm run build`, then `make build` from the repo root. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(ui): PR row selects the PR from the Code tab and diff view`

### Task 9: End-to-end check against the real worktrees

- [ ] **Step 1:** `NONINTERACTIVE=1 make install` (`worktree ui` restarts itself in about 5s).
- [ ] **Step 2:** Temporarily point odh-dashboard's `main` back at `origin` (`git -C ~/git/rhoai-work/opendatahub-io/odh-dashboard branch --set-upstream-to=origin/main main`), after **asking Mike**. Restore it to `upstream/main` afterwards.
- [ ] **Step 3:** Check the `pr-10598-…` worktree after one poll cycle. `curl` `/api/worktree-git` (with the UI session) should show `pr = opendatahub-io/odh-dashboard#10598` and `main_upstream = upstream/main`. Then check `e2e-unsupported-fix` (no PR): `main_upstream = origin/main` and no `pr`.
- [ ] **Step 4:** In the browser, check the marker and tooltip on PR #10598's card, the PR row and its hover card, and both click paths.
- [ ] **Step 5:** Restore `main`'s upstream and report the results.
