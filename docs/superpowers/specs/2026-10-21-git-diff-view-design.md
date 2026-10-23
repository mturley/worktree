# Code tab and diff view — design

Date: 2026-10-21 (revised 2026-10-22 after three UX spikes)
Status: draft

## Why

The worktree detail page's **Git / Environment** tab shows one `git status`
line: branch, upstream, ahead/behind the branch's own upstream, and
staged/modified/untracked counts. That answers "is the tree dirty", but not the
questions that matter while an agent works in a worktree:

- How far has this branch drifted from `main`, and is `main` moving under it?
- Which files has this work touched, and by how much — in total, in one commit,
  or in what's still uncommitted?
- What does the change actually look like — without leaving the UI for a
  terminal, an editor, or a pushed PR?

The diff view is also the planned future home for **inline review comments**
(drag across lines, write feedback, gather it into a prompt for an agent). That
is out of scope here, but it decided the library choice and the "never shift
the diff under the reader" rule below.

## Goals

1. Split the tab: an **Environment** tab (the env vars) and a **Code** tab.
2. The Code tab's summary shows the **merge base** with `main`'s upstream
   and the **tracking branch**, each with its own ahead/behind.
3. A **Files changed** list with per-file `+/-`, for a chosen comparison: a
   base (merge base or tracking branch) and a contiguous **range of commits**,
   optionally including uncommitted changes.
4. A GitHub-"Files changed"-style **diff view**, drilled into from the detail
   page: file tree, split/unified, hide-whitespace, expandable context.
5. **Open in editor** for any changed file, from the list and the diff view.
6. A **badge on the Code tab** summarizing the state without opening it.
7. The badge and file list stay current on their own; remote-tracking refs stay
   current through a background `git fetch` while the Code tab is open.

## Non-goals

- Inline comments, review prompts, or any write action on the diff (future).
- Staging, committing, discarding, or any other mutation of the worktree.
- Diffs on the home page / worktree list. Everything is per worktree.
- Light mode (the app is dark-only).
- Non-contiguous commit selections (a diff can't skip commits in the middle).

## Anti-goals

- **Heavy fetching when nothing is being looked at.** The full patch, the diff
  library and file contents load only in the diff view. Polling and fetching
  stop when no detail page is visible.
- **The diff moving under the reader.** The diff view never re-renders itself
  from a background change; it offers a Refresh instead.
- **Prompting for credentials, hanging, or fighting the user's own git
  commands** with a background `git fetch`.

## Terms

- **Main upstream**: `git rev-parse --abbrev-ref main@{upstream}` (Mike's
  instruction), e.g. `upstream/main` on a fork. Fallback when `main` has no
  upstream: `git symbolic-ref --short refs/remotes/origin/HEAD`. If neither
  resolves, merge-base comparisons are unavailable (shown, not hidden).
  *Builder's call:* when the default branch isn't literally `main`, use the
  branch `origin/HEAD` names in place of `main` before resolving `@{upstream}`.
- **Merge base**: `git merge-base HEAD <main upstream>`.
- **Tracking branch**: `git rev-parse --abbrev-ref HEAD@{upstream}`, e.g.
  `origin/feature`. Called "tracking branch" in the UI, never "upstream", because
  `upstream` is also a common remote name. Often absent (unpushed branch).

## UI

### Tabs

`Notes | Environment | Code (badge) | cmux` — Environment before Code.

- **Environment** holds the env var rows the old tab showed (unchanged
  `EnvVarRow`s). Wide, it sits under the header like the old tab did.
- **Code** holds everything below. Wide, it spans the page under the header.
- `useDetailTab`'s persisted ids change: today `"env"` means Git / Environment.
  New ids `"env"` (Environment) and `"code"` (Code). *Builder's call* how to
  map an old remembered `"env"` — either is harmless.

### Code tab: summary

Two columns (stacked when narrow):

```
Repo           worktree                 Merge base       upstream/main @ 76ef50c
Branch         diff-view                                   8 ahead · 12 behind
Working tree   2 modified · 2 untracked Tracking branch  origin/diff-view
                                                           3 ahead · 0 behind
                                        Fetched          2m ago
```

- Ahead/behind sit on their own **indented** line under their ref.
- Merge base shows the short SHA (copyable full SHA). Unavailable → an inline
  reason ("main has no upstream").
- Tracking branch absent → "none (not pushed)" and no ahead/behind line.
- **Fetched**: "2m ago", or a quiet warning icon whose tooltip is the last fetch
  error.
- "Working tree" is today's `gitSummary` (yellow when dirty). **Updated** (the
  old tab's last-event row) moves along with it.

### Code tab: Files changed

Header row: **Files changed (N)** with total `+x −y`, then the two selectors
(labels outside the controls, to their left), then **View diff**:

```
Files changed (62) +1959 −611   Compare with: [merge base (upstream/main) ▾]  Changes from: [All changes ▾]  [View diff]
```

**Compare with** — a Select:
`merge base (upstream/main)` / `tracking branch (origin/feature)`, naming the
actual refs. The tracking option is disabled with a tooltip when there is none.

**Changes from** — a range picker (popover), modelled on GitHub's PR
"Changes from all commits" menu:

- Quick options at the top: **All changes** (every commit + uncommitted),
  **All commits** (committed only — what the PR shows), **Uncommitted changes**
  (working tree vs HEAD).
- Then a list, newest first: **Uncommitted changes** (with its file count),
  then each commit after the base: subject, short SHA, relative age.
- The selection is always **one contiguous run** of that list (uncommitted
  counts as the newest entry):
  - **Click** a row: just that entry.
  - **Shift-click**: from the last-clicked row to this one.
  - **Checkboxes**: checking an unselected row extends the run to include it
    (filling the gap); unchecking an end row trims it. A middle row's checkbox
    is disabled, with a tooltip: "Commits between the ends stay selected — trim
    from either end."
  - A hint line explains the three gestures.
- Button label names the choice: "All changes", "All commits", "Uncommitted
  changes", "1 commit", "3 of 8 commits + uncommitted".
- No commits ahead of the base → the list is just "Uncommitted changes".

**The list** — one row per file, columns aligned:

```
M  </>  internal/gitutil/diff.go                                   +128 −0
```

status glyph (A/M/D/R, coloured) · **open-in-editor icon** · path (renames
`old → new`) · `+x −y` or "binary". The path is a link that drills into the
diff view **at that file**. Sorted by path. *Builder's call:* cap the rendered
rows (e.g. 200, then "and N more — View diff").

Empty: "No changes" for the selection. Unavailable (no main upstream / no
tracking branch): an inline explanation.

### Selection semantics and persistence

- The picker's commit list is `git rev-list --first-parent <base-ref>..HEAD`
  (newest first), where base-ref is the main upstream or the tracking branch.
- **Old side:** when the run includes the **oldest** commit in the list, the old
  side is `merge-base(<run's newest end>, base-ref)` (HEAD when the run
  includes Uncommitted) — not that commit's `^1`, and not always
  `merge-base(HEAD, base-ref)` — so a branch
  that has merged `main` in never shows `main`'s changes as its own (GitHub's
  PR diff does the same). Otherwise, a run whose oldest selected commit is A
  starts at `A^1` (for a merge commit in the middle that shows what the merge
  brought onto the branch, which is honest). When only Uncommitted is selected,
  the old side is `HEAD`. (My call.)
- **New side:** the run's newest commit, or the **working-tree snapshot**
  (below) when the run includes Uncommitted.
- So "All changes" is merge base → snapshot and "All commits" is merge base →
  `HEAD`. Selecting every row by hand is identical, and is labelled the same
  ("All commits" / "All changes"), never "8 of 8 commits".
- **Persisted per worktree** in `localStorage`, keyed by worktree path (like
  `worktreeSortPref`): `{ base, range }` where range is `"all"` or endpoints by
  SHA / `"uncommitted"`. The tab and the diff view share it.
- **Reset to "All changes"** whenever the commit list changes — new commits,
  a rebase, or the tracking branch moving after a fetch (Mike's call). Detect
  by storing the list's identity with the selection: `list_id` = a hash of the
  **list's own SHAs plus the old-side merge base**. A fetch that only moves
  `upstream/main` doesn't change `upstream/main..HEAD` or the merge base, so it
  doesn't reset anything; it only updates the behind count. Changing the base
  also resets. Uncommitted edits alone never reset. (My call on the identity.)
- **The diff view pins what it loaded.** The tab applies a reset immediately
  (its list is live, per Mike). The diff view instead keeps rendering the
  selection it loaded, and treats a `list_id` change like any other stale
  state: the Refresh notice appears, and Refresh applies the current (reset)
  selection. While stale, its selectors show the pinned selection's label. A
  pinned selection is therefore never re-requested from the patch endpoint, so
  endpoint 4's `from`/`to` validation against the current list stays strict;
  expansion keeps working because it uses the resolved SHAs (endpoint 5).
  (My call, following the "never shift under the reader" rule.)

### Tab badge

On the Code tab label, for the worktree's remembered base: `↑A ↓B · N`
(A/B = commits ahead/behind that base, N = files changed in the working tree;
the `· N` part only when N > 0). Hidden when every number is zero. Shown on any
tab, from the polled status endpoint — no extra request. Style it like the
existing tab badges (`ResourceDetailPane`'s `rightSection`).

### Diff view (drill-down)

A drill-down **inside the worktree detail page**, not a modal and not a new
route (`/worktree/:path*` would swallow `/worktree/<path>/diff`):

- **URL**: `?diff` on the detail page URL, plus `&file=<path>` to land on one
  file — same mechanism as the existing `?resource=`, `?tab=`, `?q=` params.
  Back, reload and links (incl. from a phone) work.
- **The detail page's real header stays** (title, search bar, open-in-editor,
  cmux, etc.). Only the body below it is replaced. *My call:* typing in the
  header search leaves the drill-down for the worktree view, since that's where
  search results live.
- **Breadcrumb row** under the header: `← Code / Changes`, plus "Esc to go
  back". Esc joins the page's existing Esc ladder: from the drill-down it goes
  back to the worktree view (not while focus is in an input/popover).
- **Sidebar (left, collapsible)**:
  - "Compare with:" and "Changes from:" with labels **above** the controls;
    same shared selection as the tab.
  - "Filter files" box.
  - A **file tree**: directories collapsible, single-child directory chains
    compacted (`internal/webui`), `+/-` per file. Clicking a file scrolls the
    diff to it and highlights it. Mantine `Tree` (spike-verified).
  - A toolbar button hides/shows the sidebar. While hidden, the two selectors
    move into the toolbar (labels to the left) so the comparison stays visible.
    *My call:* remember collapsed state globally in `localStorage`.
- **Toolbar**: sidebar toggle · "N files changed +x −y" · (when stale) the
  **"Files changed on disk · Refresh"** notice · Split / Unified · "Hide
  whitespace" (default **off**). *Builder's call:* remember split/unified
  globally.
- **Body**: one pierre `FileDiff` per file inside pierre's `Virtualizer`.
  Sticky per-file headers with `+/-`. Each header's prefix holds, in a fixed
  aligned column: a **collapse chevron** (pierre `collapsed` option) and the
  **open-in-editor icon**; pierre's file icon and name follow.
  - Files start collapsed when lockfiles/generated (`package-lock.json`,
    `go.sum`, …) or over a threshold (*builder's call*, ~1,500 changed lines).
  - **Expand unchanged lines** via pierre's `loadDiffFiles`, called only when
    an "N unmodified lines" bar is clicked; it fetches both sides from the
    file-contents endpoint.
  - Binary / oversized files: a placeholder instead of a diff.
- **Narrow (phone)**: sidebar becomes a drawer opened from the toolbar; force
  unified. *My call.*
- Changing the selection or whitespace switch is an explicit action, so it
  reloads immediately (not gated by Refresh).

### Never shift under the reader

The diff view renders the patch it loaded and keeps it. It shows the Refresh
notice only when what it shows could actually differ: the commit list's
`list_id` changed, or the selection includes Uncommitted and the working-tree
part of the fingerprint changed. A fetch that only moves `upstream/main` does
not raise it. (My call; the patch endpoint returns the `list_id` and
working-tree fingerprint it was computed at, so the client can compare.) Only Refresh (or a selection/whitespace change)
reloads. This keeps future in-progress comments safe.

### Open in editor (per file)

- Icon: `IconCode`, tooltip **"Open in `<editor>` (configure editor in
  settings)"**, where `<editor>` is the configured `editor` value (e.g.
  "Open in code (configure editor in settings)"). No editor configured →
  tooltip "Configure an editor in settings" and the icon disabled. *Builder's
  call:* how the client learns the editor name (the settings DTO already has
  `editor`; a small field on the status endpoint is also fine).
- Disabled for deleted files (nothing on disk to open).
- Backend: extend `POST /api/worktrees/open-editor` with an optional `file`
  (worktree-relative). It runs `<editor> <worktree> <worktree>/<file>` — for
  `code`, Cursor and Zed this opens the file in the worktree's window, reusing
  it if open. Validate `file`: relative, clean, no `..`, resolves inside the
  worktree (after `EvalSymlinks`), and exists. Same registered-worktree check
  and `startEditor` test hook as today.

## Library: `@pierre/diffs`

Chosen over `@git-diff-view/react` and `react-diff-view` after a spike rendering
a real 32-file patch in the app shell:

- GitHub-like look; sticky per-file headers with `+/-`.
- Native drag-to-select **line ranges** via the gutter utility
  (`enableGutterUtility`, `onGutterUtilityClick(range)`), plus
  `lineAnnotations`/`renderAnnotation` for inline rows — the future comment
  flow. `@git-diff-view/react` only does single lines.
- On-demand context expansion (`loadDiffFiles`). `@git-diff-view/react` needs
  both full file contents up front.

Spike findings the builder needs:

- **Worker pool** for responsiveness: `WorkerPoolContextProvider` with
  `workerFactory: () => new DiffsWorker()` where
  `import DiffsWorker from "@pierre/diffs/worker/worker-portable.js?worker"`.
  The non-portable `worker.js` failed under Vite with
  `Theme "pierre-dark" has not been resolved`. Pass `highlighterOptions={{}}`
  and don't override `theme` in `FileDiff` options (use pierre's defaults with
  `themeType: "dark"`).
- **`Virtualizer`** around the file list; it is its own scroll container, so
  give it an explicit height. Scrolling to a file via `scrollIntoView` on a
  per-file wrapper element works with it (spike-verified).
- `parsePatchFiles(patch, cacheKeyPrefix)` splits a multi-file git patch into
  `FileDiffMetadata[]`. Use a prefix that changes with each load (e.g. the
  fingerprint + whitespace flag) so worker highlight caches never serve stale
  content.
- `renderHeaderPrefix` takes React nodes — that's where the chevron and editor
  icon go.
- `vite/client` types are needed for the `?worker` import.
- pierre renders inside shadow DOM: Playwright accessibility snapshots don't
  see diff content; tests should assert on our own wrapper elements.
- Mantine `ScrollArea` let a popover's rows grow wider than the popover; the
  range picker's list uses a plain `overflow-y: auto` box.

Load the diff view (and with it `@pierre/diffs`) via `React.lazy`, so the
library is a separate chunk fetched on first drill-down. This is the app's first
lazy chunk; check `make build` embeds the extra assets correctly.

## Backend

All git calls go in `internal/gitutil` (pure functions over a directory, tested
against real repos with `internal/testgit`). Endpoints take `?path=` like
`/api/worktree-info` and must **refuse paths that are not registered
worktrees**.

### Working-tree snapshot

Whenever a comparison includes uncommitted changes, the server snapshots the
working tree as a git tree object and diffs against that, never the live disk:

1. Copy the real index to a temp file; point `GIT_INDEX_FILE` at it (keeps
   git's stat cache, so this is fast).
2. `git add -A` into the temp index (respects `.gitignore`: untracked
   non-ignored files are included, ignored ones are not).
3. `git write-tree` → the snapshot tree SHA.

Expanding unchanged lines then reads `git show <snapshot>:<file>`, so expansion
always matches the loaded patch even if an agent edits the file afterwards. The
real index is never touched. Cost: blobs for changed files land in the object
database as unreachable objects, pruned by `git gc` on its normal schedule.

### 1. `GET /api/worktree-git?path=[&fetch=1]` — status + fingerprint (polled)

Polled every 5s while a detail page is visible (any tab, for the badge).

```jsonc
{
  "fingerprint": "sha256…",
  "branch": "diff-view",
  "main_upstream": "upstream/main",      // null if unresolvable
  "merge_base": "abc1234…",              // null if unresolvable
  "vs_merge_base": { "ahead": 8, "behind": 12 },
  "tracking": "origin/diff-view",        // null if none
  "vs_tracking": { "ahead": 3, "behind": 0 },
  "working": { "staged": 0, "modified": 2, "untracked": 2, "files": 4 },
  "fetch": { "last_ok_at": "…", "last_error": null, "in_progress": false }
}
```

- Counts: `git rev-list --left-right --count <ref>...HEAD`.
- **Fingerprint** = hash of HEAD, main-upstream SHA, tracking SHA,
  `git status --porcelain=v1 -uall` output, and size+mtime of every file status
  lists. mtimes catch re-edits of already-modified files; `-uall` (not
  `-unormal`) catches new files inside new untracked directories. Gitignored
  trees aren't listed either way, so cost stays low.
- `fetch=1` also triggers the background fetch check (below), without waiting.
- *Builder's call:* replace the `git` field of `/api/worktree-info` or sit
  beside it. `/api/worktree-info`'s env part stays (Environment tab).

### 2. `GET /api/worktree-diff/commits?path=&base=` — the picker's list

`base` = `merge-base` | `tracking`. Returns `{ list_id, base_sha, commits:
[{ sha, short, subject, author, date }] }` (newest first, first-parent), where
`list_id` = hash of the list SHAs + old-side merge base (the reset-to-All key). Fetched while the Git
Diff tab or diff view is open; refetched when the fingerprint changes.

### 3. `GET /api/worktree-diff/files?path=&base=&from=&to=` — file list

`from`/`to` = commit SHAs from the list, or `uncommitted`; omitted = All
changes. `git diff --numstat -z -M` (plus `--name-status` for statuses) for the
resolved old/new sides. Returns `{ fingerprint, files: [{ path, old_path?,
status, additions, deletions, binary }] }`. Refetched on fingerprint or
selection change while the tab is open.

### 4. `GET /api/worktree-diff/patch?path=&base=&from=&to=&ignore_ws=` — full patch

Unified patch (`git diff -M`, `-w` when `ignore_ws`). Fetched only by the diff
view. Returns the `list_id` and working-tree fingerprint it was computed at, and the **resolved**
`old_rev`/`new_rev` (commit or snapshot tree SHAs), so a fetch moving
`origin/main` can't change what expansion reads. *Builder's call:* a size cap
(e.g. 20 MB) with a clear error past it.

Validate `from`/`to`: each must be `uncommitted` or a SHA in the current commit
list for that base, with `from` not newer than `to`.

### 5. `GET /api/worktree-diff/file?path=&rev=&file=` — one side's contents

For `loadDiffFiles`. `rev` must be one of the SHAs this server handed out
(a commit in the worktree's history, or a snapshot tree it created recently —
keep a small in-memory set). Contents come only from `git show <rev>:<file>`,
never the filesystem, so gitignored files like `.env.local` can't be read and
`..` escapes are meaningless.

### 6. `POST /api/worktrees/open-editor` — gains optional `file`

See "Open in editor" above.

### Background `git fetch`

- **Trigger:** status polls carrying `fetch=1`, which the page sends only while
  the **Code tab** (or the diff view) is showing and the browser tab is
  visible (Mike's call). Polls from other tabs update the badge from local refs.
- **Lock check:** skip — retry next poll, not counted as an attempt — when any
  git lock file is present in the common dir or the worktree's git dir
  (`index.lock`, `HEAD.lock`, `packed-refs.lock`, `shallow.lock`, `*.lock`
  under `refs/`). Mike's call. A collision is still possible if the user starts
  a command mid-fetch; that window is small and accepted.
- **Dedup:** one in-memory record per repo, keyed by
  `git rev-parse --git-common-dir`: last attempt, last success, last error,
  in-progress. Start only when none is running for that repo and the interval
  has elapsed since the last attempt (failures wait out the interval too).
- **What:** `git fetch --prune <remote>` for each distinct remote among the
  main upstream's and the tracking branch's (e.g. `upstream` and `origin` on a
  fork). Never `--all`.
- **Safety:** `GIT_TERMINAL_PROMPT=0`; SSH in batch mode (`-o BatchMode=yes`,
  respecting an existing `GIT_SSH_COMMAND`/`core.sshCommand` — builder picks
  the least invasive way); ~60s timeout; cancelled on server shutdown.
- **Config:** `git.background_fetch` (bool, default true) and
  `git.fetch_interval` (duration, default `3m`, min `1m`) in worktree's
  `config.yaml`, on the Settings modal's **General** tab. Follow the repo's
  "Config files ↔ Settings modal" checklist: `internal/config/editable.go`,
  settings DTO/PUT, `settingsKeyPaths`, `ui/src/api/types.ts`, `tabDirty.ts`,
  tests on both sides.
- Not a watcher service: `git fetch` isn't the GitHub API and remotes may not
  be GitHub, so it has its own switch rather than `watchers.github`.

## Frontend data flow

- `useWorktreeGit(path, { fetch })` — endpoint 1, `refetchInterval: 5000`
  while visible; `fetch` true only while Code / the diff view shows. Feeds
  the badge, the summary and the stale check.
- `useDiffSelection(path, listId)` — the persisted `{ base, range }`; resets to
  All when `listId` changes.
- `useDiffCommits`, `useDiffFiles` — endpoints 2 and 3, query keys include the
  fingerprint; enabled only while Code or the diff view shows.
- Diff view: endpoint 4 on entry / Refresh / selection or whitespace change; it
  remembers the fingerprint it loaded at for the Refresh notice.

## Docs and tests

- Update `docs/web-ui-architecture.md` (tabs, routes/params, DTOs, polling and
  fetch model, the lazy chunk, the drill-down) and `.claude/CLAUDE.md`'s
  `gitutil`/`webui` notes.
- Go: `gitutil` tests on real temp repos — main-upstream resolution + fallback,
  no tracking branch, first-parent commit list, range → old/new resolution,
  snapshot (untracked included, ignored excluded, real index untouched),
  renames, binary, whitespace, fingerprint changes on re-edit and on new files
  in new directories. Fetch scheduler with a fake clock/command (dedup,
  interval, failure backoff, lock-file skip, no fetch without `fetch=1`).
  Endpoint tests incl. unregistered path, invalid `from`/`to`, unknown `rev`,
  and open-editor `file` escapes.
- UI (vitest): badge formatting; range picker gestures (click, shift-click,
  extend, trim, middle disabled, labels); selection persistence + reset on
  `listId` change; Refresh-notice logic; Files changed states (empty /
  unavailable / capped); editor tooltip text with/without an editor.

## Spike cleanup

Before implementation: stop the spike's Vite server (PID in
`~/tmp/diff-view-spike-vite.pid`), delete `ui/spike.html`, `ui/spike-tab.html`,
`ui/src/spike/` and `ui/public/spike/`, and reinstall `ui/` deps from the
lockfile (the spike used `npm install --no-save`). Then add `@pierre/diffs`
properly to `ui/package.json`.

## Left to the builder

Marked "builder's call" above: default-branch-not-`main` handling, old `"env"`
tab-id mapping, list row cap, how the client learns the editor name,
split/unified persistence, auto-collapse threshold, patch size cap, SSH batch
mode mechanism, and whether the status endpoint replaces or sits beside
`/api/worktree-info`'s `git` field.
