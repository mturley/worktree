# "Needs rebase" PR event — design

Date: 2026-11-06
Repos: `~/git/watcher` (library, released and re-pinned) and this repo.

## Why

When a followed PR develops merge conflicts, nothing in worktree says so. Mike
wants to find out from his unreads, for **every** PR he follows (not just his
own), so he can either rebase it himself or tell the author to. For his own
PRs it should also show up in "what needs my attention".

## Goals

- A new GitHub event, titled `Needs rebase: PR #<number> @ <short head sha>`
  (e.g. `Needs rebase: PR #1234 @ 85a4638`; 7-character SHA), emitted when a
  followed PR's `mergeable` becomes `CONFLICTING`. It arrives unread like any
  other event.
- When the conflict stops being current, the event is flagged by prefixing its
  title, exactly as CI bundles are, without re-delivering it.
- A `needs_rebase` attention signal for the user's **own** open PRs while they
  are currently conflicting.

## Non-goals

- **No "conflicts resolved" event.** The `pr_new_commits` event a rebase
  produces already covers it (Mike's decision).
- No attention signal for other people's conflicted PRs; they reach Mike only
  through the unread event (Mike's decision).
- Not tracking "behind base but no conflicts" (`mergeStateStatus: BEHIND`).
  "Needs rebase" means conflicts only (Mike's decision).
- No changes to notification code: nothing there filters by event type.

## Anti-goals

- A flickering or false event while GitHub is computing mergeability.
- Repeated events while a conflicted PR sits untouched and `main` keeps moving.
- Re-surfacing an already-read event when it is flagged out of date.

## Background (verified 2026-11-05 against odh-dashboard#10520)

- GraphQL `pullRequest { mergeable mergeStateStatus }` returned
  `CONFLICTING` / `DIRTY`; REST returned `mergeable: false`,
  `mergeable_state: "dirty"`. Either works; the poller already uses GraphQL.
- GitHub computes `mergeable` lazily: after a push to head or base it returns
  `UNKNOWN` until a background job finishes, and the query itself kicks that
  job off. `UNKNOWN` is therefore "no information", never a state change.
- CI bundles are flagged with `db.MarkCIBundlesOutOfDate` (`db/cibundle.go`):
  a title-only `UPDATE` prepending `outOfDatePrefix` (`"[out of date] "`),
  matched by type + resource + `tags = 'commit:<sha>'`, idempotent via a
  `NOT LIKE` guard, deliberately leaving `ts`/`external_ts` untouched so read
  state is preserved and nothing is re-delivered. It is called from
  `processPRWith` (`github/poller.go`, new-commits detection) when
  `latest_commit_sha` changed since the previous poll.

## Design

### Watcher library

1. **Fetch.** Add `mergeable` to the PR poll's GraphQL query and a
   `Mergeable string` field on `PRData` (`CONFLICTING` | `MERGEABLE` |
   `UNKNOWN`).

2. **Cached state.** Add `mergeable` and `mergeable_sha` (the head SHA the
   value applies to) to `buildPRStateJSON`. An `UNKNOWN` (or empty) poll
   carries the previous value forward **only if the head SHA is unchanged**;
   if the head moved and GitHub says `UNKNOWN`, store `mergeable: ""`
   (unknown for this commit). This avoids a pushed fix still reading as
   `CONFLICTING` while GitHub recomputes (Claude's call, from the builder
   check). Consumers can therefore trust a non-empty `mergeable` to describe
   the current head. `buildPRStateJSON` currently takes only `prData`, so the
   builder will need to pass the previous state in or resolve the value
   before the call.

3. **New event type.** `EventTypePRNeedsRebase = "pr_needs_rebase"` in
   `eventtype.go`, with a display name in `eventTypeDisplayNames`
   (e.g. "needs rebase"). Tag: `commit:<full head sha>` (same tag form as CI
   bundles, so the out-of-date helper can find it).

4. **Emit.** On each poll where the PR is open and `mergeable == CONFLICTING`,
   emit `pr_needs_rebase` for the current head SHA unless an event of that
   type **with the un-prefixed title** already exists for this resource and
   commit. Consequences:
   - One event per head commit; `main` moving while the PR stays conflicted
     emits nothing new.
   - **Re-conflict at the same head** (conflicting → clean → conflicting again
     with no new push, e.g. `main` was fixed and then broke again): the
     earlier event is now prefixed out of date, so a fresh event is emitted.
     A conflict that comes back is news (Claude's call, agreed by Mike).
   - Title-based dedup via `db.IsDuplicate` with `Title` set gives exactly
     this behavior, since the prefixed title no longer matches. Builder may
     use that or a tag-based check; either is fine if it has these semantics.
   - Timestamps: `ts` is the poll time (GitHub gives no "became conflicting
     at" time). `external_ts` is the head commit's date
     (`prData.Commits.LatestDate`), **not** the poll time:
     `db.EventCursor` takes the max `external_ts` as the cursor for skipping
     already-seen comments/reviews, and a poll-time value would push it past
     comments GitHub returns late. `pr_new_commits` already uses the commit
     date, so this adds no new risk (Claude's call, from the builder check).
     Add a test that emitting this event doesn't advance the cursor beyond
     the commit date. Author: none (a conflict has no single author).
   - A newly followed PR that is already conflicting gets its event on the
     **second** poll: the non-backfill first poll emits only `watch_started`
     and returns early, and this event follows the same path as everything
     else rather than special-casing it (Claude's call). A backfill first
     poll should emit it if conflicting.

5. **Mark out of date.** Title-only prefix, same rules as CI bundles (no
   timestamp change, idempotent, zero rows is fine), in two cases:
   - **Head commit moved** (`latest_commit_sha` changed): mark the previous
     SHA's `pr_needs_rebase`, alongside the existing CI bundle marking. If the
     new head still conflicts, step 4 emits a new event for the new SHA
     (Mike confirmed both).
   - **Conflict cleared:** previous cached `mergeable` was `CONFLICTING` for
     the same head SHA (`mergeable_sha`) and this poll says `MERGEABLE` →
     mark the current head SHA's `pr_needs_rebase`. (A head change is
     already covered by the case above.)

   Use the same `"[out of date] "` prefix as CI for consistency (Claude's
   call; Mike's request said "[Out of date]" "like we do for CI bundles").
   Generalise `MarkCIBundlesOutOfDate` into a shared helper that takes the
   event types to mark (keeping the CI entry point or updating its caller);
   don't duplicate the SQL.

6. **Closed/merged PRs.** Don't emit for non-open PRs. No need to mark
   existing events on close/merge.

7. **Tests** for: emit on CONFLICTING; no emit on UNKNOWN/MERGEABLE; no repeat
   at same head; UNKNOWN at the same head doesn't overwrite cached
   `mergeable` or trigger marking; UNKNOWN after a head change clears cached
   `mergeable`; `external_ts` doesn't advance the event cursor past the
   commit date; CONFLICTING→MERGEABLE marks the event and doesn't re-deliver
   (ts unchanged); head change marks the old event and emits for the new head
   if still conflicting; re-conflict at same head emits again; marking is
   idempotent.

8. Release a new minor version (next after v0.21.1) and push `main` + tag.

### worktree

1. **Re-pin** the new watcher version (`go get … && go mod tidy`). Check
   whether `wconfig` changed (it shouldn't); if so, follow "Config files ↔
   Settings modal".

2. **Attention signal.** Add `Mergeable string` to `attention.Resource`,
   populated in `webui.Server.AttentionInput` (`internal/webui/attention.go`)
   from the cached PR state the same way `CIStatus` is (see
   `resources_api.go` reading `ci_status`). In `resourceSignals`, add
   `needs_rebase` when `r.Mine && open && r.Mergeable == "CONFLICTING"`.
   Place it in the fixed signal order right after `ci_failing`. Update the
   package/CLI docs listing signals (CLAUDE.md's `attention` entry, the agent
   skill `internal/agentskill/SKILL.md` if it lists signals, and
   `docs/` wherever signals are enumerated) and any UI that labels signals.
   Note in the "Needs watcher >= …" line the new minimum version.

3. **Resource DTO.** Expose `mergeable` on the PR resource DTO
   (`resources_api.go`) alongside `ci_status`, and in `ui/src/api/types.ts`.

4. **Resource card badge** (required; Mike's decision). In `PRCardBody`
   (`ui/src/components/ResourceCard.tsx`), add an orange `conflicts` badge
   (same `size="xs" variant="light"` style as its siblings) shown only when
   the PR is open and `mergeable === "CONFLICTING"`. No badge for
   `MERGEABLE` or unknown. Tooltip: "Merge conflicts with the base branch:
   needs a rebase".
   - **Detail card:** in the badge line under the title, after the CI badge.
   - **List cards:** shown too, right after the state badge. This is a
     deliberate exception to the "list cards show only state" rule (update
     that comment): conflicts are rare and actionable, so they belong in a
     list scanned by status, and they cost nothing on the PRs without them.
   - Because the library clears `mergeable` when the head moves (library
     step 2), the badge disappears as soon as a fix is pushed and returns only
     if GitHub confirms the new head still conflicts.

5. **Timeline UI.** Add `pr_needs_rebase` to `ui/src/lib/eventMeta.tsx`:
   orange, a warning-style icon, label "needs rebase" (Claude's call). Add it
   to the PR "Commits" category in `ui/src/lib/eventTypeFilter.ts`
   (Claude's call: a rebase is commit work).

6. **Tests:** attention signal (mine+open+conflicting → signal; not mine,
   closed, MERGEABLE, empty → none); DTO plumbing; card badge (list + detail, open+CONFLICTING only); UI meta/filter tests if
   those files have them.

## Left to the builder

- Exact dedup mechanism (title vs tag query), as long as the semantics in
  library step 4 hold.
- Helper naming and whether `MarkCIBundlesOutOfDate` keeps its name as a
  wrapper.
- Exact icon choice.
