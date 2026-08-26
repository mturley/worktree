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

## Phase G (proposed) — delete a worktree from the web UI

A red trash control in the top-right of the worktree detail card, on the same
row as the worktree name, opening a confirm modal that requires typing the
worktree name. On success the modal closes and the page returns to the home
list.

**The interaction is two-phase, and that is the whole design problem.**
`worktree delete` (`cmd/delete.go`) is not a single call: it attempts
`gitutil.RemoveWorktree`, and when git refuses — leftover build output,
read-only files — it surfaces `gitutil.ErrNeedsForce` carrying git's own
output, asks whether to force, and only then calls
`gitutil.ForceRemoveWorktree` (which fixes permissions and deletes). The web
UI has to reproduce that conversation, not flatten it into one button.

So the endpoint must distinguish "failed" from "needs force", e.g.
`POST /api/worktrees/delete {path, force}` returning a body the frontend can
branch on — a `needs_force` outcome carrying git's stderr, versus a real
error. Returning 500 for the force case would make the two indistinguishable.

**Extract the cleanup, do not reimplement it.** After the directory goes,
`runDelete` also releases the port range, unregisters from the registry,
removes tracked resources, deletes the kubeconfig and prunes worktrees — all
inline in `cmd/delete.go` today. The web path needs exactly the same steps,
so they should move into a shared function that both the CLI and the handler
call. Copying them into the handler would leave two sequences to keep in
step, and the failure mode is silent: a worktree deleted from the UI that
still holds its port range.

**UI states**, mirroring the CLI:
1. Confirm modal — must type the worktree name to enable the button.
2. Spinner while deleting.
3. If `needs_force`: show git's output and the "leftover build output or
   read-only files" explanation, then Cancel or Force.
4. Spinner again on force.
5. On success: close, navigate to `/`, and invalidate `["worktrees"]`.

**Open questions to settle before building:**
- What happens to a worktree the server cannot see? The `ui` server may run
  as a different user or outside the filesystem the worktree lives on.
- Should deleting be blocked while the worktree is the one serving the UI?
- Does the branch get deleted too, or only the worktree? The CLI leaves the
  branch alone; the UI should not quietly differ.

## Deferred / needs input

- **cmux integration — researched 2026-08-25, feasible and small.** Show a
  "switch to this worktree's terminals" button, jumping cmux to the workspace
  whose directory is that worktree. NOT in scope: handler's terminal-peek /
  content-capture feature (it lives in the same handler files as the switch
  logic — take the workspace pieces, leave `Capture`/`Notify`/peek-cache).

  **Do NOT copy handler's approach.** Handler's discovery is *session*-centric:
  it maps a running Claude session to its surface via `CMUX_SURFACE_ID`, a
  `cmux identify` call, and `cmux_workspace_id` columns on its own `sessions`
  table. Worktree has the opposite problem — it holds a *path* and wants a
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
  matched by exact path.** So "no workspace for this worktree" is a *normal*
  state — the button should hide or disable, never error.

  **Ambiguity is real:** 5 workspaces share `/Users/mturley` and 2 share
  `/Users/mturley/git/worktree`. No *worktree* path is currently doubled, but
  nothing guarantees uniqueness, so matching needs a tie-break (workspace
  title, or offer the choice) rather than assuming one hit.

  **Unverified claim worth checking before building:** the agent reported that
  `cmux workspace select` does not require the caller to be inside a cmux
  surface — handler's `CMUX_SURFACE_ID` guard being self-imposed for its own
  close-the-caller UX. That matters because `worktree ui` is a long-lived
  background server, almost certainly not inside a surface. Test it before
  designing around it. Also unverified: whether `current_directory` tracks the
  workspace's *active pane*, so a multi-pane workspace may report a directory
  that is not the worktree's terminal.

  **Nothing to import.** None of this is in the shared watcher library; it is
  `os/exec` calls in handler's own module. It is small enough that
  reimplementing the two commands is the right call.
- **Per-resource inbox mechanism.** Surfacing unread/new activity per tracked
  resource. Needs design input before it can be scoped — see the reminder.
- **Task manager feature.** Scope undefined; needs brainstorming before it can
  be written down usefully — see the reminder.
