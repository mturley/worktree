# Writing to the PR from the diff view: comments, replies and reviews — design

**Status:** Design (2026-10-27). Phase 3 of `2026-10-23-review-comments-roadmap.md`. It absorbs the "phase 2b" (replying) that phase 2 deferred.
**Builds on:** phase 1, `2026-10-23-review-comments-design.md` (local draft comments), and phase 2, `2026-10-26-pr-comments-design.md` (PR threads read-only in the diff view). Both are merged to `main`.

## Intent

Mike uses the diff view to review other people's PRs, and to answer review threads on both their PRs and his own. Today he can read the threads and write local draft comments, but he has to go to GitHub to comment, reply or submit a review. Phase 3 brings GitHub's commenting choices into the diff view, so the whole review happens there.

## Goals

- **Find the PR by number, not branch name.** A worktree created from someone else's PR has a `review/pr-<N>-<slug>` branch, which never matches the PR's head branch, so phase 2 shows nothing there today. Fix that first: it is what makes reviewing others' PRs possible at all.
- **Three ways to save a new comment**, mirroring GitHub's own choices plus the local one:
  - keep it **local** (phase 1's draft);
  - add it to Mike's **pending PR review** on GitHub;
  - post it straight away as a **single PR comment**.
- **Reply to a PR thread** from the diff view, both inline and in the sidebar, with the two GitHub choices: add it to the pending review, or post it now.
- **Submit the pending PR review**, with GitHub's own choices: a Markdown review message, and Comment, Approve or Request changes. A checkbox decides whether Mike's local comments go into it too.
- **Reconcile with GitHub.** Clear a local comment only once GitHub holds it, in the pending or submitted review.
- **The PR comments tab's PR link opens the PR's resource view** on the worktree detail page, not GitHub.
- **Always name the PR.** Every control that writes to GitHub says which PR it writes to.

## Non-goals

- Resolving or unresolving threads, reactions, and editing or deleting comments already on GitHub.
- Choosing individual local comments to include. The checkbox includes all of them that can be posted, or none (Mike: no unticking).
- PR-level (issue) comments outside a review or thread.

## Anti-goals

- **Nothing posts without Mike's explicit click.** No auto-submit, no posting on blur. Writes are a deliberate exception to worktree's read-only stance on external services, and only because each one is a direct user action.
- **No surprise about where something goes.** The target PR number is on every write control and in the submit dialog's title.
- **Never lose a local comment, and never post one twice.** A local comment is cleared only once GitHub is confirmed to hold it, pending or submitted.
- **No GitHub contact while the GitHub watcher is off.** The GitHub choices are disabled, saying why. Local comments keep working.

## How it works

### Which PR (fixes phase 2 too)

A worktree's PR is a tracked PR resource that matches the worktree by **PR number**, as well as by head branch name:

- **By number:** the worktree's branch tracks `refs/pull/<N>/head`. `gitutil.SetPRTracking` sets this on PR worktrees (`branch.<name>.merge`). The tracked PR with number N matches if its owner/repo is one of the repo's remotes (`gitutil.MatchesRemote`, which checks every remote's URL, so a fork setup still matches the base repo).
- **By head branch:** Mike's own PRs, where the worktree branch is the PR's head branch, still match as before.
- When both rules apply, the number wins. The multi-match rule (primary first, then most recent) stays for whatever is left over.

This changes phase 2's PR selection (`internal/prcomments.PickPR` and its callers). Phase 2's read-only view then works in review worktrees too.

### The PR link on the PR comments tab

The tab's "PR #1234" link no longer opens GitHub. Instead it opens that PR's resource view on the worktree detail page: it leaves the diff view and selects the resource (`?resource=pr:<id>`, `useSelectedResource`) in one navigation (Mike). "View on GitHub" on each comment still goes to GitHub.

### Writing a new comment: three buttons (Mike)

The new-comment editor (phase 1's `NewCommentCard`, opened from the gutter "+") gets three save buttons:

1. **Local:** reads "Start local review" while Mike has no local comments, and "Add local comment" once he has some. It saves a phase 1 draft, exactly as today.
2. **PR review:** reads "Start a PR review" while Mike has no pending review on the PR, and "Add to PR review #1234" once he has one. It adds the comment to his pending review on GitHub, creating the review first if needed. The comment then shows as a phase 2 "Pending" PR comment.
3. **"Comment on PR #1234":** posts the comment to the PR straight away, as its own published thread.

**Every button has a tooltip explaining its use** (Mike). These apply when enabled; when a button is disabled, its tooltip gives the reason instead. My wording:
- **Local:** "Save this comment only in worktree, as part of your local review. Nothing is posted to GitHub. You can copy your local review for an agent, or include it when you submit a PR review."
- **PR review:** "Add this comment to your pending review on PR #1234. Only you can see it until you submit the review."
- **Comment on PR:** "Post this comment on PR #1234 now, as a single comment everyone can see."
- **Reply on PR:** "Post this reply on PR #1234 now. Everyone can see it."
- **Submit review:** "Submit your pending review on PR #1234, with a message and Comment, Approve or Request changes."

The two GitHub buttons:
- Name the PR (my call: "Start a PR review on #1234" / "Add to PR review #1234").
- Are **hidden** when the worktree has no PR (Mike). The editor then offers only the local button, as in phase 1.
- Are disabled, with a tooltip saying why, when:
  - the GitHub watcher is off;
  - the selected lines can't be posted. The reasons are the same as for a submit (below): uncommitted changes, a commit not pushed to the PR, or lines not part of the PR's changes.
- On success, close the editor and reload the threads. This is user-initiated, so it may shift code under phase 2's rule. Only the threads reload, not the patch.
- On failure, show GitHub's error in the editor and keep the typed text.

### Replying to a thread (Mike)

- A "Reply" link under each open PR thread, inline and in the sidebar, opens the same editor. Resolved threads can be replied to once expanded, as on GitHub.
- It offers the two GitHub choices only:
  - **"Start a PR review on #1234"** or **"Add to PR review #1234"**: the reply joins the pending review and goes out when it's submitted. Until then it shows as "Pending".
  - **"Reply on PR #1234"**: posts the reply straight away.
- Success and failure behave as above.
- Typed reply text survives remounts, like local comment drafts do (the same in-memory draft store, keyed per thread).

### Submitting the review

**The button.** "Submit review to PR #1234…" opens the submit dialog.
- It sits beside "Copy comments for agent" on the Local comments tab.
- It also sits at the top of the PR comments tab while Mike has a pending PR review (Mike).
- It's hidden when the worktree has no PR (Mike), and disabled, with a tooltip, when the GitHub watcher is off.
- It stays enabled with nothing pending: a review can be just a message, or an approval.

**The dialog** is a modal titled "Submit review to PR #1234", with the PR title beside it. The whole modal scrolls as one; it has no inner scroll areas (Mike). From the top:

1. **Review message:** a Markdown text area.
2. **Comment / Approve / Request changes**, with GitHub's wording:
   - "Submit general feedback without explicit approval."
   - "Give your approval to merge these changes."
   - "Submit feedback that must be addressed before merging."

   On Mike's own PR, Approve and Request changes are disabled with a tooltip, as GitHub does.
3. **"Include my N local comments"** (Mike), a checkbox.
   - (My call) Checked by default when any local comment can be posted. Hidden when there are no local comments.
   - Unchecked, local comments stay out of the review and stay local.
4. **"In this review (N)":** a preview of every comment that will be in the submitted review.
   - Mike's comments already pending on GitHub, labelled "Pending on GitHub" with the grape edge.
   - With the box checked, his postable local comments too, labelled "Local" with the blue edge.
   - Each shows `file:line` and its body.
5. **Pending review notice**, when Mike already has a pending review on GitHub: "Your pending review on PR #1234 (N comments) will be submitted."
6. **Comments that can't be posted**, with the box checked: a warning, "N of M local comments can't be posted and will stay here", listing each with its `file:line` and reason.
7. **Cancel**, and **"Submit review"**. The submit button names the count when there are comments.

GitHub rejects a "Comment" review with no message and no comments. Submit stays disabled until there's something to send, matching that rule.

### Showing a pending PR review (Mike)

While Mike has a pending review on the PR, three places say so:

- **The diff view's toolbar button** (the comments sidebar button) adds it to its counts. My wording: `…, pending PR review (N comments)`, for example `2 pending local review comments, 5 PR review comments (3 unread), pending PR review (2 comments)`.
- **The PR comments tab:**
  - Its label reads `PR comments (5) · pending review`.
  - At its top, a notice says "You have a pending review on PR #1234 (N comments)", with the "Submit review to PR #1234…" button.
- **The worktree details card's "Review changes" button** adds it too. My wording: `Review changes (2 pending local comments, 5 PR comments, pending PR review)`.

As with local comments, a pending review makes both buttons unread-blue (my call): it's work in progress that's easy to forget. These counts come from the polled PR comments summary, which gains `pending_review: {id, comments} | null`. Like the rest of the summary, it never moves code.

### Which comments can be posted

Every local comment, and every new comment or reply sent to GitHub, is placed against the PR's head commit on GitHub (`headRefOid`), using phase 1's anchor re-check (`reviewcomments.Resolve`) on the file at that commit.

- **Shown** or **moved** there, **and inside the PR's diff:** postable, at the resolved lines and side, against the head commit.
  - GitHub only accepts line comments on lines within the PR's diff hunks, `merge-base(baseRefOid, headRefOid)..headRefOid`, and a range must stay within one hunk. The server computes those hunks and checks each comment against them.
  - One refused comment fails a whole batch, so anything GitHub would refuse is caught here first.
- Otherwise not postable. The reason is the first that fits:
  - **"on uncommitted changes":** the comment's rev is `uncommitted`.
  - **"on a commit not pushed to the PR":** the comment's rev isn't an ancestor of the PR head.
  - **"out of date":** its lines are no longer at the PR head.
  - **"not part of the PR's changes":** its lines are there, but outside the PR's diff (an unchanged line, or a file the PR doesn't touch).
- **Old-side (removed-line) comments** are re-checked against the file at `merge-base(baseRefOid, headRefOid)`, which is GitHub's LEFT side, and posted with `side: LEFT`.
  - A line added and then removed within the PR never existed on that side, so it counts as out of date.
  - The ancestor check doesn't apply to old-side comments.
- Comments are never converted to file-level comments.
- If the PR head commit, or that merge-base, isn't in the local repo, the dialog first fetches it (the existing background fetch, nudged). If it's still missing, the GitHub options are blocked with "Fetch the PR's latest commits first".
- **The head can move while the dialog is open.** Submit sends the head oid the dialog was computed against. If the server finds the PR head has moved, it refuses with "PR #1234 has new commits — review the list again", and the dialog recomputes. What Mike saw is exactly what gets posted.

### Submitting, and reconciling local comments (Mike)

**On submit, with local comments included:**

1. **Add them to the pending review**, creating it if Mike has none.
2. **Reconcile.**
   - Read the pending review's comments back from GitHub.
   - Delete exactly the local comments it now contains (Mike: once a comment is on GitHub, even pending, the local copy goes), each only if its `version` hasn't changed since it was sent. A comment edited meanwhile stays local.
   - Matching is by the GitHub comment id that each add returns.
   - Everything else stays local:
     - comments that couldn't be posted;
     - comments GitHub didn't accept;
     - every local comment, when the box was unchecked.
3. **Submit** the pending review with the message and the chosen event.
4. The PR threads reload, and the dialog closes with a toast naming the PR: "Review submitted to PR #1234".

**Failure:**
- **Adding fails partway:** the reconcile still runs, so the comments GitHub accepted are cleared locally and the rest stay. The dialog shows the error, and a retry adds only the ones still local. Nothing is duplicated.
- **Submit fails:** the included comments are already safe in the pending review on GitHub, shown as "Pending". The dialog stays open with the error, and a retry submits the pending review.
- The same rule covers a single comment sent with "Start a PR review" / "Add to PR review" from the editor: it's never local in the first place.

### Writes to GitHub (watcher library, cross-repo)

- All GitHub writes go through new functions in `~/git/watcher/github`, released and re-pinned here, as in phase 2:
  - find Mike's pending review on a PR, with its id and comments;
  - create a pending review;
  - add a comment, or a reply, to a pending review;
  - post a single comment, or a single reply;
  - submit a pending review with a body and event;
  - read a submitted review's comments.
- Each is gated on `s.WatcherEnabled(config.ServiceGitHub)`.
- After a successful write, the server drops its cached threads for that PR (the 60s cache from phase 2), so the reload shows the result.

## Constraints

- Follow phase 2's rules: GitHub through the watcher library only, gated on the toggle, and cross-repo release and re-pin.
- Writes are POST endpoints behind the existing session auth and request-forgery guard (`middleware.go`).
- Same stack: Go + SQLite, Mantine/React, `@pierre/diffs`. No new frontend dependency.
- Update `docs/web-ui-architecture.md` and `.claude/CLAUDE.md` where routes or packages change. Mark phases 2b and 3 done in the roadmap.

## Decided by Mike

- PRs match by number, since branch names aren't reliable.
- A new comment has three save buttons: "Start local review" / "Add local comment", "Start a PR review" / "Add to PR review", and "Comment on PR".
- A reply offers the same choices without the local one.
- Every button has a tooltip explaining its use case.
- Every GitHub button (PR review, Comment on PR, Submit review) is hidden when the worktree has no PR.
- A pending PR review shows on the diff view's comments sidebar button, the PR comments tab (with a submit button there), and the details card's Review changes button.
- The submit dialog has a checkbox for whether to include local comments.
- Reconcile with GitHub, and clear only the local comments it holds. Once a comment is on GitHub, even pending, the local copy is cleared.
- Unpostable local comments get a warning that lists them with reasons, and they stay local.
- An existing pending review is submitted with a warning.
- The submit dialog previews every comment going out, local and pending-on-GitHub distinguished.
- No unticking individual comments.
- The modal scrolls as a whole, with no inner scroll containers.
- Every write control names the PR number.
- The PR comments tab's "PR #N" link opens the PR's resource view on the worktree detail page, not GitHub.

## My calls (flagged for review)

- The GitHub buttons name the PR: "Start a PR review on #1234", "Add to PR review #1234", "Comment on PR #1234", "Reply on PR #1234". Each is disabled with a reason when the lines can't be posted or the watcher is off.
- The tooltip wording above.
- "Submit review to PR #1234…" stays enabled on the Local tab with nothing pending.
- The pending-review wording: `pending PR review (N comments)` on the toolbar button, `· pending review` on the tab label, and `pending PR review` in Review changes. A pending review turns both buttons unread-blue.
- "Include my N local comments" is checked by default when any can be posted, and hidden when there are none.
- On Mike's own PR, Approve and Request changes are disabled, as on GitHub.
- Postability is decided by re-checking against the PR head commit, plus a check that it falls inside the PR's diff hunks. The reasons are uncommitted, not pushed, out of date, or "not part of the PR's changes". Comments are never converted to file-level comments.
- Old-side comments are re-checked against `merge-base(base, head)`, GitHub's LEFT side.
- PR-number matching requires the PR's owner/repo to be one of the repo's remotes.
- Reconciliation reads the pending review back and matches it by the comment ids the adds returned. A local copy is deleted only if its version is unchanged since it was sent.
- If the PR head moves while the dialog is open, the submit is refused and the dialog recomputes.
- A missing head or merge-base commit triggers a fetch. The GitHub options are blocked if it stays missing.
- A successful write reloads the threads and clears the server's thread cache for that PR.
- A "Review submitted to PR #N" toast confirms the submit.
