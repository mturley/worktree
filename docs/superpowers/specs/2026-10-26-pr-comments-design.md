# PR comments in the diff view — design

**Status:** Design (2026-10-26). Phase 2 of `2026-10-23-review-comments-roadmap.md`.
**Builds on:** phase 1, `2026-10-23-review-comments-design.md` (merged to `main` at c98d419).

## Intent

When a reviewer leaves comments on Mike's PR, he wants to read them where the code is: in the worktree's diff view, beside his own local draft comments. He then addresses them, usually by pointing an agent at the PR. Today he has to switch to GitHub to see which lines a comment is about.

## Goals

- For a worktree with a **tracked PR whose branch matches the worktree's branch**, show that PR's review comments **read-only** in the diff view.
- Split the review sidebar into two tabs: **Local comments** and **PR comments**.
- A **"Show in diff view"** switch on the PR comments tab puts PR comments inline in the diff.
- PR comments look **visibly different** from local drafts and carry an author line that names the PR.
- **Resolved threads collapse.**
- PR comments that are **unread activity events** show as unread, and can be marked read from the diff view.
- The activity feed's event modal can **jump to a PR comment** in the diff view.
- The counts on the Code tab button and the diff view's toolbar button include PR comments.

## Non-goals

- **Replying** to PR comments, resolving threads, or reacting. This could be a later phase 2b.
- **Posting** drafts to GitHub. That is phase 3.
- **"Copy comments for agent"** for PR comments. Mike asks an agent to read the PR directly.
- PR-level (issue) comments and review summary bodies. Only line-anchored review comments are in scope.

## Anti-goals

- **Code must never shift under Mike while he reads.** New, edited or resolved PR comments arriving while the diff is open don't re-render it. They mark the view stale and surface the existing Refresh button, the same way code changes do.
- **No GitHub contact while the GitHub watcher is off.** With `watchers.github: false`, the PR tab says the GitHub watcher is off, and the diff view shows local drafts only.
- **No second polling engine for GitHub.** The fetch is on demand, through the watcher library.

## How it works

### Which PR

The worktree's tracked PR resources (any of them, primary or related) are candidates. Its PR is the one whose **head branch name** equals the worktree's current branch (`/api/worktree-git`'s `branch`). If none matches, the PR tab says so: "No tracked PR for branch `<branch>`". If more than one matches, the builder picks one rule: prefer primary, then the most recently updated. Mark that rule in the docs.

The head branch name comes from the new library call (below), not from cached poll state, which doesn't have it.

### Fetching (watcher library, cross-repo)

The watcher library's current poll gets only a flattened, last-20 view of review comments with no positions. Phase 2 adds an **on-demand** call to `~/git/watcher/github`, released and re-pinned here per `.claude/CLAUDE.md` "Watcher library":

- It fetches one PR's **review threads**, paginated to completion (no silent 20-item cap).
- It returns the PR's `headRefName` and `headRefOid`.
- Per thread: `isResolved`, `isOutdated`, `path`, `diffSide`, `line`/`startLine`, `originalLine`/`originalStartLine`, and its comments.
- Per comment: GitHub id (`databaseId`), author login and avatar URL, `body`, `createdAt`, `url` (the permalink), `commit`/`originalCommit` oid, and `diffHunk`.
- It returns the PR's `baseRefOid` too, for placing old-side comments.
- **It includes Mike's own pending (unsubmitted) review comments**, marked as pending (GitHub's `state: PENDING` on the comment or review). They show with a **"Pending" label**, just as GitHub shows them, and are otherwise read-only like the rest. Building and submitting a review from them is phase 3.
- It is GraphQL, like the rest of the library, and takes the token the same way `FetchPRs` does.

The server calls it **only when the GitHub watcher is enabled** (`s.WatcherEnabled(config.ServiceGitHub)`). It keeps a short in-memory cache keyed by PR so several open clients don't each hit GitHub. **Library changes are welcome** wherever they're the cleaner fix. There's no back-compat constraint within this unreleased feature.

**Fetched when the diff view opens, re-checked while it stays open.** The server exposes a fingerprint of the thread set (ids, resolved flags, edit times). The client polls it on a slow cadence while the diff view is visible. When it changes, the view is marked stale and the Refresh button appears. Refresh reloads the threads together with the patch. The cadence is the builder's call, with GitHub's rate limit in mind (something like 60s).

### Placing PR comments in the view

Each PR comment maps onto the shown view (`old_rev`/`new_rev`) through phase 1's machinery:

- The server reads the file at the comment's **original commit** (or its current `commit`), builds an anchor with `reviewcomments.Capture` over GitHub's lines and side (RIGHT = new, LEFT = old), and resolves it with `reviewcomments.Resolve` against the shown view. It gets the same statuses as drafts: shown, moved, outdated, not in view, outside changes.
- **Old-side (LEFT) comments** point at the PR's base as it was. The library also returns the PR's `baseRefOid`, and the server reads the file at `merge-base(originalCommit, baseRefOid)` to capture the anchor, then resolves it against the view's old side. When that can't be computed, the comment is sidebar-only, like a missing commit. Stacked PRs whose base isn't upstream main may land as "not in view" more often. That's accepted.
- **If that commit isn't in the local repo** (never fetched, force-pushed away), the comment can't be placed. It shows in the sidebar only, as out of date, with "View on GitHub".
- **Where GitHub itself marks a thread outdated, keep that:** the thread shows the Outdated badge even if the lines would still match locally.
- PR comment positions are computed on request, never stored. **Nothing about PR comments is persisted in worktree's DB.** Read state comes from the existing unread cursor (below).

### Threads

A thread renders as **one card**: the first comment, then its replies stacked beneath it, all read-only. The thread is anchored where its first comment is.

A **resolved** thread renders collapsed, both in the sidebar and inline, as one line: "▸ Resolved · @author · file:line — first words…". Clicking it expands the thread.

### Look

- **Accent:** PR comments use a **violet** border and violet links (Mantine `grape`). Local drafts keep their blue.
- **Author line:** "@login on PR #1234", with the avatar, a relative time, and two links:
  - **"View all"** opens the review sidebar on the PR comments tab.
  - **"View on GitHub"** opens that comment's permalink.
- Read-only: no edit or delete icons. `editable: false`, with a new comment source `pr` in the existing DTO and `SOURCE_STYLE`.
- The Outdated badge works as it does for drafts.

### Sidebar

- Two tabs: **"Local comments (N)"** and **"PR comments (N)"**. The phone drawer gets the same tabs.
- The **Local** tab is phase 1's sidebar unchanged, including "Copy comments for agent" and "Clear all".
- The **PR** tab, from the top:
  - The **"Show in diff view"** switch, remembered per browser (localStorage).
  - The PR it shows ("PR #1234"), linking to GitHub.
  - The threads, open ones first in file order, then resolved ones collapsed.
  - Clicking a thread's `file:line` jumps to it in the diff, like drafts do.
- The sidebar can be opened on either tab.
- **With "Show in diff view" off**, PR comments don't render inline at all, and the toolbar counts still include them.

### Unread

A PR comment is **unread** when its matching `pr_review_comment` timeline event is unread under the PR resource's read cursor (`internal/unread`, which already excludes Mike's own events via `selfid`).

- **Matching a GitHub comment to its event:** the poller stores no comment id on events today. The library's poller should record the comment's GitHub id on the `pr_review_comment` event, as a `comment:<databaseId>` tag in the existing `tags` field (as CI's `commit:<sha>` does), with no schema change. Match on that. Matching on author + path + `createdAt` is the fallback for events polled before that change.
- **Unread PR comments** get the unread blue dot on their card, inline and in the sidebar.
- Under each thread that has unread comments, there's a **"Mark all read"** button. It opens the existing **Mark all read modal for the PR resource** (`MarkAllReadButton`'s modal), not a per-comment action.
- After "Mark all read", the unread dots and counts clear right away. Only read state is refetched, which moves no code, so this doesn't wait for Refresh.
- The file tree's comment dot (phase 1) covers files with PR comments too, when "Show in diff view" is on.

### What the counts count

One rule everywhere: the PR comments tab's "(N)", the Code tab button and the toolbar button all use it.
- **"N PR comments"** counts **open threads**. Resolved threads are left out, so a fully addressed review stops showing up in the buttons. Open threads count even when GitHub calls them outdated or they can't be placed locally. A thread holding only Mike's pending comments counts too.
- **"(N unread)"** counts **unread comments**, replies included, across open threads. Mike's own comments, pending or published, are never unread.

### Button labels

- **Code tab:** "Review changes (N pending local comments, N PR comments (N unread))".
  - Each part is left out at zero, and "(N unread)" only appears when some are unread.
  - Singular forms at 1. With nothing, it reads just "Review changes".
  - The button is **unread-blue** (filled) only if there are local comments or unread PR comments.
- **Diff view toolbar:** "N pending local review comments, N PR review comments (N unread)", with the same omission and singular rules.
  - The button is unread-blue under the same condition, and shown when either count is non-zero.
  - It still reads "Close comments sidebar" while open.
- These counts come from the whole worktree (no view), like phase 1's Code tab count. Counting PR comments there means the Code tab fetches threads too. It re-checks on the same slow cadence while showing, served from the same per-PR server cache. However many tabs or devices are open, GitHub sees at most one fetch per PR per cache period.

### "Go to comment in diff view" from the activity feed

The event details modal (`EventDetailsModal`), for a `pr_review_comment` event that can be matched to a PR thread comment, gets a **"Go to comment in diff view"** button.
- It navigates to the diff view of a worktree that tracks that PR and is on its branch, prefers the modal's own `path` when given, and otherwise uses the first such worktree.
- The diff view opens with the PR tab of the sidebar selected and **"Show in diff view" turned on**, then scrolls to the comment and highlights it.
- If the comment can't be placed in the view, it jumps to the thread in the sidebar instead.
- If nothing matches (no such worktree, or the event can't be matched), the button isn't shown.

## Constraints

- Every GitHub call goes through the watcher library and is gated on the GitHub watcher toggle. Follow cross-repo coordination: commit, tag, push in `~/git/watcher`, then re-pin here.
- Same stack as phase 1: Go + SQLite, Mantine/React, `@pierre/diffs`. No new frontend dependency.
- Read-only git operations keep the existing protections (`--no-optional-locks`, user config ignored).
- Update `docs/web-ui-architecture.md` ("Code tab and diff view", "Review comments", "Unread") and `.claude/CLAUDE.md` where packages or routes change.
- No new config keys are planned. The switch is a browser preference. If one is added, the Settings-modal sync rule applies.

## Decided by Mike

- PR comments are fetched on demand, not polled into the DB. New comments mark the view stale and surface Refresh.
- Which PR: the tracked PR whose branch matches the worktree's.
- The sidebar has Local / PR tabs, and the PR tab has a "Show in diff view" switch.
- PR comments get a different accent color, and an author line "@login on PR #1234" with "View all" and "View on GitHub".
- Resolved threads collapse.
- No "Copy for agent" for PR comments. Replying is out of scope (maybe phase 2b).
- Unread PR comments show as unread, with "Mark all read" under those threads, opening the PR's Mark all read modal.
- The activity modal gets "Go to comment in diff view".
- The button labels and the unread-blue rule are as written above.
- Counts: open threads, with unread counted per comment.
- Mike's own pending GitHub review comments are shown with a "Pending" label, as GitHub shows them.
- He agreed with the calls listed below.

## My calls (flagged for review)

- Violet (`grape`) for the PR accent.
- Replies stack in the thread's card. Resolved threads collapse inline too, not just in the sidebar.
- GitHub's own "outdated" is honored even when the lines would still match locally.
- A comment whose commit isn't available locally shows in the sidebar only.
- The "Show in diff view" switch is remembered per browser and defaults to on.
- "Go to comment" turns the switch on.
- The re-check cadence is around 60s, and the server caches threads per PR.
- Several matching PRs: prefer primary, then most recently updated.
- The poller records the GitHub comment id on events (a `comment:<id>` tag) to match them, with an author + path + time fallback.
- Old-side comments are placed against `merge-base(originalCommit, baseRefOid)`, falling back to sidebar-only.
- Unread dots clear right after "Mark all read", without waiting for Refresh.
- The Code tab re-checks on the same cadence, through the shared server cache.
