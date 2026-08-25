# Worktree UI feature roadmap

A running list of UI enhancements for `worktree ui` — things we want but have
deferred, with enough context to pick each one up later. Add to this as ideas
come up; move items to "Done" (or delete) when shipped.

Restarted 2026-08-25 after the 2026-08 run of UI work shipped. The previous
contents are in git history (`git log -- docs/ui-feature-roadmap.md`); the
parts that still constrain the code live in `docs/web-ui-architecture.md`.

## Phase F (proposed) — visual and information-density tweaks

A batch of look-and-feel changes to the existing surfaces. Decisions taken
2026-08-25 are recorded per item; items still marked **open** need input
before they can be implemented.

- **Darker colour scheme — dark-only, custom palette.** No theme switcher and
  no light mode to maintain: one hand-picked palette over a Mantine dark base,
  with a custom accent ramp. Note the consequence: `ui/src/styles/cards.css`
  currently carries explicit light-scheme overrides for the interactive card
  surfaces, which become dead weight once light mode is gone.

- **Colour-coded event types — source hue, kind shade.** The source
  (GitHub / Jira / Slack) picks the hue; the event kind (comment / review /
  status) picks the shade. Two-dimensional, so the palette needs a deliberate
  pass to stay legible — roughly 3 hues × 3 shades. Should live in one shared
  mapping the way `resourceStatusMeta` does for status icons, so the timeline
  dots and any badges cannot disagree.

- **Timeline as a line with dots.** Dots carry the event-type colour above,
  with a small icon inside — so this item depends on the colour mapping
  landing first.

- **Event details modal — click the row.** Clicking anywhere on an event row
  opens a modal with the untruncated body, author, timestamps, and a link out
  to the resource (reusing the existing `ResourceActions` open/copy group).
  Today `EventRow` truncates and the full body is unreachable.

- **Worktree cards: the two uses must diverge.** `WorktreeCard` is currently
  ONE component used in two places (`WorktreeList` on the home page, and the
  header of `WorktreeDetailPage` with `clickable={false}`). The wanted
  behaviour differs enough that it should become two presentations:
  - *Home page list:* worktree **name larger and not link-styled** (it is an
    `Anchor` today), plus **last-activity time** and the **current git
    branch**.
  - *Detail page header:* **no focus-resource lines at all** — they duplicate
    the resource cards directly below. Instead show the **environment
    variables `worktree info` prints** (`WORKTREE_PORTS`, `WORKTREE_TITLE`,
    `WORKTREE_PATH`, `KUBECONFIG` — from `internal/shellenv`), plus
    last-activity time, branch, and a **short git status**.
  - **New backend data required.** `latest_event_ts` is already on
    `worktreeSummary` but unused by the card. The env vars and the git status
    are not exposed by any API today: env comes from `internal/shellenv`, and
    git status needs a git call per worktree — worth deciding whether that is
    computed on demand for the one worktree being viewed (cheap) rather than
    for every row of the home list (N git invocations).

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
