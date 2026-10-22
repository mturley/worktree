# Code Tab and Diff View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the detail card's Git / Environment tab into Environment and Code tabs, add merge-base/tracking status, a commit-range "Files changed" list, a drill-down diff view on `@pierre/diffs`, per-file open-in-editor, live status polling and a background `git fetch`.

**Architecture:** Pure git functions in `internal/gitutil` (tested on real temp repos); a per-repo fetch scheduler in a new `internal/gitfetch`; new read-only endpoints in `internal/webui`; React hooks + components in `ui/`, with the diff view a lazily loaded drill-down inside `WorktreeDetailPage` driven by `?diff[&file=]`.

**Tech Stack:** Go (stdlib `os/exec` git calls), React 19, Mantine 7.17 (`Tree`, `Popover`, `Select`), TanStack Query 5, wouter, `@pierre/diffs` 1.6.x.

**Spec:** `docs/superpowers/specs/2026-10-21-git-diff-view-design.md` — read it first; this plan argues from it and does not repeat its UX copy.

## Global Constraints

- Tabs order: `Notes | Environment | Code | cmux`; UI never says "upstream" for the branch's own upstream — it is "Tracking branch".
- Main upstream = `git rev-parse --abbrev-ref main@{upstream}`, fallback `git symbolic-ref --short refs/remotes/origin/HEAD`.
- Commit list = `git rev-list --first-parent <base-ref>..HEAD`, newest first.
- A run including the list's oldest commit uses `merge-base(HEAD, base-ref)` as its old side; full runs are labelled "All commits"/"All changes", never "N of N commits".
- Working-tree comparisons diff against a snapshot tree (temp `GIT_INDEX_FILE` copy + `git add -A` + `git write-tree`); the real index is never written.
- File contents are only ever served via `git show <rev>:<file>` for a `rev` the server handed out.
- Fingerprint uses `git status --porcelain=v1 -uall` plus size+mtime of each listed file.
- Poll every 5s while `document.visibilityState === "visible"`; send `fetch=1` only while the Code tab or diff view shows.
- Fetch: `git fetch --prune <remote>` per distinct remote, never `--all`; `GIT_TERMINAL_PROMPT=0`; SSH `BatchMode=yes`; ~60s timeout; skip when git lock files exist; default interval `3m`, minimum `1m`; config keys `git.background_fetch` (default true) and `git.fetch_interval`.
- Diff view never reloads on a background change — only Refresh, or an explicit selection/whitespace change.
- "Hide whitespace" defaults off. Editor icon tooltip: `Open in <editor> (configure editor in settings)`; no editor → `Configure an editor in settings`, disabled.
- `@pierre/diffs`: worker via `@pierre/diffs/worker/worker-portable.js?worker`; `highlighterOptions={{}}`; no `theme` override, `themeType: "dark"`.
- Every new endpoint refuses unregistered worktree paths (`registry.Get` → 404, as `editor_api.go` does).
- Commits: `git commit --signoff`, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git add -A`/`.`.

## Review Focus

1. **Repo with no commits yet** (fresh `git init`): HEAD unresolvable — status endpoint returns a branch and working counts, null merge base/tracking, empty commit list; no 500s. (Tests in Tasks 1, 4, 8.)
2. **Detached HEAD** (e.g. mid-rebase, or checked out a SHA): no tracking branch, merge-base comparison still works, open-editor and diffs unaffected. (Tests in Tasks 1, 8.)
3. **Paths with spaces, unicode, or quotes**, and renames: numstat/name-status parsed with `-z` so paths round-trip exactly; the editor `file` validation accepts them. (Tests in Tasks 5, 10.)
4. **Binary files** in the range: list shows "binary" not `+0 −0`, patch shows a placeholder, never a crash in pierre. (Tests in Tasks 5, 14.)
5. **Worktree removed from disk while its page is open**: polls return a "missing" shape (HTTP 200, `on_disk: false`) instead of erroring every 5s; UI hides the summary. (Tests in Tasks 8, 12.)

---

## File Structure

Backend:
- `internal/gitutil/refs.go` — main upstream, tracking branch, merge base, ahead/behind.
- `internal/gitutil/snapshot.go` — working-tree snapshot tree.
- `internal/gitutil/fingerprint.go` — status fingerprint (full + working-tree part).
- `internal/gitutil/commits.go` — first-parent list, `ListID`, range → old/new revs.
- `internal/gitutil/diff.go` — numstat, patch, show-file.
- `internal/gitutil/run.go` — shared `git` runner (`git -C dir …`, env scrubbing for tests is the caller's job).
- `internal/gitfetch/gitfetch.go` — per-repo background fetch scheduler.
- `internal/config/config.go`, `editable.go` — `git.*` keys.
- `internal/webui/settings.go`, `settings_keys.go` — settings plumbing.
- `internal/webui/worktree_git_api.go` — status endpoint.
- `internal/webui/worktree_diff_api.go` — commits/files/patch/file endpoints + handed-out rev set.
- `internal/webui/editor_api.go` — optional `file`.

Frontend:
- `ui/src/api/types.ts`, `ui/src/api/client.ts` — DTOs + calls.
- `ui/src/hooks/useWorktreeGit.ts`, `useDiffSelection.ts`, `useDiffData.ts`, `useDiffView.ts`.
- `ui/src/lib/diffLabels.ts` — badge + range label formatting (pure).
- `ui/src/hooks/useDetailTab.ts` — tab ids.
- `ui/src/components/WorktreeDetailCard.tsx` — tabs.
- `ui/src/components/gitdiff/GitDiffPanel.tsx`, `GitSummary.tsx`, `CompareSelect.tsx`, `RangePicker.tsx`, `FilesChangedList.tsx`, `OpenFileInEditorIcon.tsx`.
- `ui/src/components/gitdiff/DiffView.tsx` (lazy default export), `DiffFileTree.tsx`, `DiffBody.tsx`.
- `ui/src/pages/WorktreeDetailPage.tsx` — drill-down switch.
- `ui/src/components/settings/GeneralPanel.tsx`, `tabDirty.ts`.

---

### Task 1: Refs — main upstream, tracking branch, merge base, ahead/behind

**Files:**
- Create: `internal/gitutil/run.go`, `internal/gitutil/refs.go`, `internal/gitutil/refs_test.go`

**Interfaces:**
- Produces:
  - `func git(dir string, args ...string) (string, error)` — runs `git -C dir args…`, returns trimmed stdout; error includes stderr.
  - `func MainUpstream(dir string) (string, bool)` — e.g. `"upstream/main"`.
  - `func TrackingBranch(dir string) (string, bool)` — `HEAD@{upstream}`.
  - `func MergeBase(dir, ref string) (string, bool)` — full SHA.
  - `func AheadBehind(dir, ref string) (ahead, behind int, ok bool)` — via `rev-list --left-right --count ref...HEAD`.
  - `func RevSHA(dir, ref string) (string, bool)`.

Test fixture: a helper in `refs_test.go`, `func newRepo(t *testing.T) (repo string, run func(args ...string) string)` that `git init -b main`s a temp dir with the same scrubbed env as `internal/testgit`, plus a bare `origin` remote cloned so `main@{upstream}` resolves. Later gitutil tests reuse it.

- [ ] **Step 1: Write failing tests**
  - `TestMainUpstreamResolvesConfiguredUpstream` — `main` tracks `origin/main` → `("origin/main", true)`.
  - `TestMainUpstreamFallsBackToOriginHEAD` — unset `main`'s upstream, `git remote set-head origin main` → `("origin/main", true)`.
  - `TestMainUpstreamUnresolvable` — repo with no remote → `("", false)`.
  - `TestDefaultBranchNotMain` — default `master`, `origin/HEAD` → `origin/master`; `MainUpstream` returns `"origin/master"` (builder's call from spec: use `origin/HEAD`'s branch when `main` doesn't exist).
  - `TestTrackingBranchAbsentForUnpushedBranch` and `TestTrackingBranchDetachedHEAD` → `false`.
  - `TestAheadBehind` — branch with 2 commits; `origin/main` advanced by 3 → `(2, 3, true)`.
  - `TestRefsOnRepoWithNoCommits` — `git init` only: every func returns `ok=false`, no panic.

- [ ] **Step 2: Run** `go test ./internal/gitutil/ -run 'MainUpstream|Tracking|AheadBehind|NoCommits|DefaultBranchNotMain'` — Expected: FAIL (undefined).

- [ ] **Step 3: Implement** the functions above. `MainUpstream`: if `refs/heads/main` exists try `main@{upstream}`; else derive the branch from `origin/HEAD` and try `<branch>@{upstream}`; else return `origin/HEAD`'s short name.

- [ ] **Step 4: Run** the same command — Expected: PASS.

- [ ] **Step 5: Commit** `feat(gitutil): resolve main upstream, tracking branch, merge base, ahead/behind`.

---

### Task 2: Working-tree snapshot

**Files:**
- Create: `internal/gitutil/snapshot.go`, `internal/gitutil/snapshot_test.go`

**Interfaces:**
- Consumes: `git` (Task 1).
- Produces: `func SnapshotWorkingTree(dir string) (tree string, err error)`.

- [ ] **Step 1: Write failing tests**
  - `TestSnapshotIncludesModifiedAndUntracked` — modify a tracked file, add `new/deep/file.txt`; `git show <tree>:new/deep/file.txt` equals the content.
  - `TestSnapshotExcludesIgnored` — `.gitignore` has `.env.local`; it is absent from `git ls-tree -r <tree>`.
  - `TestSnapshotLeavesRealIndexUntouched` — `sha256` of the file at `git rev-parse --git-path index` is identical before/after; `git status --porcelain` unchanged.
  - `TestSnapshotInLinkedWorktree` — uses `testgit.Worktree(t)`; the snapshot works (index path comes from `--git-path index`, not `.git/index`).

- [ ] **Step 2: Run** `go test ./internal/gitutil/ -run Snapshot` — FAIL.

- [ ] **Step 3: Implement** — copy `$(git rev-parse --git-path index)` (if present) to a temp file in `os.TempDir()`, run `git add -A` and `git write-tree` with `GIT_INDEX_FILE=<temp>`, delete the temp file in `defer`.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** `feat(gitutil): snapshot the working tree as a tree object`.

---

### Task 3: Fingerprint

**Files:**
- Create: `internal/gitutil/fingerprint.go`, `internal/gitutil/fingerprint_test.go`

**Interfaces:**
- Produces: `type Fingerprint struct { Full, Working string }` and `func ComputeFingerprint(dir string, refs ...string) (Fingerprint, error)`. `Working` hashes only the `status -uall` output + size/mtime of listed files; `Full` = hash(HEAD SHA, each ref's SHA, `Working`).

- [ ] **Step 1: Write failing tests**
  - `TestFingerprintStableWhenNothingChanges`.
  - `TestFingerprintChangesOnReEditOfModifiedFile` — modify, fingerprint, modify again (set mtime forward with `os.Chtimes`) → `Working` differs.
  - `TestFingerprintChangesOnNewFileInNewUntrackedDir` — `a/b.txt` then add `a/c.txt` → differs.
  - `TestFingerprintFullChangesWhenRefMoves` — `Working` equal, `Full` differs after `origin/main` advances.

- [ ] **Step 2–4:** run `go test ./internal/gitutil/ -run Fingerprint` (FAIL), implement with `sha256`, run (PASS).

- [ ] **Step 5: Commit** `feat(gitutil): status fingerprint for change detection`.

---

### Task 4: Commit list, list identity, range resolution

**Files:**
- Create: `internal/gitutil/commits.go`, `internal/gitutil/commits_test.go`

**Interfaces:**
- Consumes: Task 1 (`MergeBase`), Task 2 (`SnapshotWorkingTree`).
- Produces:
  - `type Commit struct { SHA, Short, Subject, Author string; Date time.Time }` (JSON tags `sha, short, subject, author, date`).
  - `func FirstParentCommits(dir, baseRef string) ([]Commit, error)` — newest first.
  - `func ListID(commits []Commit, mergeBase string) string` — sha256 of the SHAs + merge base, hex, first 16 chars.
  - `const Uncommitted = "uncommitted"`.
  - `type Range struct { From, To string }` — commit SHAs or `Uncommitted`; zero value = All changes.
  - `func ResolveRange(dir, baseRef string, commits []Commit, r Range) (oldRev, newRev string, err error)`; returns `ErrInvalidRange` when `From`/`To` aren't in `commits`/`Uncommitted`, or `From` is newer than `To`.

- [ ] **Step 1: Write failing tests**
  - `TestFirstParentCommitsNewestFirst` — 3 commits → subjects in reverse order.
  - `TestFirstParentCommitsSkipsMergedMainCommits` — merge `origin/main` (2 commits) into the branch; list contains branch commits + the merge commit only.
  - `TestResolveAllChanges` — zero `Range` → old = merge base, new = a tree SHA (snapshot).
  - `TestResolveAllCommits` — `{From: oldest, To: newest}` → old = merge base, new = HEAD.
  - `TestResolveFullRunAfterMergingMainUsesMergeBase` — after merging main in, `{From: oldest, To: newest}` old side equals `MergeBase(dir, baseRef)`, not `oldest^1`.
  - `TestResolveMiddleRun` — `{From: c2, To: c3}` → old = `c2^1`, new = `c3`.
  - `TestResolveUncommittedOnly` — `{From: Uncommitted, To: Uncommitted}` → old = HEAD SHA, new = tree.
  - `TestResolveRejectsUnknownSHA` and `TestResolveRejectsReversedRange` → `errors.Is(err, ErrInvalidRange)`.
  - `TestListIDChangesOnNewCommitNotOnMainAdvance` — new branch commit changes it; advancing `origin/main` alone does not.
  - `TestFirstParentCommitsNoCommits` — fresh repo → empty slice, nil error.

- [ ] **Step 2–4:** `go test ./internal/gitutil/ -run 'FirstParent|Resolve|ListID'` FAIL → implement → PASS. Use `git log --first-parent --format=%H%x00%h%x00%an%x00%aI%x00%s -z <base>..HEAD`. `Uncommitted` is newer than every commit.

- [ ] **Step 5: Commit** `feat(gitutil): first-parent commit list and range resolution`.

---

### Task 5: Diffs — numstat, patch, show-file

**Files:**
- Create: `internal/gitutil/diff.go`, `internal/gitutil/diff_test.go`

**Interfaces:**
- Produces:
  - `type FileChange struct { Path, OldPath, Status string; Additions, Deletions int; Binary bool }` (JSON `path, old_path,omitempty, status, additions, deletions, binary`); Status ∈ `A M D R`.
  - `func DiffFiles(dir, oldRev, newRev string) ([]FileChange, error)` — `git diff -z -M --numstat` merged with `--name-status`; sorted by `Path`.
  - `func DiffPatch(dir, oldRev, newRev string, ignoreWhitespace bool) (string, error)` — `git diff -M [-w] old new`; returns `ErrPatchTooLarge` above `MaxPatchBytes = 20 << 20`.
  - `func ShowFile(dir, rev, file string) ([]byte, error)`.

- [ ] **Step 1: Write failing tests**
  - `TestDiffFilesCountsAndStatuses` — add/modify/delete → `A`,`M`,`D` with exact counts.
  - `TestDiffFilesRename` — `git mv a.txt b.txt` + small edit → one entry `{Path:"b.txt", OldPath:"a.txt", Status:"R"}`.
  - `TestDiffFilesBinary` — PNG bytes → `Binary: true`, counts 0.
  - `TestDiffFilesOddPaths` — `dir with space/naïve "q".go` round-trips exactly.
  - `TestDiffPatchIgnoreWhitespace` — whitespace-only change → non-empty patch without `-w`, empty with.
  - `TestDiffPatchTooLarge` — set `MaxPatchBytes` small via a package var in the test → `ErrPatchTooLarge`.
  - `TestShowFileFromSnapshotTree` — content at a snapshot tree matches the disk at snapshot time, even after the file is edited again.

- [ ] **Step 2–4:** `go test ./internal/gitutil/ -run 'DiffFiles|DiffPatch|ShowFile'` FAIL → implement (`MaxPatchBytes` as a `var`) → PASS.

- [ ] **Step 5: Commit** `feat(gitutil): numstat, patch and file contents between revs`.

---

### Task 6: Background fetch scheduler

**Files:**
- Create: `internal/gitfetch/gitfetch.go`, `internal/gitfetch/gitfetch_test.go`

**Interfaces:**
- Produces:
  - `type State struct { LastOKAt *time.Time; LastError string; InProgress bool }` (JSON `last_ok_at, last_error, in_progress`).
  - `type Scheduler struct { Interval time.Duration; Now func() time.Time; Fetch func(ctx context.Context, dir, remote string) error; ... }`
  - `func New(interval time.Duration) *Scheduler` — real `Fetch` runs `git -C dir fetch --prune <remote>` with `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND` = existing value or `core.sshCommand` or `ssh`, with ` -o BatchMode=yes` appended, under a 60s timeout.
  - `func (s *Scheduler) Maybe(ctx context.Context, dir string, remotes []string)` — non-blocking.
  - `func (s *Scheduler) State(dir string) State`.
  - `func RemotesFor(dir string, refs ...string) []string` — distinct remote names of `remote/branch` refs (via `git config branch.<b>.remote` when resolvable, else the ref's prefix up to the first `/` if it names a remote).
  - Keyed by `gitutil.CommonDir(dir)`.

- [ ] **Step 1: Write failing tests** (fake `Now` and `Fetch`; `Fetch` records calls and can block on a channel)
  - `TestMaybeFetchesOnceWhenDue` — two `Maybe` calls → one fetch per remote.
  - `TestMaybeDedupsAcrossWorktreesOfSameRepo` — two linked worktrees (`testgit`) of one repo → one fetch.
  - `TestMaybeWaitsOutInterval` — advance clock by `Interval-1s` → no second fetch; by `Interval` → fetch.
  - `TestMaybeFailureWaitsOutInterval` — `Fetch` errors → `State.LastError` set; immediate `Maybe` doesn't refetch.
  - `TestMaybeSkipsWhileLockFilePresent` — create `index.lock` in the common dir → no fetch and no attempt recorded; remove → fetch on next `Maybe`.
  - `TestMaybeNeverConcurrentPerRepo` — blocking `Fetch`, `Maybe` again after interval → still one in flight; `State.InProgress` true.
  - `TestRemotesForForkSetup` — `upstream/main` + `origin/feat` → `["origin","upstream"]` sorted.

- [ ] **Step 2–4:** `go test ./internal/gitfetch/` FAIL → implement (mutex-guarded `map[string]*repoState`; lock check globs `index.lock`, `HEAD.lock`, `packed-refs.lock`, `shallow.lock` in the common dir and the worktree git dir, and walks `refs/` for `*.lock`) → PASS.

- [ ] **Step 5: Commit** `feat(gitfetch): per-repo background fetch scheduler`.

---

### Task 7: `git.*` config keys in config and the Settings modal

**Files:**
- Modify: `internal/config/config.go` (add `Git GitConfig \`yaml:"git,omitempty"\``), `internal/config/editable.go`, `internal/webui/settings.go`, `internal/webui/settings_keys.go`, `ui/src/api/types.ts`, `ui/src/components/settings/GeneralPanel.tsx`, `ui/src/components/settings/tabDirty.ts`
- Test: `internal/config/editable_test.go`, `internal/webui/settings_test.go`, `internal/webui/settings_keys_test.go` (should go green with no edit), `ui/src/components/settings/*.test.tsx` as existing patterns dictate.

**Interfaces:**
- Produces:
  - `type GitConfig struct { BackgroundFetch *bool \`yaml:"background_fetch,omitempty"\`; FetchInterval string \`yaml:"fetch_interval,omitempty"\` }`.
  - `func (g GitConfig) FetchEnabled() bool` (nil → true) and `func (g GitConfig) Interval() time.Duration` (empty/invalid → `3m`; below `1m` → `1m`).
  - `Editable` gains `BackgroundFetch bool`, `FetchInterval string`; writing the defaults deletes the keys (like `NotifyCommand`).
  - `worktreeSettings` gains `Git *struct{ BackgroundFetch bool \`json:"background_fetch"\`; FetchInterval string \`json:"fetch_interval"\` } \`json:"git"\`` — omitted on PUT keeps current values. PUT rejects an unparsable interval or one under `1m` with 400.
  - TS: `worktree.git: { background_fetch: boolean; fetch_interval: string }`.
  - General tab: a "Background git fetch" Switch + interval TextInput (disabled while the switch is off), each with a `KeyPath`.

- [ ] **Step 1: Write failing tests** — `TestGitConfigDefaults` (nil → enabled, `3m`), `TestGitConfigIntervalFloor` (`30s` → `1m`), `TestEditableGitRoundTrip`, `TestSettingsPutRejectsShortInterval`; run `go test ./internal/config/ ./internal/webui/ -run 'Git|Settings'` → FAIL (`settings_keys_test` also fails until `settingsKeyPaths` lists `git.background_fetch` and `git.fetch_interval`).
- [ ] **Step 2: Implement** the Go side and `settingsKeyPaths`; run → PASS.
- [ ] **Step 3: Implement** the TS type, General panel controls and `tabDirty` entries; add a vitest asserting General's dirty dot lights on changing either field; `cd ui && npm test -- settings` → PASS.
- [ ] **Step 4: Commit** `feat(settings): background git fetch switch and interval`.

---

### Task 8: Status endpoint `GET /api/worktree-git`

**Files:**
- Create: `internal/webui/worktree_git_api.go`, `internal/webui/worktree_git_api_test.go`
- Modify: `internal/webui/server.go` (route; add `fetcher *gitfetch.Scheduler` to `Server`, created lazily from config so tests can inject)

**Interfaces:**
- Consumes: Tasks 1, 3, 6, 7.
- Produces: `GET /api/worktree-git?path=&fetch=1` → `worktreeGitDTO`:
  `{ on_disk, fingerprint, working_fingerprint, branch, main_upstream?, merge_base?, vs_merge_base?{ahead,behind}, tracking?, vs_tracking?{ahead,behind}, working{staged,modified,untracked,files}, fetch{last_ok_at?,last_error?,in_progress} }` (nullable fields as pointers/omitempty). `working.files` = distinct paths in `status -uall`.
  Decision (builder's call in spec): this sits **beside** `/api/worktree-info`; drop only the `git` field from `/api/worktree-info` in Task 12 when its last reader goes.

- [ ] **Step 1: Write failing tests** (pattern: `worktree_info_api_test.go` — register the path, `httptest.NewServer(srv.Handler())`)
  - `TestWorktreeGitReportsMergeBaseAndTracking` — fork-like repo with `origin`; asserts refs, ahead/behind, working counts.
  - `TestWorktreeGitUnregisteredPath404`.
  - `TestWorktreeGitMissingFromDisk` — registered then `os.RemoveAll` → 200, `on_disk:false`.
  - `TestWorktreeGitNoCommits` and `TestWorktreeGitDetachedHEAD` — 200; null merge base / tracking respectively.
  - `TestWorktreeGitFetchOnlyWithParam` — injected scheduler with fake `Fetch`; without `fetch=1` → no call; with → one call; with `git.background_fetch: false` → no call.
- [ ] **Step 2–4:** `go test ./internal/webui/ -run WorktreeGit` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(webui): git status endpoint with fingerprint and background fetch`.

---

### Task 9: Diff endpoints — commits, files, patch, file

**Files:**
- Create: `internal/webui/worktree_diff_api.go`, `internal/webui/worktree_diff_api_test.go`
- Modify: `internal/webui/server.go` (four routes; `revs *revSet` on `Server`)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `GET /api/worktree-diff/commits?path=&base=merge-base|tracking` → `{ list_id, base_ref, merge_base, commits: Commit[] }`; 409 with `{error}` when the base is unavailable.
  - `GET /api/worktree-diff/files?path=&base=&from=&to=` → `{ fingerprint, list_id, files: FileChange[] }`.
  - `GET /api/worktree-diff/patch?path=&base=&from=&to=&ignore_ws=1` → `{ list_id, working_fingerprint, old_rev, new_rev, patch }`; 413 on `ErrPatchTooLarge`.
  - `GET /api/worktree-diff/file?path=&rev=&file=` → `text/plain` body.
  - Invalid range → 400. `revSet`: remembers `(worktree path, rev)` pairs handed out by `/patch` for 30 minutes, capped at 200 entries (oldest evicted); `/file` with an unknown rev → 404.
  - `from`/`to` omitted = All changes.

- [ ] **Step 1: Write failing tests**
  - `TestDiffCommitsListsBranchCommits`, `TestDiffCommitsTrackingUnavailable409`.
  - `TestDiffFilesAllChangesIncludesUntracked`.
  - `TestDiffPatchReturnsResolvedRevs` then `TestDiffFileServesHandedOutRev` (rev from that response works).
  - `TestDiffFileRejectsUnknownRev` — a real commit SHA never handed out → 404.
  - `TestDiffFileCannotReadIgnoredFile` — `.env.local` ignored; request it at the snapshot rev → 404/empty error, never its contents.
  - `TestDiffRejectsInvalidRange` → 400; `TestDiffUnregisteredPath404`.
- [ ] **Step 2–4:** `go test ./internal/webui/ -run Diff` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(webui): diff endpoints for commits, files, patch and file contents`.

---

### Task 10: Open a single file in the editor

**Files:**
- Modify: `internal/webui/editor_api.go`, `internal/webui/editor_api_test.go`, `ui/src/api/client.ts` (`openInEditor(path: string, file?: string)`)

**Interfaces:**
- Produces: `openEditorRequest` gains `File string \`json:"file,omitempty"\``. With a file: runs `startEditor(editor, worktreePath, filepath.Join(worktreePath, file))`. Rejects (400) absolute paths, any `..` element, and paths whose `EvalSymlinks` leaves the worktree; 404 when the file doesn't exist.

- [ ] **Step 1: Write failing tests** — `TestOpenEditorWithFilePassesWorktreeAndFile` (captures args via `startEditor`), `TestOpenEditorFileRejectsEscape` (`../x`, `/etc/passwd`, symlink to outside), `TestOpenEditorFileMissing404`, `TestOpenEditorFileOddName` (`a b/naïve.go`).
- [ ] **Step 2–4:** `go test ./internal/webui/ -run OpenEditor` FAIL → implement (variadic `startEditor(name string, args ...string)` already matches `runEditor`) → PASS.
- [ ] **Step 5: Commit** `feat(webui): open a single changed file in the editor`.

---

### Task 11: Frontend data layer

**Files:**
- Modify: `ui/src/api/types.ts`, `ui/src/api/client.ts`
- Create: `ui/src/hooks/useWorktreeGit.ts`, `ui/src/hooks/useDiffSelection.ts`, `ui/src/hooks/useDiffData.ts`, `ui/src/hooks/useDiffView.ts`, `ui/src/lib/diffLabels.ts`, and tests `ui/src/hooks/useDiffSelection.test.ts`, `ui/src/hooks/useDiffView.test.ts`, `ui/src/lib/diffLabels.test.ts`

**Interfaces:**
- Consumes: Tasks 8–10 DTOs (mirror them exactly in `types.ts`: `WorktreeGit`, `DiffCommits`, `DiffFiles`, `DiffPatch`, `FileChange`, `Commit`).
- Produces:
  - `api.worktreeGit(path, fetch: boolean)`, `api.diffCommits(path, base)`, `api.diffFiles(path, base, range)`, `api.diffPatch(path, base, range, ignoreWs)`, `api.diffFileContents(path, rev, file): Promise<string>`.
  - `type DiffBase = "merge-base" | "tracking"`; `type DiffRange = "all" | { from: string; to: string }` (SHAs or `"uncommitted"`).
  - `useWorktreeGit(path: string, opts: { fetch: boolean })` — `refetchInterval: 5000` while visible, paused when hidden (`refetchIntervalInBackground: false`), refetch on `visibilitychange`.
  - `useDiffSelection(path: string, listId: string | undefined): { base; range; setBase; setRange }` — localStorage key `worktree.diffSelection:<path>`, stores `{ base, range, listId }`; when the stored `listId` ≠ current, range becomes `"all"`; `setBase` resets range to `"all"`. Storage wrapped in try/catch.
  - `useDiffCommits(path, base, enabled, fingerprint)`, `useDiffFiles(path, base, range, enabled, fingerprint)` — fingerprint in the query key.
  - `formatBadge(git: WorktreeGit, base: DiffBase): string | null` — `"↑8 ↓12 · 4"`, `"↑3 ↓0"` (no `· 0`), `null` when all zero.
  - `rangeLabel(commits: Commit[], range: DiffRange): string` — "All changes", "All commits", "Uncommitted changes", "1 commit", "3 of 8 commits + uncommitted"; a run covering every commit is "All commits"/"All changes".
  - `useDiffView(): { open: boolean; file: string | null; enter(file?: string): void; leave(): void }` — `?diff` / `&file=` on the current URL via wouter `useSearch`/`useLocation`, preserving other params (`q`, `resource`); `enter` pushes, `leave` navigates to the URL without `diff`/`file`.

- [ ] **Step 1: Write failing tests** — `diffLabels.test.ts` covers every label above incl. "full run equals All commits"; `useDiffSelection.test.ts` covers persistence per path, reset on `listId` change, `setBase` reset, and storage throwing; `useDiffView.test.ts`: `enter("a b.go")` yields `?diff&file=a%20b.go` preserving `?q=`, `leave()` removes both.
- [ ] **Step 2–4:** `cd ui && npm test -- diffLabels useDiffSelection useDiffView` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(ui): git status and diff data hooks`.

---

### Task 12: Environment and Code tabs, summary, badge

**Files:**
- Modify: `ui/src/hooks/useDetailTab.ts`, `ui/src/components/WorktreeDetailCard.tsx`, `ui/src/components/WorktreeDetailCard.test.tsx`, `ui/src/pages/WorktreeDetailPage.tsx` (placement: `"code"` and `"env"` both span the page under the header, like the old `"env"`)
- Create: `ui/src/components/gitdiff/GitDiffPanel.tsx`, `ui/src/components/gitdiff/GitSummary.tsx`
- Modify: `internal/webui/worktree_info_api.go` (+test) — drop the `git` field once nothing reads it.

**Interfaces:**
- Consumes: Task 11 hooks/labels.
- Produces:
  - `DetailTab = "notes" | "env" | "code" | "cmux"`; a remembered old `"env"` is kept as `"env"` (now Environment) — harmless per spec.
  - `<GitDiffPanel path={string} />` — renders `GitSummary` then (Task 13) the Files changed section.
  - `<GitSummary git={WorktreeGit} repo={string} />` — two columns per the spec (left: Repo, Branch, Working tree, Updated; right: Merge base + indented ahead/behind line, Tracking branch + indented line, Fetched with error tooltip). Stacks when `!useIsWide()`. Renders nothing but "Worktree is missing from disk" when `on_disk` is false.
  - The card calls `useWorktreeGit(path, { fetch: tab === "code" })` and puts `formatBadge(...)` in the Code tab's `rightSection` (same Badge style as `ResourceDetailPane`).

- [ ] **Step 1: Write failing tests** in `WorktreeDetailCard.test.tsx`: tab order `Notes, Environment, Code` (+ cmux when available); env vars render under Environment; badge text `↑8 ↓12 · 4` from a mocked `WorktreeGit`; no badge when all zero; summary shows `8 ahead · 12 behind` on its own line under Merge base; "none (not pushed)" when no tracking; missing-from-disk message.
- [ ] **Step 2–4:** `cd ui && npm test -- WorktreeDetailCard` FAIL → implement → PASS. Then `go test ./internal/webui/ -run WorktreeInfo` after removing the `git` field.
- [ ] **Step 5: Commit** `feat(ui): split Environment and Code tabs with merge-base summary and badge`.

---

### Task 13: Files changed — selectors, range picker, list, editor icon

**Files:**
- Create: `ui/src/components/gitdiff/CompareSelect.tsx`, `RangePicker.tsx`, `FilesChangedList.tsx`, `OpenFileInEditorIcon.tsx`, and tests `RangePicker.test.tsx`, `FilesChangedList.test.tsx`
- Modify: `ui/src/components/gitdiff/GitDiffPanel.tsx`

**Interfaces:**
- Consumes: Task 11 (`useDiffSelection`, `useDiffCommits`, `useDiffFiles`, `rangeLabel`, `useDiffView().enter`), Task 10 (`api.openInEditor(path, file)`). "View diff" calls `enter()`; a path link calls `enter(path)`.
- Produces:
  - `<CompareSelect value base onChange mainUpstream tracking labelPosition="left"|"top" />` — options `merge base (<ref>)` / `tracking branch (<ref>)`; tracking disabled with tooltip when absent.
  - `<RangePicker commits uncommittedCount range onChange labelPosition fullWidth? />` — gestures and copy exactly per the spec (click, shift-click, checkbox extend/trim, disabled middle with its tooltip, quick options, hint line). List body is a plain `overflow-y: auto` Box (not `ScrollArea`).
  - `<FilesChangedList path files onOpenFile(file) />` — row = status glyph · `OpenFileInEditorIcon` · path link · `+x −y`/"binary"; cap 200 rows then "and N more — View diff".
  - `<OpenFileInEditorIcon path file disabled? />` — reads the editor from the settings query like `OpenInEditorButton`; tooltip copy from Global Constraints; shows the error in the tooltip on failure like `OpenInEditorButton`.

- [ ] **Step 1: Write failing tests**
  - `RangePicker.test.tsx`: click selects one; shift-click selects a run; checking a gap row fills it; unchecking an end trims; middle checkbox disabled; label updates; full manual run labelled "All commits".
  - `FilesChangedList.test.tsx`: renders glyph/icon/path/counts in order; "binary" for binary; deleted file's icon disabled; clicking a path calls `onOpenFile(path)`; 250 files → 200 rows + "and 50 more"; editor tooltip text with `code` configured and with none.
- [ ] **Step 2–4:** `cd ui && npm test -- RangePicker FilesChangedList` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(ui): Files changed list with compare and commit-range selectors`.

---

### Task 14: Diff view drill-down

**Files:**
- Modify: `ui/package.json` + lockfile (`npm install @pierre/diffs@^1.6.1` in `ui/`), `ui/src/pages/WorktreeDetailPage.tsx`
- Create: `ui/src/components/gitdiff/DiffView.tsx` (default export, loaded with `React.lazy`), `DiffFileTree.tsx`, `DiffBody.tsx`, tests `ui/src/components/gitdiff/DiffFileTree.test.tsx`, `ui/src/components/gitdiff/DiffView.test.tsx`

**Interfaces:**
- Consumes: Tasks 11–13 (incl. `useDiffView`).
- Produces:
  - `WorktreeDetailPage`: when `open`, keep the sticky header block unchanged, hide the card and `overview`, render `<Suspense><DiffView path headerHeight /></Suspense>`. Esc ladder: from the drill-down, `escapeIdle` calls `leave()` first. Typing in the header search calls `leave()` (spec: "my call").
  - `DiffView` layout: breadcrumb row (`← Code / Changes`, "Esc to go back") then a flex row sized `height: calc(100dvh - headerHeight - breadcrumb)` — the one deliberate inner scroller on this page, because pierre's `Virtualizer` must own its scroll container; leave a comment saying so next to the page's "document scrolls" comment.
  - Sidebar (collapsible; collapsed state in localStorage `worktree.diffSidebar`): `CompareSelect`/`RangePicker` with `labelPosition="top"`, "Filter files" input, `<DiffFileTree files selected onSelect />` (Mantine `Tree`, compacts single-child dir chains, `+/-` per file). Narrow (`!useIsWide()`): sidebar in a `Drawer`, unified forced.
  - Toolbar: sidebar toggle (selectors move here when collapsed) · counts · Refresh notice · Split/Unified (localStorage `worktree.diffMode`) · Hide whitespace (default off).
  - `<DiffBody patch oldRev newRev mode path onOpenFile />` — `WorkerPoolContextProvider` + `Virtualizer` + one `FileDiff` per `parsePatchFiles(patch, cacheKey)` entry; `cacheKey` = `${listId}:${workingFingerprint}:${ignoreWs}`; `renderHeaderPrefix` = chevron + `OpenFileInEditorIcon`; `loadDiffFiles` fetches both sides via `api.diffFileContents` with `oldRev`/`newRev` (old side `null` for added files); auto-collapse lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`) and files over 1,500 changed lines; binary files render a placeholder row instead of `FileDiff`; each file wrapped in an element with a stable id for `scrollIntoView`.
  - Stale rule: show Refresh when `git.list_id`-equivalent (from `useDiffCommits`) ≠ the patch's `list_id`, or the selection includes uncommitted and `git.working_fingerprint` ≠ the patch's. The view renders the selection it loaded (pinned); Refresh re-reads the live selection.
  - On entry with `file`, scroll to and highlight that file once the body has rendered.

- [ ] **Step 1: Write failing tests**
  - `DiffFileTree.test.tsx`: `internal/webui/a.go` + `internal/webui/b.go` → one `internal/webui` node; counts shown; clicking a file calls `onSelect`.
  - `DiffView.test.tsx` (mock `DiffBody` — pierre's shadow DOM is opaque to tests): Refresh notice hidden initially, shown when the polled `working_fingerprint` changes with an uncommitted selection, **not** shown when only `upstream/main` moves; clicking Refresh refetches the patch; selection change refetches immediately; Esc calls `leave`.
- [ ] **Step 2–4:** `cd ui && npm test -- DiffFileTree DiffView` FAIL → implement → PASS.
- [ ] **Step 5: Verify the lazy chunk** — `make build`; `ls ui/dist/assets` shows a separate chunk containing pierre (and its worker); run `bin/worktree ui` on a spare port per `.claude/CLAUDE.md`, open a worktree, enter the diff view, expand an unchanged region, toggle whitespace, and confirm the network tab only loads the pierre chunk on entry.
- [ ] **Step 6: Commit** `feat(ui): drill-down diff view on @pierre/diffs`.

---

### Task 15: Docs

**Files:**
- Modify: `docs/web-ui-architecture.md`, `.claude/CLAUDE.md`

- [ ] **Step 1:** In `docs/web-ui-architecture.md`, add a "Code tab and diff view" section: tabs, the `?diff[&file=]` drill-down and its inner scroller exception, endpoints and DTOs (Tasks 8–10), the polling + fingerprint model, the background fetch scheduler and lock skip, the snapshot and rev-set security model, and the pierre worker gotcha. In `.claude/CLAUDE.md`, add `gitfetch` to the package list and extend `gitutil`'s and `webui`'s bullets.
- [ ] **Step 2:** `make test` and `cd ui && npm test` — all PASS; `make build` succeeds (it runs `tsc -b`, the UI's only static check — there is no lint script).
- [ ] **Step 3: Commit** `docs: Code tab, diff view and background fetch`.
