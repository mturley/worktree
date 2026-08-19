# slack-mini — toggleable reaction pills

**Date:** 2026-08-18
**Status:** Design approved (pending spec review)

## Problem

Reaction pills are display-only. Like real Slack, clicking a reaction should
toggle the current user's membership in it — add me if I haven't reacted,
remove me if I have. This is scoped to **existing** reactions only: there is no
emoji picker for adding a brand-new reaction emoji (explicitly out of scope).

Toggling a reaction is a **write to Slack**, so it must respect slack-mini's
existing write-safety posture (the send-allowlist), which exists to prevent the
tool from writing to channels/threads the user hasn't explicitly opted into.

## Scope

**In scope:**
- Clicking an existing reaction pill toggles the current user in/out of that
  reaction (`reactions.add` / `reactions.remove`).
- Optimistic UI with rollback on failure.
- The same `send_allowlist` guard that protects replies also protects reactions.

**Out of scope:**
- An emoji picker / adding a reaction with a new emoji not already present.
- Reacting from anywhere other than an existing pill.

## Safety posture (decided)

Reactions reuse the **existing `send_allowlist`** exactly as replies do: if the
allowlist is non-empty and the target channel is not in it, the server returns
403 **before** any Slack call. An empty/nil allowlist means unrestricted (no
channels configured yet), consistent with `handleReply`. Currently the
allowlist is seeded to the self-channel `DMFAS8V0X`, so until the user adds more
channels, reactions can only be toggled there.

**Disallowed-channel UX (decided):** pills remain clickable; a disallowed
toggle is handled by the optimistic-rollback path — the pill flips, the POST
returns 403, and the pill silently snaps back. No explanatory UX. This is a
deliberate, documented deviation from the general "permission-denied needs
explicit UX" guideline, acceptable here because slack-mini is a single-user
tool and the allowlist is self-imposed dev-safety, not a real permission
boundary. The frontend needs no pre-knowledge of the allowlist ("just try and
handle 403", decided).

## Architecture

### Slack API (see reverse-engineering doc)

Both endpoints are keyed by the **message `ts`** (not the thread ts):

- `reactions.add` — form: `channel`, `timestamp` (message ts), `name` (emoji
  name, no surrounding colons).
- `reactions.remove` — same params.

Idempotency quirks, treated as **success** (the desired end state already
holds, so a double-click or out-of-sync state self-heals):
- `reactions.add` → error `already_reacted` ⇒ success.
- `reactions.remove` → error `no_reaction` ⇒ success.

All other Slack errors propagate.

### slackapi.Client

Add two methods to the `Client` interface and `HTTPClient`:

```go
AddReaction(ctx context.Context, channel, ts, name string) error
RemoveReaction(ctx context.Context, channel, ts, name string) error
```

Each uses the existing `c.call(ctx, "reactions.add"|"reactions.remove",
url.Values{...}, nil)`, mirroring `MarkRead`. Both map the idempotency errors
above to `nil`.

### Server

New handler `POST /api/thread/react`:

- Body: `{ "channel": string, "ts": string, "name": string, "add": bool }`.
- Validate: all string fields non-empty (400 otherwise).
- **Allowlist guard FIRST** (same as `handleReply`): if
  `len(cfg.SendAllowlist) > 0 && !contains(cfg.SendAllowlist, channel)` →
  403, before any Slack call.
- Dispatch: `add ? AddReaction : RemoveReaction`.
- `ErrAuth` → 401; other client error → 502; success → 200 (empty body).

Registered next to the other thread mutation routes in the mux.

### Frontend

**`api.ts`:** `toggleReaction(channel, threadTs, ts, name, add): Promise<void>`
— POSTs to `/api/thread/react`; throws on non-OK so the caller can roll back.
(`threadTs` is not strictly needed by the endpoint but is passed for symmetry
with the other mutations and possible future use; the endpoint keys on `ts`.)

**State ownership:** reactions live on each `Message` in the thread data, held
by the thread hook/view that also does the optimistic reply patch. A pure
helper performs the optimistic edit:

```
applyReactionToggle(messages, ts, name, userId, add) -> messages'
```

- `add`: on the matching message's matching reaction, +1 `Count` and append
  `userId` to `UserIDs`. (Only existing reactions are toggled, so the reaction
  always exists for the remove case; for add, the pill already exists too.)
- remove: −1 `Count`, drop `userId` from `UserIDs`; if `Count` reaches 0,
  remove the reaction pill entirely.
- Idempotent no-ops (adding when already present, removing when absent) leave
  state unchanged.

**Click flow (in the state owner, passed down as `onToggle`):**
1. Compute `add = !mine` (`mine` = `currentUserId ∈ reaction.UserIDs`).
2. Snapshot current messages; apply `applyReactionToggle` optimistically.
3. `await toggleReaction(...)`; on any error, restore the snapshot (silent
   rollback — covers the disallowed-channel 403).
4. Guard against concurrent clicks on the same `(ts, name)` with a short
   in-flight lock so rapid toggles don't desync.

**`ReactionPill`** stays presentational: it gains an optional
`onToggle(name, add)` and renders the pill as a clickable control when
`onToggle` and `currentUserId` are provided; otherwise it stays display-only
(today's behavior). The hover tooltip is unchanged.

**Degenerate cases:**
- Removing my last reaction (Count 1→0): the pill disappears.
- `currentUserId` unknown: cannot compute `mine`; pill stays display-only.
- Rapid double-click: in-flight lock + server idempotency both protect.

## Testing

**slackapi:** `AddReaction`/`RemoveReaction` against a stub HTTP server —
correct endpoint + form params (`channel`, `timestamp`, `name`); `already_reacted`
(add) and `no_reaction` (remove) treated as success; other errors propagate.

**server:** `POST /api/thread/react` — allowlisted channel calls the right
client method (200); non-allowlisted channel with a non-empty allowlist → 403
**and the client react methods are never called** (guard-integrity); bad body →
400; client error → 502. Extend the test `fakeClient` with the two methods.

**frontend:**
- `applyReactionToggle` pure-function unit tests: add bumps count + appends id;
  remove decrements + drops id; remove-last removes the pill; idempotent
  add/remove are no-ops; non-matching ts/name left untouched.
- `ReactionPill`: click calls `onToggle(name, false)` when `mine`,
  `onToggle(name, true)` when not; no `onToggle`/`currentUserId` ⇒ display-only
  (no click handler).

**Verification:** `make test`, `go build ./...`, `npm run build`, then a live
check that toggles a reaction **only in the self-channel `DMFAS8V0X`** (the
sole allowlisted channel — never a shared thread), and confirms a
non-allowlisted channel is blocked with 403.

## Documentation

Extend the reverse-engineering doc's "## Reactions" section with
`reactions.add` / `reactions.remove` (params keyed by message `timestamp`) and
the `already_reacted` / `no_reaction` idempotency behavior.

## Follow-ups (not in this change)

- Emoji picker for adding a brand-new reaction.
- Explicit disabled/explanatory UX for disallowed channels, if the silent
  rollback proves confusing in practice.
