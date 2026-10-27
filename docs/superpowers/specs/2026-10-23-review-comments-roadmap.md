# Review comments — multi-phase roadmap

**Status:** Roadmap (2026-10-23). Not an implementation plan. Each phase gets its own design and plan when it starts. This document records the phase order and what each phase must leave in place for the next, so the sequence survives across sessions.

**Builds on:** the Code tab and its `?diff` drill-down (`2026-10-21-git-diff-view-design.md`, merged to `main` at 10777fc).

## Goal

Line comments in the web UI's diff view. They start as a review Mike hands back to an AI agent as a prompt, and grow into a full GitHub review loop: seeing the PR's existing comments beside his own, and submitting a review to the PR.

## Phases

| Phase | What | Status |
|---|---|---|
| 1 | **Draft review comments for the agent**: comment on lines and ranges, edit/delete inline and in a sidebar, persist in the DB, survive code changes (move / out of date), copy as a prompt ("Copy comments for agent") | Done (branch review-comments, not yet merged): `2026-10-23-review-comments-design.md` |
| 2 | **PR comments shown inline, read-only**: the open PR's review comments rendered in the diff and listed in the sidebar beside the drafts, visually distinct | Done (branch pr-comments): `2026-10-26-pr-comments-design.md` |
| 3 | **Submit a review to GitHub**: a "Post review on PR" button beside "Copy comments for agent", opening a GitHub-style dropdown (top-level comment; Approve / Comment / Request changes) that posts the drafts as the review's comments | Done (includes phase 2b, replying): `2026-10-27-submit-review-design.md`. The shipped button is "Submit review to PR #N…", and it opens a dialog rather than a dropdown |

Each phase ships on its own. Phase 1 is useful without the others; phase 3 doesn't require phase 2.

## Phase 1 — Draft review comments for the agent

See its design document. What it must leave in place for later phases:

- **A `source` on every comment** (phase 1 only writes `draft`), plus an author and an editable flag in the DTO. Phase 2 adds a read-only `pr` source without remodelling.
- **One comment component** for the inline widget and the sidebar row, with per-source styling, so a read-only variant slots in.
- **Anchors in GitHub's terms**: path, side (old/new = GitHub LEFT/RIGHT), start line, end line, and the commit the comment was written against (or "uncommitted").
- **A sidebar action row** at the top that can take another button beside "Copy comments for agent".

## Phase 2 — PR comments shown inline, read-only (done)

- **Which PR:** the worktree's primary (focus) PR resource, if it has one. The detail page already tracks PR resources per worktree.
- **Fetching:** PR review comments come from GitHub. Per `.claude/CLAUDE.md`:
  - Any GitHub access goes through the **watcher library**, as cross-repo work in `~/git/watcher`, released and re-pinned here. It must check `s.WatcherEnabled(config.ServiceGitHub)` first.
  - With the GitHub watcher off, the view degrades to drafts only, and says why.
  - Decide then whether review comments are polled into the watcher DB like other PR state, or fetched on demand when the diff opens.
- **Placement:** a PR comment is anchored to the PR's commits. It maps onto the current view through the same re-check machinery as drafts (snippet / move / out of date). Where GitHub itself marks a comment outdated, keep that.
- **Look:** read-only, visibly not Mike's drafts. Show the author's name and avatar, and a link to the comment on GitHub. Threads and replies are shown, but replying is not phase 2.
- **Prompt:** decide then whether "Copy comments for agent" can include selected PR comments, which would be useful when an agent is to address a human reviewer's feedback.

## Phase 3 — Submit a review to GitHub (done)

- **"Post review on PR"** beside "Copy comments for agent" opens a dropdown like GitHub's "Finish your review": a top-level comment field, then Approve / Comment / Request changes, then Submit.
- **What gets posted:** the drafts become the review's line comments, using their stored anchors. GitHub's API wants `path`, `side`, `line` / `start_line`, and the `commit_id` the comments are against. It must be the PR's head, or a commit in the PR.
  - **Comments on uncommitted changes can't be posted.** Commits not yet pushed to the PR can't be either. Say so per comment, and offer to post the rest, rather than failing the whole review.
  - **Out-of-date drafts** need a decision then: skip them, or post them at their last good lines with a note.
- **After posting:** the posted drafts clear, or are marked posted, and phase 2's view then shows them as PR comments.
- **Writes to GitHub:**
  - Through the watcher library, gated on the GitHub watcher toggle, like every GitHub call.
  - Worktree itself never posts anything without Mike's explicit click.
  - This is a deliberate exception to "read-only" external integrations only because it is a direct user action in the UI.

## Open questions carried forward

- Phase 2: polled into the DB vs fetched on demand; how threads render.
- Phase 3: what happens to out-of-date and unpushed drafts on submit; whether to support "pending" reviews (GitHub's start-a-review-and-add-later flow) or only one-shot submit.
