# The worktree's PR sets its merge base, and the UI shows which PR is checked out

Date: 2026-11-10

## Why

The Code tab and the diff view's "Merge base" mode compare a worktree against
`gitutil.MainUpstream`, which is `main@{upstream}`, whatever the repo's local
`main` happens to track. In Mike's odh-dashboard clone, `main` tracked
`origin/main` (his fork) rather than `upstream/main`. Review worktrees
therefore showed a merge base and a diff that didn't match the PR on GitHub.
(The config is fixed now, but the logic shouldn't depend on it.)

When a worktree's branch is a PR's branch, the PR already says what it merges
into: its base repo and base branch. The diff Mike reviews locally should be
the PR's diff. So when a worktree has a PR, its merge base comes from the PR.

Alongside that, the UI should make it obvious **which** of a worktree's
followed PRs is the one checked out locally. A worktree may follow several
PRs, some only for activity context.

## Goals

1. **One rule for "the worktree's PR"**, used everywhere: a followed PR is the
   worktree's PR when it is what the current branch **tracks**.
2. **Merge base from the PR.** When the worktree has a PR, "Merge base" means
   `<remote whose URL is the PR's base repo>/<PR's base branch>`. Otherwise,
   it is `main@{upstream}` as today.
3. **Show it in the UI:**
   - a "checked out here" marker on that PR's resource card;
   - a "PR" row in the Code tab summary (and so in the diff view sidebar);
   - clicking that row selects the PR on the worktree page.
4. **Retire PR-number tracking** (`worktree-pr` branch config), which predates
   naming review branches after the PR's head branch.

## Non-goals

- No change when the branch has no PR (never pushed, or pushed with no PR
  open): the merge base stays `main@{upstream}` and no PR row appears.
- No new setting or override for which ref to compare against.
- No changes to how review worktrees are created, beyond no longer writing
  `worktree-pr` (branch naming and `SetPRTracking`'s remote and refs/pull
  handling stay as they are).

## Anti-goals

- **Never pick an unrelated PR.** A PR followed only for context must never
  become the worktree's PR, set its merge base, or get the marker, even when it
  is the only PR the worktree follows.
- **Never fail loudly over a base we can't find.** If no remote points at the
  PR's base repo, or the base ref isn't present locally, quietly fall back to
  `main@{upstream}`. No error and no warning.
- **Never contact GitHub just to work this out.** The Code tab polls
  `/api/worktree-git` often. The match must come from data the poller already
  cached, plus local git.

## The matching rule

A followed PR (`owner/repo#N`) is the worktree's PR when the current branch's
configured upstream (`branch.<b>.remote` + `branch.<b>.merge`) is one of:

| Case | Branch tracks | Matches when |
|---|---|---|
| Own PR, or another person's PR from a fork | `<remote>/refs/heads/<h>` | `<remote>`'s URL is the PR's **head repo** and `<h>` is the PR's **head branch** |
| Head repo deleted (fork gone) | `<remote>/refs/pull/<N>/head` | `<remote>`'s URL is the PR's **base repo** (from its resource ID) and `<N>` is the PR's number |

- Detached HEAD, or a branch with no upstream: no PR.
- A merged or closed PR still matches (my call): the branch is still checked
  out, so the marker and PR row stay true. Its merge base follows the same
  rule, falling back to `main@{upstream}` if its base branch has been deleted
  and pruned.
- If more than one followed PR matches (unlikely), the existing tie-break
  applies: primary (focus) beats related, then newest `updated_at`.
- Matching compares remote URLs to `owner/repo` case-insensitively, as
  `gitutil.MatchesRemote` already does. *(Builder may factor out a helper that
  answers "which remote, if any, is owner/repo".)*

This replaces both inputs to `prcomments.PickPR`: "current branch name equals
the head ref name" and "`TrackedPRNumber` (`worktree-pr` or a refs/pull merge
ref) plus `RepoIsRemote`". Comparing branch names was fragile: a PR from a
fork's `main` gets a local branch like `sridarna/main`, and the user may pick
any branch name at creation.

## Where the PR facts come from (my call)

Matching needs, per followed PR: head repo owner and name, head branch, and
base branch. (The base repo is the resource ID itself.)

**Decision: the watcher library's poller caches them in the PR's
`watcher_resource_state` JSON**, as `head_repo_owner`, `head_repo_name`,
`head_ref_name` and `base_ref_name`, alongside `title` and `state`. The poller
already polls every followed PR. Reading cached state is a DB query, so:

- `/api/worktree-git` can match on every poll without contacting GitHub.
- It works with the GitHub watcher off, using whatever was cached while it
  was on, and after a restart.

This is cross-repo work (see the repo's CLAUDE.md, "Watcher library"): add the
fields to the poller's GraphQL query, `PRData` and `buildPRStateJSON` in
`~/git/watcher`, with tests, then release and re-pin here.

**Every consumer of the rule reads this cached state, PR comments included
(my call).** Today `loadPRComments` and `offlinePR` get head branches from
on-demand `FetchPRSummaries`. They switch to the cached state for **choosing**
the PR, so the Code tab, the diff view, the comments panel and PR writes can
never name different PRs. `FetchPRSummaries` stays for what it is otherwise
used for (title, URL, body, creating worktrees from a PR). It gains no new
field.

Until the poller has cached the new fields for a PR (state written by an older
version), that PR can't match, so the worktree behaves as if it has no PR.
That includes the PR comments panel, which shows "no PR" until then. This is
an accepted brief regression after upgrading: the next poll, minutes later,
fixes it. With the GitHub watcher off, nothing refreshes the state, so it
lasts until the watcher is turned back on; the panel is already in its
offline state then. No migration or backfill.

## Merge base

`MainUpstream`'s callers (`worktree_git_api.go`, and `baseRefFor` in
`worktree_diff_api.go` for `base=merge-base`) instead ask for the worktree's
**base ref**:

1. If the worktree has a PR (the rule above), find the remote whose URL is the
   PR's base repo. If one exists and `<remote>/<base_ref_name>` resolves to a
   commit, use it.
2. Otherwise, `gitutil.MainUpstream` exactly as today.

Notes:

- A PR targeting a non-`main` branch (for example, a feature branch) compares
  against that branch. The goal is to match the PR's diff.
- Background fetch already fetches the remotes behind the refs it is handed
  (`gitfetch.RemotesFor(path, refs...)`), so passing the PR-derived ref keeps
  `upstream` fresh. If the base branch has never been fetched, step 1's
  resolve check fails and step 2 applies until a fetch brings the ref in.
  *(Builder: confirm that `RemotesFor` and the fetch refspec cover a base
  branch outside the remote's default refspec. Otherwise fetching
  `<base_ref_name>` explicitly is in scope.)*
- Diff view state already records `base_ref`; it holds whatever ref was used.
- The UI's "Compare with:" select already prints the ref
  (`Merge base (upstream/main)`), so it needs no change.

The base-ref logic belongs in a method on `webui.Server` that the handler
calls, as the repo requires for read logic. Any CLI read command that reports
the merge base calls the same method.

## API

`/api/worktree-git` (`worktreeGitDTO`) gains:

- `pr`: the matched PR's resource ID (for example `opendatahub-io/odh-dashboard#10598`),
  absent when there is none;
- `main_upstream` keeps its name and now carries the base ref actually used
  (PR-derived or fallback). *(Builder may add a `merge_base_from_pr` boolean if
  the UI or tests need to tell them apart; the spec doesn't require it.)*

`ui/src/api/types.ts` follows.

## UI

### Checked-out marker on the PR card

- On the worktree page's resource list, the card of the PR equal to
  `worktreeGit.pr` shows a **laptop icon** (Tabler `IconDeviceLaptop`) right
  after the `PR #N` key on its first line (`ResourceTypeLine`'s `trailing`).
- Tooltip: **"Checked out in this worktree"**.
- The same marker appears on that PR's card in the detail pane when it is
  selected (`ResourceDetailPane` renders `ResourceCard`, which renders
  `ResourceTypeLine`).
- Other PRs, and any card outside the worktree page (home page worktree cards,
  activity feed chips), get no marker.
- Color: something that reads as "local" and doesn't clash with PR status
  colors. Teal was used in the mockup. *(Builder's call.)*

### PR row in the Git summary

- `GitSummary`'s left column gets a **"PR"** row directly under **Branch**,
  shown only when `git.pr` is set.
- Content: the PR's status icon (`ResourceStatusIcon`), `#N` as a link, then
  the title, truncated to one line with an ellipsis. Title and status come
  from the worktree's resources (the same `ResourceDTO` the card uses).
  Without one (not loaded yet), show `#N` alone.
- Hovering the link shows the PR's card via the existing `ResourceHoverCard`
  (`ui/src/components/tasks/LinkHoverCards.tsx`), as in the task modal's
  "Linked to" section.
- The diff view sidebar renders `GitSummary` with `oneColumn`, so it gets the
  row automatically.

### Clicking the PR row

Always: select the PR on the worktree page (the `?resource=<key>` selection
`serializeResourceKey` already builds).

- **From the Code tab:** select the PR and, if the "Files changed" list in the
  Code tab is expanded, collapse it.
- **From the diff view:** leave the diff view, return to the worktree page,
  and select the PR.

The implementation (callbacks through `GitSummary`, or navigation alone) is
left to the builder.

## Retiring `worktree-pr`

- `gitutil.SetPRTracking` stops writing `branch.<b>.worktree-pr`.
- `gitutil.TrackedPRNumber`, `prcomments.Candidate.RepoIsRemote`/`Number`
  (to the extent only the old rule uses them) and the tracked-number branch of
  `PickPR` go. Their callers (`offlinePR`, `loadPRComments`,
  `prWorktreesForPR` for "go to comment in diff") use the new rule.
- Existing branches keep the key in their config, which is harmless. No
  cleanup step. Per the repo's convention, nothing asserts or documents that
  it is gone.

## Consumers of the rule

All of these must agree on which PR a worktree has:

- `/api/worktree-git` (merge base and `pr`);
- the diff view's `base=merge-base`;
- PR comments and threads (`loadPRComments`, `offlinePR`), and therefore PR
  writes (`prForWrite`);
- "Go to comment in diff view" (`prWorktreesForPR`).

## Testing

- Library: poller state JSON includes the four new fields, including empty
  head repo fields for a deleted fork.
- Matching, as a pure function over (branch upstream remote and merge ref,
  remote → URL map, candidate PRs with cached fields): own PR; fork PR with a
  renamed local branch; fork PR from `main` (`sridarna/main`); deleted fork
  via refs/pull; an unrelated followed PR alongside a matching one; no
  upstream; detached HEAD; uncached state fields.
- Base ref: PR with a matching base remote; no matching remote → fallback;
  base ref not fetched → fallback; PR targeting a non-main branch.
- Handlers: `/api/worktree-git` returns `pr` and the PR-derived
  `main_upstream`; `/api/worktree-diff/*` with `base=merge-base` compares
  against it. Use `testgit` fixtures and follow the repo's
  parallel-test rules.
- UI: marker only on the matched card, with the tooltip; PR row present or
  absent; hover card; click behavior from the Code tab (collapses Files
  changed) and from the diff view (navigates back and selects).

## Docs

Update `docs/web-ui-architecture.md`: "Code tab and diff view" (base-ref
choice, `pr` field, PR row) and "PR comments" (the new matching rule), plus
the `prcomments`/`gitutil` lines in CLAUDE.md that describe the tracked-number
rule.
