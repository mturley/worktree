# slack-mini v2 — Reply Sending (+ Mark Unread From Here)

**Date:** 2026-08-11
**Status:** Approved (brainstorming complete)
**Builds on:** v1 (read-only tabbed thread viewer). See
`docs/superpowers/specs/2026-08-07-slack-mini-design.md` and the RE doc
`docs/reverse-engineering/slack-web-api.md`.

## Purpose

Add the ability to reply to a thread from within slack-mini, plus a per-message
"Mark unread from here" action that rounds out v1's read-state control. This turns
slack-mini from a read-only viewer into a place you can actually respond from.

## Safety constraint (development)

During development we must NOT send real replies to threads that include other
people. This is enforced by a config **send allowlist** (see below), seeded with the
user's self-channel `DMFAS8V0X` so sends only succeed there until the user removes the
allowlist. Live verification of reply-sending happens ONLY in self-channel test
threads the user creates.

**Designated test thread:** `DMFAS8V0X` / `p1786457091390699` (thread_ts
`1786457091.390699`) in the user's self-channel. All live reply/mark-unread probes use
this thread (or others the user explicitly provides in `DMFAS8V0X`).

---

## Step 0 — "Mark unread from here" (per-message hover action)

Ships first so the user can give styling feedback before reply-sending is built.

The inverse of v1's "Mark thread read": hovering a message reveals an action that marks
the thread unread *starting at that message*, so the "New" divider moves above it and the
tab's unread dot lights up.

- **Backend:** add `MarkUnread(ctx, channel, threadTS, ts string) error` to
  `slackapi.Client`, implemented via `subscriptions.thread.mark` with `read=0` (the
  read-cursor equivalent of v1's mark-read). The exact param shape MUST be verified with a
  live probe before wiring — marking unread is safe to test on any thread (it posts
  nothing and doesn't affect other users). New endpoint `POST /api/thread/mark-unread`
  with body `{channel, thread_ts, ts}`; maps `slackapi.ErrAuth` → 401, other → 502.
- **Frontend:** on message hover (in `Message.tsx`), show a small action
  ("Mark unread from here", icon + tooltip). Clicking calls the endpoint with that
  message's `ts`; on success the thread re-fetches (or `lastRead` is updated locally) so
  the unread divider and the tab's unread dot reflect the new state.
- **User implements/iterates on the styling** of the hover action and approves it before
  reply-sending proceeds.

---

## Reply sending

### Architecture & data flow

- **Backend client:** add `PostReply(ctx, channel, threadTS, text string) (Message, error)`
  to `slackapi.Client`, via Slack `chat.postMessage` (`channel`, `thread_ts`, `text`). The
  request payload format (form-encoded vs JSON) MUST be verified with a live probe to the
  self-channel before wiring the UI (the RE doc notes chat.postMessage may want JSON; v1's
  other calls are form-encoded). `chat.postMessage` returns the created `message` (with its
  assigned `ts`); `PostReply` normalizes and returns it so the frontend can reconcile.
- **Endpoint:** `POST /api/thread/reply` with body `{channel, thread_ts, text}`. Behavior:
  1. Enforce the **send allowlist** (below) — reject non-allowed channels with 403 + a
     clear message.
  2. Post via `PostReply`.
  3. On success, also `MarkRead` up to the new message's `ts` (posting implies you've read
     the thread — matches Slack).
  4. Return the normalized new message.
  Error mapping: `ErrAuth` → 401; allowlist-blocked → 403; empty text → 400; other → 502.

- **Send allowlist (dev safety):** optional `send_allowlist []string` in
  `~/.config/slack-mini/slack-mini.yaml`. Semantics:
  - Non-empty → `/api/thread/reply` refuses any `channel` not in the list (403).
  - Empty/absent → no restriction (normal behavior).
  It is NOT written by a fresh `slack-mini setup` (a new config has no allowlist → sends
  work everywhere). It is a guard the user opts into. For development, the config is seeded
  with `send_allowlist: ["DMFAS8V0X"]` so sends only succeed in the self-channel. This is a
  development-mode safeguard, so there is NO proactive UI for it: the composer simply
  attempts the send, and if the server rejects it with 403 the composer surfaces the
  readable error (same failure path as any other send error). No `/api/config` allowlist
  exposure is needed.

### Composer UI

- **Placement:** a composer at the bottom of the thread area, ABOVE the pinned floating
  footer action bar (Mark read / Open in Slack / Refresh). Classic chat layout; messages
  scroll above it.
- **Composer:** Mantine `Textarea` (auto-growing) + a small **mrkdwn toolbar** (bold `*…*`,
  italic `_…_`, inline code `` `…` ``, and a link helper) that wraps the current selection,
  + a **Send** button. Content is plain text; Slack renders the mrkdwn.
- **Keyboard:** **Enter sends; Shift+Enter inserts a newline.**
- **Optimistic + reconcile:** on send, append the message locally as "sending…"; POST; on
  success mark it sent and let the SSE poll reconcile the real message (dedupe by the
  returned `ts` so the optimistic copy is replaced, not duplicated); on failure show a
  "failed — retry" state and preserve the typed text.
- **Mark-read on send:** a successful send clears the unread state (backend marks read; the
  frontend reflects it — unread dot/divider clear).
- **Blocked (allowlist) handling:** no proactive UI. The composer always accepts input and
  attempts the send; if the server rejects with 403 (channel not in the dev allowlist), the
  optimistic message enters the failed state and the composer shows the server's readable
  error. This is a dev-mode safeguard, not a user-facing feature.

### Error handling

- Auth expired (`ErrAuth` / 401): surfaced via the existing "re-run `slack-mini setup`"
  affordance.
- Allowlist-blocked (403): the optimistic message enters the failed state showing the
  server's readable error; the typed text is preserved. (Dev-mode safeguard.)
- Network/other (502): the optimistic message enters a "failed — retry" state; text kept.
- Empty/whitespace-only text: Send disabled; endpoint also rejects with 400.

### Testing

- `slackapi.PostReply` and `MarkUnread` via httptest (correct method, params, payload
  format; ErrAuth mapping; PostReply returns the new message).
- Endpoint tests with a fake client: `/api/thread/reply` allowlist enforcement (allowed vs
  blocked → 403), mark-read-on-success, empty-text → 400, auth → 401; `/api/thread/mark-unread`
  happy path + auth.
- Composer component tests: Enter sends vs Shift+Enter newline; toolbar wraps selection;
  Send disabled on empty text; optimistic append + failed-retry state (incl. a 403 from
  the server rendering the readable error).
- **Live verification ONLY in user-created self-channel (`DMFAS8V0X`) test threads.** Never
  post to a multi-person thread during development.

## Non-goals (v2)

- No @-mention or :emoji: autocomplete, no rich block composer (later phase).
- No editing or deleting sent messages.
- No file/image upload.
- No reactions-sending (separate feature).

## RE doc updates (deliverable)

When the live probes confirm the details, update
`docs/reverse-engineering/slack-web-api.md` with: `chat.postMessage` payload format +
response shape (the created message), and `subscriptions.thread.mark` with `read=0` for
marking unread from a given `ts`.
