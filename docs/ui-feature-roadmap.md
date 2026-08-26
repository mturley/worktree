# Worktree UI feature roadmap

A running list of UI enhancements for `worktree ui` — things we want but have
deferred, with enough context to pick each one up later. Add to this as ideas
come up; move items to "Done" (or delete) when shipped.

Restarted 2026-08-25 after the 2026-08 run of UI work shipped. The previous
contents are in git history (`git log -- docs/ui-feature-roadmap.md`); the
parts that still constrain the code live in `docs/web-ui-architecture.md`.

## Phase F — DONE (2026-08-26)

Visual and information-density tweaks, all shipped and merged. See
`git log --grep "feat(ui)"` for the commits; the parts that still constrain
the code are documented where they live:

- Dark-only theme with a custom palette, page pinned to black in
  `ui/src/styles/theme.css` (NOT by overriding `dark[7]` — the ramp has to
  stay monotonic; the comment there explains why).
- Per-event-type colours and icons in `ui/src/lib/eventMeta.tsx`, the single
  mapping every event surface reads.
- Timeline as a rail of dots, event details modal, resource chips and
  clickable worktree badges on both timelines.
- `GET /api/worktree-info` (env vars + short git status) and the worktree card
  split into list and detail presentations.
- Split scroll containers on the detail page, source filter toggles, and the
  follow/unfollow wording.

## Phase G — DONE (2026-08-26)

Delete a worktree from the web UI via a trash control on the worktree detail
card's header. The interaction is a typed-name confirmation modal opening to a
pipeline stepper showing removal progress. Shipped in Task 1-6 of the 2026-08-26
build.

**Decisions that constrain the code:**

- `needs_force` is returned as HTTP 200 with a step-key marker, never an error
  status — "git wants confirmation" and "the delete broke" must stay
  distinguishable. Every request is idempotent; already-done steps report as
  `skipped`.
- `remove_directory` failure aborts the run and leaves the registry row intact
  (unregistering a worktree still on disk would strand it, invisible but still
  holding ports). Other failing steps (cleanup) do not abort.
- Branch deletion is opt-in on both surfaces: the UI checkbox starts unchecked,
  and the CLI prompts defaulting to no. Deleting a branch destroys work the
  worktree removal does not, so it should never be forced without explicit
  confirmation.

## Deferred / needs input

- **cmux integration — researched 2026-08-25, feasible and small.** Show a
  "switch to this worktree's terminals" button, jumping cmux to the workspace
  whose directory is that worktree. NOT in scope: handler's terminal-peek /
  content-capture feature (it lives in the same handler files as the switch
  logic — take the workspace pieces, leave `Capture`/`Notify`/peek-cache).

  **Do NOT copy handler's approach.** Handler's discovery is _session_-centric:
  it maps a running Claude session to its surface via `CMUX_SURFACE_ID`, a
  `cmux identify` call, and `cmux_workspace_id` columns on its own `sessions`
  table. Worktree has the opposite problem — it holds a _path_ and wants a
  workspace — and needs none of that machinery, DB rows, or env plumbing.

  **The whole mechanism, verified directly on this machine:**
  - `cmux workspace list --json` returns per workspace a `ref`
    (`workspace:N`), a UUID `id`, and **`current_directory`** — so a workspace
    is locatable by path with one command and no registration.
  - Switch with `cmux workspace select --workspace <ref>`, optionally followed
    by `osascript -e 'tell application "cmux" to activate'` to raise the app
    (handler does this after every switch).
  - Availability gate: `exec.LookPath("cmux")` proves only that the binary
    exists; `cmux ping` → `PONG` proves the app/socket is actually up. Prefer
    the latter, and fail soft on any exec error.

  **Measured against our own registry (10 worktrees, 18 workspaces): 7/10
  matched by exact path.** So "no workspace for this worktree" is a _normal_
  state — the button should hide or disable, never error.

  **Ambiguity is real:** 5 workspaces share `/Users/mturley` and 2 share
  `/Users/mturley/git/worktree`. No _worktree_ path is currently doubled, but
  nothing guarantees uniqueness, so matching needs a tie-break (workspace
  title, or offer the choice) rather than assuming one hit.

  **Unverified claim worth checking before building:** the agent reported that
  `cmux workspace select` does not require the caller to be inside a cmux
  surface — handler's `CMUX_SURFACE_ID` guard being self-imposed for its own
  close-the-caller UX. That matters because `worktree ui` is a long-lived
  background server, almost certainly not inside a surface. Test it before
  designing around it. Also unverified: whether `current_directory` tracks the
  workspace's _active pane_, so a multi-pane workspace may report a directory
  that is not the worktree's terminal.

  **Nothing to import.** None of this is in the shared watcher library; it is
  `os/exec` calls in handler's own module. It is small enough that
  reimplementing the two commands is the right call.

- **Per-resource inbox mechanism.** Surfacing unread/new activity per tracked
  resource. Needs design input before it can be scoped — see the reminder.
- **Task manager feature.** Scope undefined; needs brainstorming before it can
  be written down usefully — see the reminder.
