# Following cmux: "no worktree" banner state — design

## Intent

With the UI on a second monitor following cmux, switching cmux to a
workspace that has no worktree leaves the UI where it was, silently. The
following banner should say so at a glance, so it reads as intended rather
than broken.

## Behaviour (mockups approved: option B, shortened wording)

- While following, cmux's last focus message names a workspace with no
  worktree: the banner turns yellow (Mantine light) with `IconAlertTriangle`.
- Text keeps the usual prefix ("Following cmux:" / "Synced with cmux:" with
  two-way sync), then the workspace (cmux colour bar + title):
  - worktree page: "▍{workspace} has no worktree, staying on ⎇ {worktree}."
  - home page: "▍{workspace} has no worktree, staying here."
- Back to blue on the next focus message with a worktree, when following is
  turned off, or when cmux is unavailable.
- A page loaded with following on asks `GET /api/cmux/focused` once, so a
  reload while on such a workspace shows yellow at once. Turning following
  on already fetches it.
- Controls and phone wrapping unchanged; the follower's navigation and
  two-way sync unchanged.

## Approach

The client cannot name the workspace: `/api/cmux` lists only workspaces
matching a worktree. So the focus message (live stream and
`/api/cmux/focused`) gains `title` (`DisplayTitle()`, which falls back to the
ref) and `color` (`custom_color`, "" when unset). The cmux focus bus keeps
the last message; the banner reads it.

## Decisions (mine)

- Untitled workspace: shows its ref (DisplayTitle's fallback).
- No new route; no change to how focus is deduped.
