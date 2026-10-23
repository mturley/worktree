# Review comments in the diff view — design

Status: draft for review · 2026-10-23 · builds on `2026-10-21-git-diff-view-design.md` (the Code tab and its `?diff` drill-down, merged to `main` at 10777fc). This is phase 1 of `2026-10-23-review-comments-roadmap.md`.

## Intent

Mike reviews changes an **AI agent** made in a worktree using the web UI's diff view. He wants to leave line comments while reading, the way a reviewer would on GitHub. He then hands the whole batch back as one lightweight prompt that he pastes into the agent's session, usually with words of his own around it.

Human pull requests are out of scope: he reviews those on GitHub itself. The tool is for the agent loop.

What success looks like: he reads a diff once, top to bottom, comments as he goes, and copies a prompt in which every comment points unambiguously at the code it means. That holds even if the agent kept working while he was reading.

## Goals (phase 1)

1. **Comment on a line or a range of lines** in the diff view, on either side (added/context lines on the new side, removed lines on the old side). A range stays on one side.
2. **Edit and delete comments inline** in the diff, where they appear as widgets under the last line of their range.
3. **"Review comments (N)" button** at the right end of the diff view's breadcrumb bar. It is shown only while there is at least one comment, and toggles a **right-hand sidebar**.
4. **The sidebar lists every comment** in diff order (by file, then line). Each item is editable and deletable in place, and has a **jump** button that scrolls the diff to it.
5. **"Send comments to agent"**, at the top of the sidebar, opens a modal with a single **read-only textarea** holding the prompt (format below) and a **copy to clipboard** button.
6. **"Clear comments"**, at the top of the sidebar, asks for confirmation in a modal, then deletes every comment so a fresh review can start.
7. **Comments persist in the database.** They survive reloads and are shared by every client (laptop, phone), scoped to the worktree.
8. **Comments survive code changes** (see "When the code changes"): they move when their code just shifted, and are marked **out of date** when it changed. Positions handed to the agent are always accurate or explicitly flagged.
9. **Safe under concurrent clients**: two browsers open on the same worktree must never corrupt or silently lose comments (see "Concurrency").

## Non-goals (phase 1)

- Showing comments from the PR on GitHub.
- Posting a review to the PR.
- Threads, replies, resolving, reactions, or several reviewers. There is one author: Mike.
- Several concurrent reviews per worktree. There is one ongoing review, and Clear starts the next.
- Live push between clients. Other clients catch up on their next poll (below).

## Anti-goals

- **A comment that silently points at the wrong code.** This is the failure that matters. A wrong position in the prompt sends the agent to change the wrong thing. When in doubt, a comment is marked out of date, never quietly re-attached somewhere plausible.
- **Lost typing.** An edit that loses a save conflict must keep the user's text so they can reapply it.
- **A heavy prompt.** Mike adds his own framing. The output is a terse list, not instructions for the agent.

## Future phases to leave room for (do not build)

Phase 2 (read-only PR comments) and phase 3 (submit a review to GitHub) are tracked in `2026-10-23-review-comments-roadmap.md`. Phase 1 must leave room for them:

- **PR comments shown inline, read-only**, visually distinct from Mike's drafts. So every comment has a `source` (phase 1 only `draft`), an author, and an editable flag in its DTO. The inline widget and the sidebar row are one component with per-source styling, so a read-only variant slots in.
- **"Post review on PR"**: a button beside "Send comments to agent" opening a GitHub-style dropdown (top-level comment; Approve / Comment / Request changes). So:
  - The sidebar's top area is an action row that can take another button.
  - Each comment's anchor is expressed in GitHub's review-comment terms: path, side (old/new = GitHub LEFT/RIGHT), start line, end line, and the commit it was written against.
  - Comments made against uncommitted changes record that (no commit). A later phase must say they can't be posted rather than fail.

## How it works

### Creating a comment

- The diff uses `@pierre/diffs`' **gutter utility**: `enableGutterUtility` with `onGutterUtilityClick(range: SelectedLineRange)`, which gives a "+" on hover and supports dragging across lines, like GitHub. Clicking it opens a new-comment editor widget under the range's last line. pierre's line selection (`enableLineSelection`, `onLineSelected`) may be used alongside it if that suits. The builder chooses, as long as single lines and ranges both work.
- Inline widgets render through pierre's `lineAnnotations` / `renderAnnotation` (annotation `side` is `deletions` | `additions`, positioned by `lineNumber`).
- A range spanning both sides (`side` ≠ `endSide`) is not allowed. Clamp it to the starting side or refuse it; that's the builder's call.
- The comment is saved when the user submits it (button, or Cmd/Ctrl+Enter). An empty comment is not saved. Esc cancels a new comment.
- Esc inside a comment editor belongs to the editor, the way the notes editor keeps its own Esc (see `escOwnedElsewhere` in `SearchBar.tsx`). It must not trigger the page's Esc ladder.

### Editing and deleting

- Inline and in the sidebar, the same comment is edited with the same fields. Saving uses the version check in "Concurrency".
- Delete asks no confirmation: it's one comment, and it's easy to retype. Clear does ask.

### The sidebar

- On the right of the diff view, beside the diff body (the file tree stays on the left). It opens from the breadcrumb button and closes from the same button or a close control. Whether it's open is remembered per browser tab (sessionStorage, like "Follow cmux").
- It lists every comment in diff order. Each row shows file:lines, the side if old, an out-of-date badge if relevant, a "not in this view" note if relevant (below), and the text, editable in place. It has edit, delete and jump controls.
- **Jump** scrolls the diff to the comment's range and expands that file if it's collapsed. It reuses `scrollToFile`'s approach plus a line target. If the comment isn't in the current view, jump first switches the view (below).
- Narrow (phone) width: the sidebar becomes a Drawer, like the file tree already does there.

### Comments and the selected view

The diff view lets the user pick **Compare with** (merge base / tracking branch) and **Changes from** (a commit range, optionally including uncommitted changes). **A comment belongs to the code, not to the view it was written in.**

- A comment is shown inline wherever its lines appear on the matching side of the current diff.
- The sidebar always lists all of them, and marks those whose lines aren't in the current diff "not in this view".
- Jumping to one of those switches to a view that contains it. The simplest correct choice is "All changes" against the comment's own base. Exact rule: the builder's call.

### When the code changes

While comments exist and the code moves, the diff view's existing behaviour still holds: the view stays put and offers **Refresh** (fingerprint polling). Comments are re-checked when the view refreshes, against the code the new view shows.

**Anchor stored per comment (immutable once written):**
- `path`, `side` (old | new), `start_line`, `end_line` (1-based, inclusive; start = end for one line)
- `rev`: the commit the anchored side's content came from, or `uncommitted` (the working-tree snapshot)
- `base_ref` and the view's range, for context and for "not in this view"
- `snippet`: the exact text of lines start..end
- `context_before` / `context_after`: up to 3 lines each side, for matching only (not sent in the prompt)

**Re-check (server side; see Concurrency):** given the anchor and some content of the file (which content is below):
1. **Still matches**: lines start..end equal the snippet **and** the stored context lines around them also match → shown in place. (Decided by Mike: comparing the snippet alone at the old line numbers would leave a comment on `}` sitting on a different brace after the code above shifts.)
2. **Moved**: else, if snippet plus context occurs exactly once in the file → shown at the new lines, quietly. Failing that, the snippet alone occurring exactly once also counts as moved, **unless the snippet is low-information**: every line has no letters or digits (`}`, `)`, blank). Such a snippet only ever moves on a snippet-plus-context match (decided by Mike).
3. **Out of date**: else (no match, or more than one) → marked out of date. It stays in the sidebar with its original snippet. It is not shown inline (there is no trustworthy line). The user can delete it, or leave it, and it goes to the prompt flagged.

**Two positions per comment (decided by Mike).** The same anchor is resolved twice, for two purposes:
- **View position** places the comment inline and orders the sidebar. It resolves against the current view's anchored side: for new-side comments, the view's new side, which is the frozen view, not live HEAD, until Refresh. It gives inline placement, "not in this view", and the sidebar's out-of-date badge for the view.
- **Prompt position** is what the agent is told. **New-side comments always resolve against the current working tree** (the files the agent will edit), whatever view is showing. A comment whose code isn't found there goes into the prompt as out of date, with its original lines and snippet. This needs a resolution independent of the view: the working-tree snapshot, cached by working fingerprint.

**Removed-line (old-side) comments (decided by Mike)** are **pinned to their anchored `rev`**. The removed code is a fixed version, so the comment never goes out of date by itself.
- **View position:** shown inline wherever the current view's old side contains that code (the same matching, against the view's old side). Otherwise it's "not in this view".
- **In the prompt:** `path (removed lines, previously 360–362)`, then the snippet. The snippet tells the agent which code is meant. No working-tree resolution is needed.

**Lines outside the changed hunks (decided by Mike).** The diff renders only hunks plus whatever the user expanded, and pierre annotations attach to rendered lines.
- A comment whose view position lands on a collapsed unchanged line **inside a changed file** auto-expands that region (through the existing `/file` expansion path), so it shows inline. That includes context the user had expanded before a refresh collapsed it again.
- A comment in a file **with no changes in the current view** is shown only in the sidebar, marked "outside the changes". Its jump button is disabled, with that explanation in its tooltip.

Refresh reports what happened in one line, e.g. "5 still match, 2 moved, 1 out of date". Placement and styling are the builder's call.

Out-of-date comments can't be re-attached to a new line in phase 1. Deleting and re-commenting does the same job. *Builder's call to add a "re-attach" action if it falls out cheaply.*

### The prompt ("Send comments to agent")

Plain text with no preamble. Mike wraps it in his own words. Diff order. Example:

````
Review comments on ~/.worktrees/worktree/foo (branch foo, changes vs origin/main):

1. internal/gitfetch/gitfetch.go:241-243
   ```go
   var credentialsInURL = regexp.MustCompile(`(\w+://)[^/@\s]+@`)
   ```
   This leaks part of passwords containing @ — match to the last @ instead.

2. ui/src/components/gitdiff/DiffView.tsx:369 (removed line)
   ```tsx
   <Text size="sm">Changes</Text>
   ```
   Why was this dropped?

3. internal/webui/server.go:88 (out of date — this code has since changed; it was:)
   ```go
   mux.HandleFunc("/api/old", s.handleOld)
   ```
   Rename this route.
````

- Header: the worktree directory (with `~`, as `/api/worktree-git`'s `directory` gives it), branch, and the comparison as the view names it.
- Per comment: a number, then `path:start[-end]` with its **prompt position**, i.e. its lines in the current working tree (see "Two positions per comment").
  - Removed-line comments read `path (removed lines, previously start–end)`.
  - Out-of-date comments get the out-of-date note with their **original** lines.
  - Then the snippet in a fence with a language from the extension (none if unknown), then the comment text indented.
  - This covers every comment, including those "not in this view" or "outside the changes": the prompt doesn't depend on the view.
- No context lines in the prompt.
- The modal's textarea is read-only, with a copy button (Mantine `CopyButton`, as elsewhere). Copying doesn't clear anything.

### Persistence

- A new table in worktree's own SQLite DB (`internal/db/migrate.go`), keyed by the canonical worktree path. Use `wdb.Subscriber`-style canonicalisation, per `.claude/CLAUDE.md`. Rows hold the immutable anchor (above), `body`, `source` ('draft'), `created_at`, `updated_at`, `version`.
- **Deleted with the worktree** (`worktree delete` / cleanup) **and when it is unregistered**, unlike notes. A review of code that is gone isn't worth keeping.
- A small `internal/reviewcomments` package (like `internal/notes`) owns the CRUD. The webui adds routes beside `/api/worktree-diff/*`. Exact shapes are the builder's call. They must cover list (with each comment's resolved status and current lines for a given view), create, update (with version), delete, and clear.
- Re-checking needs file contents at a rev and at the working-tree snapshot. `internal/gitutil` already has `ShowFile` and `SnapshotWorkingTree`.
- The list endpoint returns, per comment, both positions: the view position for the view the request names (the view's revs, as `/patch` hands them out), and the prompt position.

### Concurrency

Two clients on one worktree, both refreshing, editing and deleting, must stay consistent:

- **Positions are derived, never written by clients.** The stored anchor never changes. The current position is computed on the server from (anchor, current content) and is deterministic: two clients computing at once get the same answer and write nothing. Cache view positions per worktree per view (its revs) and prompt positions per worktree per working fingerprint. Compute both under a per-worktree lock so simultaneous refreshes don't duplicate work.
- **Edits use optimistic concurrency.** Every update names the `version` it started from. A stale version is refused (409) with the current comment. The client shows the newer text with a "changed elsewhere" note, and **keeps the user's typed text** to reapply.
- **Deletes and Clear win.** Updating a deleted or cleared comment returns 404. The client drops it from view (keeping any unsaved typing visible long enough to copy is the builder's call). Creating after a Clear just starts the new review.
- **Other clients catch up by polling** the comment list on the diff view's existing cadence (the 5s `useWorktreeGit` poll), plus an immediate refetch after the client's own writes. No server push.

### Esc and hints

The diff view already has an Esc ladder ("a query in the search bar first, then leave the drill-down…") and a one-hint-at-a-time rule. Phase 1 rules:

- Esc in a comment editor is the editor's (cancel a new comment, or leave edit mode).
- When the sidebar is open, Esc closes it before leaving the drill-down. Its hint sits on the sidebar's close control while that's the next step, and no other Esc hint shows.

## Constraints

- Everything stays in this repo's existing stack: Go backend with SQLite (worktree's own DB), Mantine/React UI, `@pierre/diffs`. No new frontend dependency without a reason.
- Read-only git operations use the same protections as the diff endpoints (`--no-optional-locks`, ignoring user config).
- Update `docs/web-ui-architecture.md` ("Code tab and diff view") and `.claude/CLAUDE.md`'s package list.
- This adds no new config keys. If one is added, the Settings-modal sync rule in `.claude/CLAUDE.md` applies.

## Decided by Mike

All four drift ideas together: the snippet travels in the prompt; the view is frozen until refresh; quiet moves on a unique exact match; flagged out-of-date with the original code. Ranges in phase 1. Database-backed, shared across clients. Comments belong to the code, not the view. Server-side re-anchoring with protection against concurrent clients. A lightweight prompt. Future PR phases kept in mind but not built (see the roadmap).

From the builder check:
- Prompt line numbers point at the working tree.
- Removed-line comments are pinned to their version and say "previously N–M".
- "Still matches" needs the context to match, and low-information lines never move alone.
- Collapsed lines in changed files auto-expand; unchanged files show in the sidebar only.

## My calls (flagged for review)

- Comments are deleted with their worktree, and when it's unregistered.
- View positions resolve against the frozen view until Refresh, not live HEAD.
- Delete has no confirmation. Clear does.
- Out-of-date comments aren't shown inline and can't be re-attached in phase 1.
- The context window for matching is 3 lines each side, and matching has two tiers.
- Other clients learn of changes by polling (5s), not push.
- Whether the sidebar is open is remembered per browser tab.
- When the sidebar is open, Esc closes it before leaving the drill-down.
