# Phase 6 — agent-handler: Slack threads as a first-class watched resource type — Design

**Status:** Approved in-session 2026-08-21. Ready for implementation planning.

**Repo:** `~/git/agent-ledger` (module `github.com/mturley/agent-handler`) —
**handler-side only.** No watcher-library change, no re-pin (v0.4.3 is already
pinned and ships `slack.Poll` + `SlackAuth` + `config.Slack()` from Phase 4),
no DB schema migration, no inbox/routing change.

**Roadmap:** Phase 6 (last) of
`docs/superpowers/specs/2026-08-11-worktree-ui-and-watcher-adoption-roadmap.md`
(this repo). Builds on Phase 4's watcher Slack poller and Phase 5's
service-agnostic auto-subscribe.

## Goal

Make Slack a first-class watched resource type in agent-handler, alongside
`github` (PRs) and `jira`. Watched Slack threads' new replies flow into session
inboxes/timeline exactly as PR and Jira events do; `handler watcher
install`/`run`/`start`/`stop` cover Slack. This completes the 6-phase
worktree-UI + watcher-adoption roadmap.

## Why this is contained (recon findings)

- **Library support is already pinned.** handler `go.mod` pins watcher
  **v0.4.3**, which includes `slack.Poll(conn, SlackAuth{Token,Cookie,WorkspaceDomain},
  resources, logger)`, the `SlackAuth` struct, and `config.Slack() (SlackCreds,
  error)`. No library change, no `go get`.
- **Inbox routing is already type-agnostic.** `db/inbox_scope.go` joins
  `watcher_events` → `watcher_event_resources` → `watcher_subscriptions` on
  `(resource_type, resource_id)` with no service hardcoding. Once slack events
  land in `watcher_events` (via `slack.Poll`) and a session is subscribed to a
  `slack` resource, they route to the inbox automatically. **No routing change.**
- **Registration auto-subscribe is already service-agnostic** (Phase 5). It
  keys off `config.ResourceTypeToService(...)` returning non-empty. Making that
  return `"slack"` is all that's needed for slack primaries to auto-watch.
- **Phase 5 left labeled hooks.** The Slack seams in `cmd/watcher/*` and
  `config/*` are deliberately commented "Slack intentionally excluded until its
  phase." Phase 6 flips them on.

So Phase 6 is a focused set of seam edits + one small URL-builder + tests.

## Load-bearing decisions (brainstorm 2026-08-21)

1. **Slack poll interval = 5 minutes** (matches Jira; github=3m). Thread replies
   are less time-sensitive than PR CI, and it's conservative on Slack API rate
   limits. `defaultIntervals["slack"] = 5 * time.Minute`.
2. **`DefaultResourceURL("slack", "<channel>:<ts>")` builds a Slack archive
   permalink**: `https://<WorkspaceDomain>/archives/<channel>/p<ts-digits>`
   where `<ts-digits>` is the thread ts with the `.` removed (Slack's archive
   format; the inverse of worktree's `slackurl.Parse`, which maps
   `.../archives/C.../p1699999999000100` → `1699999999.000100`). Returns `""`
   when `WorkspaceDomain` is unset (no bad URL — honors the no-empty/no-broken
   rule). Defensive: tolerate `WorkspaceDomain` stored with or without a
   scheme / trailing slash.
3. **No new handler-side Slack setup flow.** Credential acquisition is already
   covered by `handler watcher auth slack` (the credsetup work). Phase 6 only
   makes the poller/install path recognize Slack.

## Changes (all in `~/git/agent-ledger`)

### `cmd/watcher/watcher.go`
- `knownWatchers = []string{"github", "jira"}` → `{"github", "jira", "slack"}`.
  This cascades to `install`/`start`/`stop`/`uninstall`/`list`/`logs`, which all
  iterate `knownWatchers`.

### `cmd/watcher/run.go`
- Add to the poll dispatch `switch name`:
  ```go
  case "slack":
      sc, err := creds.Slack()
      if err != nil {
          return fmt.Errorf("slack credentials not available: %w", err)
      }
      auth := wslack.SlackAuth{
          Token:           sc.Token,
          Cookie:          sc.Cookie,
          WorkspaceDomain: sc.WorkspaceDomain,
      }
      return wslack.Poll(d.Conn(), auth, resources, logger)
  ```
  (import the library's slack package as `wslack`, mirroring `wgithub`/`wjira`).
- `serviceToResourceType`: add `case "slack": return "slack"`.

### `cmd/watcher/install.go`
- `defaultIntervals["slack"] = 5 * time.Minute`.
- `installAll`: add `slackChanged, _ := credsetup.TestAndRepair(cfg,
  credsetup.Slack, prompter)` alongside GitHub/Jira, and include `slackChanged`
  in the `if ...Changed { cfg.Save(...) }` guard so Slack auth is offered by
  `handler watcher install` (no-arg). `isServiceConfigured` already has a
  `case "slack"`.
- Update the now-stale comments that say Slack is "intentionally excluded" /
  "no Slack poller yet" (the block comment ~lines 15-25 and the `installAll`
  scope comment ~lines 67-70, and the `defaultIntervals` comment).

### `config/config.go`
- `ResourceTypeToService`: add `case "slack": return "slack"`.
- `IsServiceConfigured`: add
  `case "slack": return c.Services.Slack != nil && c.Services.Slack.Token != ""`.
  (The auth.yaml-based `config/service_configured.go` already handles slack.)
- `DefaultResourceURL`: add `case "slack": return slackResourceURL(c, resourceID)`.
- New helper `slackResourceURL(c *Config, resourceID string) string`:
  - split `resourceID` on the first `:` → `channel`, `ts`; if malformed
    (no colon / empty parts) → `""`.
  - `domain := c.Services.Slack.WorkspaceDomain` (guard nil Slack → `""`);
    strip any leading scheme and trailing slash so we always have a bare host.
  - `tsDigits := strings.ReplaceAll(ts, ".", "")`.
  - return `"https://" + domain + "/archives/" + channel + "/p" + tsDigits`.

### Registration / auto-subscribe
- No code change. Once `ResourceTypeToService("slack")` is non-empty, slack
  primaries from `worktree resources list --json` auto-watch at registration
  (Phase 5 helper) and their events reach the inbox via the existing routing.

## Testing

- **`config/config_test.go`** (extend the existing `TestDefaultResourceURL` +
  add small tests):
  - `DefaultResourceURL("slack", "C0123ABCD:1699999999.000100")` with
    `WorkspaceDomain: "myteam.slack.com"` →
    `"https://myteam.slack.com/archives/C0123ABCD/p1699999999000100"`.
  - `WorkspaceDomain` unset → `""`.
  - `WorkspaceDomain` stored as `"https://myteam.slack.com/"` → same correct
    URL (scheme/slash tolerated).
  - malformed id (`"nocolon"`) → `""`.
  - `ResourceTypeToService("slack") == "slack"` and
    `IsServiceConfigured` true/false for slack.
- **`cmd/watcher`**: `knownWatchers` includes `"slack"` and
  `serviceToResourceType("slack") == "slack"`. (`cmd/watcher` has no existing
  test file; add a minimal one for these pure functions. The `run.go` poll
  dispatch itself is not unit-tested for github/jira either — it needs a live
  DB + network — so the slack dispatch is verified by the manual smoke below,
  matching the existing convention. Do NOT add a fake-network harness just for
  slack when github/jira lack one.)
- Full suite (`go test ./...`) stays green.

## Manual smoke (out of unit scope — network/interactive)

With Slack configured in `~/.config/watcher/auth.yaml` and at least one watched
slack thread:
- `handler watcher install slack` (or no-arg `install`) sets up the 5m poller.
- `handler watcher run slack --resources <channel>:<ts>` polls and emits a
  `slack_reply` event for a new reply; confirm it appears in the session inbox.
- A worktree with a primary slack resource → new handler session registration
  auto-watches it (Phase 5 path) and receives replies.

Requires building/installing handler (kill + restart the running handler UI
server first, with Mike's OK — same gotcha as Phase 5).

## Release / cross-repo

- **Handler-only, single-repo.** No watcher-library change, no re-pin, no schema
  migration. Build + test + merge; no cross-repo tag/pin dance.

## Non-goals

- Any watcher-library or worktree change.
- A new handler Slack setup/token flow (already `handler watcher auth slack`).
- Changing inbox rendering of slack events beyond what generic watcher-event
  routing already produces.
- Slack in worktree (already shipped in Phases 3/4).
