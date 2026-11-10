# Two-way sync between worktree notes and the cmux workspace description

Date: 2026-11-09
Status: draft, awaiting Mike's approval

## Why

Today the notes card's "Sync to cmux workspace description" checkbox pushes
notes to cmux on every save (one-way). Mike writes notes mostly in the web UI,
which he uses both in and out of cmux, but sometimes wants to edit them from
cmux itself:

- while focused on one cmux workspace, to edit *another* workspace's
  description without switching to it;
- while in cmux with the worktree UI tab not in front of him, where opening it
  just to jot a line isn't worth it.

So cmux becomes a second, lightweight place to edit the same text. The web UI
stays the main editor.

## Goals

- Rename the checkbox to **"Sync with cmux workspace description"** and make
  the sync two-way.
- An edit made on either side shows up on the other within a few seconds while
  `worktree ui` runs, and is picked up on the first pass after it starts if it
  happened while the UI was down.
- **Never lose content.** When both sides changed, keep everything: edits to
  different lines combine; edits to the same lines are kept side by side
  between git-style conflict markers.
- No new long-held SQLite locks; no new cmux polling loop.

## Non-goals

- Rendering Markdown in cmux. The text is copied as-is; cmux shows it raw.
- A conflict notification. Seeing the markers in the text is enough (Mike's
  call).
- A conflict-resolution UI. Mike resolves conflicts by editing the text.
- Syncing when the worktree's path matches zero or several cmux workspaces
  (unchanged: sync only with exactly one match).
- Using the `cmux events` stream (see "Detecting cmux edits").

## Anti-goals

- Silently overwriting text on either side.
- A sync loop: our own push must not come back as a "cmux changed" pull.
- False conflicts that pile up markers (whitespace differences, or a re-merge
  of already-merged text).
- Wiping the notes because the cmux description went empty.

## Decided

### Direction: compare against the last synced value

cmux reports no timestamp or version for a description, so direction is never
decided by time. Instead worktree stores, per worktree, the last text both
sides agreed on (the *base*) and the cmux workspace UUID it was agreed with.
On each check, with `N` = notes, `C` = cmux description, `B` = base (all
compared after normalisation, below):

| N vs B   | C vs B   | Action                           |
|----------|----------|----------------------------------|
| same     | same     | nothing                          |
| changed  | same     | push N to cmux                   |
| same     | changed  | pull C into notes                |
| changed  | changed  | merge (below), write both        |

After any write, the result becomes the new base. Because our own push updates
the base, the next check sees `C == B` and does nothing (no loop).

**An empty description is never pulled (Mike's call).** If `C` is empty (after
normalisation) and `N` is not, worktree treats it as "cmux lost it" and pushes
`N`, whatever the base says. Clearing the description in cmux therefore just
gets it refilled; clearing the notes works only from the UI or CLI, and then
clears cmux too. (Verified 2026-11-09 that a cmux restart keeps all
descriptions, so this rule is a safety net rather than an expected path.)

**Workspace UUIDs are stable; refs are not.** Verified 2026-11-09: reordering
workspaces and restarting cmux both kept every workspace's `id` (27 of 27
across a restart). `workspace:N` refs survive reordering but are all
renumbered by a restart. So the base is keyed by `id`, never `ref`, and a
changed `id` reliably means a different workspace.

**No base** — the first sync after turning the checkbox on, or a matched
workspace whose UUID differs from the one stored with the base (a closed and
reopened workspace, or the worktree opened somewhere new) — goes straight to
the merge. An empty side simply takes the other. Without the UUID check, a new
workspace's empty description would look like "cmux changed".

### Merge: line-based three-way merge with conflict markers

Mike's call, refining his earlier "longer one, else both with a divider" rule.

- **With a base:** a standard line-based three-way merge (diff3) of `N` and
  `C` against `B`. Edits to different lines combine cleanly. A block of lines
  that both sides changed differently becomes a conflict block:

  ```
  <<<<<<< notes
  - [ ] ask Sam about the timeout
  =======
  - [ ] ask Sam about the retry timeout
  >>>>>>> cmux
  ```

- **Without a base:** use the lines the two texts share, in order (their
  longest common subsequence of lines), as the base, then merge the same way.
  This covers Mike's original cases: if one text contains the other line by
  line, the result is the longer one; changes in different places combine; two
  texts with no lines in common become one conflict block holding both. (*My
  call:* with no real base, a line one side deleted looks like the other side
  added it, so it is kept. That fits "never lose content".)
- **The same merge applies to every concurrent change**, not only cmux: a UI
  save that finds the notes changed underneath it (a pull, another tab, or
  `worktree notes set`) merges its draft with what is stored, using the text
  its draft started from as the base. The second label names the other side:
  `cmux` for the description, `other edit` for anything else. (*My call* on
  the label wording.)
- The result is written to both sides and becomes the new base, so the same
  conflict is never re-merged into nested markers. Resolving a conflict is an
  ordinary edit on either side, and it syncs like any other.

The merge is a small pure Go function (in `internal/notes` or a new
`internal/notes/merge`), tested on its own. No new dependency is required; if
one is used it must be a well-known diff library.

### Rendering conflict markers in the notes view

`NotesMarkdown` (notes card and home page cards) shows marker lines literally,
so `=======` doesn't become a heading and `>>>>>>> cmux` doesn't become a
quote. Before rendering, each line that is exactly a conflict marker
(`<<<<<<< …`, `=======`, `>>>>>>> …`), outside fenced code blocks, is wrapped
in backticks and given a blank line before and after so it shows on its own
line in monospace. The stored text, cmux and the editor keep the plain
markers.

**While markers are present, task checkboxes are not clickable** (Mike's
call). They render inert, as they already do on the home page cards, so the
click-to-toggle offsets never need mapping through the rewritten text.
Resolving the conflict in the editor makes them clickable again.

### Normalisation

Verified 2026-11-09 against a throwaway workspace: cmux **trims leading and
trailing whitespace from the whole description** (including leading spaces on
the first line and trailing blank lines) and **converts CRLF to LF**. Interior
text is kept exactly, including tabs, indentation, blank lines, Markdown,
Unicode and a line starting with `---`. An 85 KB description round-tripped
intact, so the 64 KB notes cap is safe.

So before comparing: convert CRLF to LF, strip trailing whitespace from each
line, and trim whitespace from both ends of the whole text. Texts that are
equal after this are equal, so cmux's own trimming never looks like an edit.
The text written to each side is the merge result as is (cmux trims it
again). *My call:* a pulled description therefore loses only what cmux had
already trimmed; that is acceptable.

### Detecting cmux edits: piggyback on the existing 5-second pass

Verified 2026-11-09: editing a description **in the cmux app emits no event**
on `cmux events`; only CLI/socket edits emit `workspace.action`. So polling is
required.

`StartCmuxUnreadSync` (`cmd/ui.go`, `internal/webui/cmux_unread.go`) already
runs every 5 s while `worktree ui` is up, lists workspaces once, loads the
registry and matches with `cmux.Match`. Generalise it into one cmux
reconciliation pass:

1. list workspaces + match to registered worktrees (once);
2. unread-prefix step (unchanged behaviour);
3. **description step (new):** for each worktree with sync on and exactly one
   matched workspace, run the direction table.

`cmux.Workspace` gains a `Description` field (`list --json` already returns
`description`, `null` when unset → empty string). A settled pass makes no
extra cmux calls. The pass stays gated on `s.cmuxEnabled()` (Settings →
"Enable cmux features"); a failed pass is retried on the next tick. The first
pass after startup is the catch-up for edits made while the UI was down, and
also covers cmux restarts.

### Saves from the web UI

Every notes save also runs the direction table immediately, so a UI edit
reaches cmux at once, as today. The save request gains the text the client's
draft started from (the last server text it adopted), so a change that landed
after the client loaded is merged rather than overwritten. Notes are still
committed to the DB before cmux is touched, and a cmux failure is still
reported in `cmux_sync`, never as a failed save.

### Live update to the open notes card

When the pass changes a worktree's notes, the server sends a `notes_changed`
event (`{path}`) on `/api/stream`, and the notes card refetches. Mike is fine
with the field changing while he types; the edit-mode toggle only prevents
stray edits. So the hook's rule "the local draft is the truth while it has
unsaved edits" changes: with no unsaved edits it adopts the new server text at
once; with unsaved edits it saves them (with their starting text) and adopts
the merged text the server returns. Keystrokes typed while that save is in
flight go out in the follow-up save through the same merge.

### CLI

`worktree notes set` keeps writing only the DB (and bumping the version). The
next 5 s pass sees `N` changed against the base and pushes it, so the help
text's "updated by the web UI on its next save" becomes "on its next sync
pass".

### Turning sync off and on

Unchecking stops syncing and leaves both texts as they are; it clears the
stored base. Re-checking is therefore a first sync (merge with no base), so
text that diverged while sync was off is kept on both sides.

### Concurrency and SQLite

- **No DB transaction is held across a cmux call.** cmux calls spawn a
  process (~100 ms+), so they happen only outside transactions.
- **Optimistic version check.** `worktree_notes` gains `version INTEGER`.
  Every notes write (UI save, CLI, pull) is a single
  `UPDATE … WHERE path = ? AND version = ?`; on a mismatch the writer re-reads
  and re-runs the direction table. This is the real guarantee, and it also
  covers the CLI, which is a separate process.
- **Per-worktree in-memory mutex** (like `cmuxTitleMu`, a Go `sync.Mutex`,
  never a DB lock), held around read → merge → write → cmux push, so a UI save
  and the pass for the same worktree don't race and redo each other's work.
- **A stale listing never pulls.** The pass's single listing is taken before
  the mutex. If, under the mutex, the table says *pull* or *merge*, the pass
  re-lists cmux and re-runs the table with the fresh description before
  acting. A settled pass (and a push) still makes no extra cmux call; only a
  real cmux edit costs one extra list. Without this, a UI save landing between
  the listing and the mutex would be undone by pulling the old description.
  *(My call.)*
- **The base advances only when both sides were written.** If the cmux push
  fails, the notes are saved but the base stays, so the next pass retries the
  push. *(My call.)*
- **A save request with no starting text** (an old tab after an upgrade)
  behaves as today: it overwrites the notes. Such tabs are short-lived. *(My
  call.)*

### Schema

`worktree_notes` gains (migration, bump `schemaVersion`):

- `version INTEGER NOT NULL DEFAULT 0`
- `cmux_base TEXT` — NULL = no base
- `cmux_base_workspace TEXT` — workspace UUID the base was agreed with

Notes still outlive registration (unchanged).

### UI copy and docs

Label: "Sync with cmux workspace description". Update
`docs/web-ui-architecture.md` "Worktree notes", the `worktree notes` help, and
`internal/agentskill/SKILL.md` if it mentions the one-way sync, to describe
the two-way behaviour, the empty-description rule and conflict markers.

## Left to the builder

- Exact shape of the generalised pass (renaming `StartCmuxUnreadSync`, how the
  steps share the listing).
- Field names in the save request/response for the starting text and version.
- The diff3 implementation details (hand-rolled over an LCS, or a well-known
  library), as long as the behaviour above holds.
- Test structure. Follow the repo's parallel-test and `testgit` rules; stub
  cmux through the existing seams (`cmuxList`, `cmuxSetDescription`).
