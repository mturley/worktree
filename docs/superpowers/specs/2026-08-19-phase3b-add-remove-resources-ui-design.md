# Phase 3b — Add/Remove worktree resources from the web UI — Design

**Status:** Approved in-session 2026-08-19. Ready for implementation planning.

**Context:** This is the original Phase 3b scope (add/remove resources from the web UI), deferred when Phase 3b pivoted to the custom-name/description bug fix. Building it now, before Phase 5. The web UI is currently read-only for resources (`GET /api/worktree-resources` + `POST /api/resource-meta` for names); there is no way to add or remove a resource from the UI.

## Goal

Let a user add a resource to a worktree by pasting a PR/Jira/Slack URL, and remove a resource, from the web UI — via two new mutation endpoints and controls on the Overview tab + a `+` button in the Slack tab.

## Non-goals

- Editing an existing resource's URL; drag-reorder; bulk actions.
- Soft `Unwatch` in the UI. `Unwatch` (the watcher `UserUnsubscribe` tombstone) is CLI/handler-only plumbing whose exact semantics are being reconsidered for Phase 5 (see the roadmap memory: handler `/unwatch` should become session-scoped auto-watch suppression, NOT a stop-watching signal). Deliberately kept out of the UI so we don't bake in a semantic we're about to revisit. The UI's remove control is hard `Remove` only.
- A separate slack-only add endpoint — the `+` button reuses the generic add-by-URL flow.

## Backend: two mutation endpoints

Both live in `internal/webui`, mirror the existing `handleSetResourceMeta` shape (JSON body, `writeError`, `path` required), and register next to the other resource routes in `server.go`.

### `POST /api/worktree-resources/add`
Body: `{ "path": string, "url": string, "related"?: bool }`.

1. Validate `path` and `url` non-empty → 400 otherwise.
2. **Infer type + id from `url`**, reusing the existing CLI primitives so the web and CLI agree on what a URL means:
   - PR: `prURLPattern` (`cmd/root.go`, `github\.com/([^/]+)/([^/]+)/pull/(\d+)`) → type `"pr"`, id `"<owner>/<repo>#<number>"` (match the id format `handlePR`/`cmd/add.go` produces — verify exact format at implementation).
   - Jira: `jira.ParseJiraURL(url)` (`internal/jira/detect.go`) → type `"jira"`, id = issue key.
   - Slack: `slackurl.Parse(url)` → type `"slack"`, id `slackurl.ResourceID(channel, threadTS)`.
   - No match → 400 `"unrecognized resource URL"`.
   - NOTE: the type-inference is shared logic. Factor it into a small reusable helper (e.g. `inferResource(url) (type, id string, ok bool)`) rather than duplicating the three-way branch — usable by both this endpoint and, if convenient, `cmd/add.go`. Keep it where both can reach it (e.g. a small function in `internal/resources` or a new tiny package; implementer's call, but do NOT copy-paste the regex/parse calls into the handler if a shared helper is clean).
3. `resources.Add(conn, path, resources.Resource{Type, ID, URL: url, Related: related})` (already guarded against empty type/id).
4. **Inline enrichment:** immediately poll just this one resource so `resource_state` is populated before responding, REUSING the existing poller entry points (no duplicated fetch logic):
   - Load creds via the same `wconfig.Load(...)` path `pollAll` uses.
   - Call the matching library poller with a single-element resource slice: `wgithub.Poll(conn, gh.Token, []watcher.Resource{r}, logger)` / `wjira.Poll(conn, auth, []..., logger)` / `wslack.Poll(conn, slackAuth, []..., logger)`.
   - If creds are missing or the poll errors, DO NOT fail the request — the subscription already exists and the background `pollAll` will retry. Log it.
5. Return `200` with the enriched `resourceDTO` (built the same way `handleWorktreeResources` builds each DTO, incl. `enrichResourceDTO`).

### `POST /api/worktree-resources/remove`
Body: `{ "path": string, "type": string, "id": string }`.
- Validate all three non-empty → 400 otherwise.
- `resources.Remove(conn, path, type, id)` (hard remove: deletes the subscription + primary flag).
- `204 No Content` on success; 500 on DB error.

## Frontend

### API client (`ui/src/api/client.ts`)
- `addResource(args: { path: string; url: string; related?: boolean }): Promise<ResourceDTO>` → `POST /api/worktree-resources/add`, JSON body, `Content-Type: application/json`, via the existing `fetchJSON`.
- `removeResource(args: { path: string; type: string; id: string }): Promise<void>` → `POST /api/worktree-resources/remove` (fetchJSON<null>).

### Overview "Add resource" (`WorktreeDetailPage` / `ResourceList`)
- An "Add resource" row: a `TextInput` (placeholder "Paste a PR, Jira, or Slack URL") + an Add button (disabled while empty/submitting).
- On submit: `await api.addResource({ path, url })`, then refetch the resource list (reuse the `useWorktreeDetail` `resources.refetch()` wired in Phase 3b), clear the field.
- On failure (unrecognized URL / add error): a dismissible inline `Alert` (same pattern as SlackTab's save-error alert). Clear it on the next attempt.

### Remove control (`ResourceCard`)
- A small subtle `×`/trash `ActionIcon` on each card.
- **Confirm step:** clicking it shows a lightweight confirmation (Mantine popover — "Remove this resource?" with Remove/Cancel) so a stray click can't drop a resource. Confirm → `api.removeResource({ path, type, id })` → refetch.
- `ResourceCard` gains a `path` prop + an `onRemoved` (or remove-handler) callback threaded from `ResourceList`/`WorktreeDetailPage` (currently it takes only `r`).

### Slack tab `+` button (`SlackTab.tsx`)
- A `+` button at the top of the NavLink rail.
- Opens the same add flow, slack-scoped: a small modal/inline field with a URL input labeled "Paste a Slack thread URL", calling `api.addResource({ path, url })` — the backend infers `type:"slack"` from the URL; no special endpoint.
- On success: refetch (SlackTab already has `refetch`), optionally auto-select the new thread. Same inline error handling.
- Update the Slack empty-state text (currently `Add one with <worktree add <slack-thread-url>>`) to also mention the `+` button.

## Testing

- **Backend (`internal/webui`):** add endpoint — PR URL → pr resource created; Jira URL → jira; Slack URL → slack; unrecognized URL → 400; missing path/url → 400. Remove endpoint — removes the row (Load no longer returns it); 400 on missing fields. For inline enrichment: assert the subscription is created and the endpoint returns a DTO; if a fake/injected poller is heavy, assert a poll is attempted and leave the live-fetch as a manual smoke item (don't block on faking three pollers).
- **Frontend (vitest):** `ResourceList` add-field (calls `api.addResource`, shows error alert on reject, refetches on success); `ResourceCard` remove (confirm popover → `api.removeResource` → refetch; cancel does nothing); `SlackTab` `+` (opens add, calls `api.addResource` with the slack URL).

## Reuse notes / gotchas
- The type-inference primitives already exist: `prURLPattern` (`cmd/root.go`), `jira.ParseJiraURL` (`internal/jira/detect.go`), `slackurl.Parse` + `slackurl.ResourceID` (`internal/slackurl`). Share, don't duplicate.
- `resources.Add` already rejects empty type/id (recent fix) — the endpoint relies on that plus its own 400s.
- Inline enrichment reuses `wgithub.Poll`/`wjira.Poll`/`wslack.Poll` (single-element slice) — the SAME functions `internal/webui/poller.go`'s `pollAll` calls. No new fetch code.
- Refetch on the frontend reuses the `useWorktreeDetail` react-query `resources.refetch()` (queryKey `["resources", path]`) established in Phase 3b.
