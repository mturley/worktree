# cmux two-way sync — design

## Intent

Mike keeps the worktree UI on a second monitor beside cmux. "Follow cmux"
already moves the UI when cmux switches workspace. Two-way sync adds the
other direction: opening a worktree's page in the UI switches cmux to that
worktree's workspace, so the two stay in lockstep whichever side he drives.

## Goals

- A "Two-way sync" toggle inside the "Following cmux" banner
  (`FollowingCmuxBanner`), shown only while following.
- With it on, the banner's text says both directions are synced.
- With it on, the tab navigating to a worktree page (by any route: link,
  logo, home page list, browser back) switches cmux to that worktree's
  workspace and leaves following on.
- With it on, leaving for a non-worktree page (the home page, to pick
  another worktree) keeps following on and leaves cmux alone.

## Non-goals

- No server changes.
- No way to turn two-way sync on without following.

## Anti-goals

- The tab must never bounce between worktrees: a late cmux focus event for
  the worktree just left must not drag the tab back.
- With two-way sync off, behaviour is exactly today's: leaving a worktree
  page by any route the follower didn't cause turns following off.

## Approaches

- **A (chosen): client-only.** `CmuxFollower`, on a location change it did
  not cause, looks the new worktree up in the shared `["cmux"]` query
  (`useCmux`) and calls the existing `POST /api/cmux/select`. Reuses
  everything; the only gap is a workspace created seconds ago and not yet in
  the cached query, which costs one missed switch, never a wrong one.
- B: a new `POST /api/cmux/select-path` resolving the workspace server-side
  with a fresh `cmux.Match`. Always current, but a new route, tests and docs
  for a rare gap. Rejected.

## Decisions

- **Storage:** per tab, sessionStorage, like `useFollowCmux` (own key,
  `worktree.cmuxTwoWaySync`). Independent of following: turning following
  off and on keeps it.
- **Which workspace:** if any of the worktree's matched workspaces is
  already `selected`, do nothing; else select the first.
- **No workspace for the worktree:** do nothing, keep following.
- **Bounce guard:** after asking cmux to select a workspace for path P, the
  follower ignores focus events for any other path until one for P arrives,
  or ~2 s pass, whichever is first. A failed select clears the guard.
- **Banner text, two-way on:** "Syncing with cmux: switching workspaces
  there opens their worktrees here, and opening a worktree here switches
  cmux to it."
- **Unsaved-changes prompt:** unchanged. "Stay and stop following" still
  turns following off.

## Left to the builder

- Where the toggle sits in the banner (beside "Stop following" is the
  obvious place) and narrow-width wrapping.
- Tests: follower selects on navigation with two-way on, not with it off;
  leaving to `/` keeps following; already-selected workspace is not
  re-selected; bounce guard ignores a stale event; banner text and toggle.
- Update `docs/web-ui-architecture.md` "Follow cmux".
