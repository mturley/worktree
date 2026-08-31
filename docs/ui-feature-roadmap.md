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

## Phase H — DONE (2026-08-31)

**Design: `docs/superpowers/specs/2026-08-27-cmux-integration-design.md`** —
that spec is the source of truth; this entry is only a pointer.

Three pieces, sequenced:

- **H1** — a cmux workspace section above the worktree title on both cards: a
  colour bar in the workspace's colour, its title, and a Switch button. Hidden
  entirely when not running inside cmux; a Create button when cmux is up but no
  workspace matches.
- **H2** — a "New worktree" button on the home page, taking the same inputs as
  `worktree add` and folding in H1's workspace fields when inside cmux. Backed
  by a shared `internal/worktreenew` runner, mirroring Phase G's
  `internal/worktreedel`.
- **H2a** — narrow `worktree add` to inputs that actually create a worktree,
  redirecting Slack URLs to `worktree resources add` and paths to
  `worktree info`. Side effect: a bare numeric argument is now always treated
  as a PR number, so a purely numeric branch name can no longer be created
  through `worktree add` (documented in the command's `--help`).

The spec also records three claims from the 2026-08-25 research note that
direct measurement disproved — `internal/cmux` already existing, `custom_color`
being hex rather than a colour name, and `cmux workspace select` working fine
outside a cmux surface. Read it there rather than rediscovering them.

## Deferred / needs input

- **Per-resource inbox mechanism.** Surfacing unread/new activity per tracked
  resource. Needs design input before it can be scoped — see the reminder.
- **Task manager feature.** Scope undefined; needs brainstorming before it can
  be written down usefully — see the reminder.
