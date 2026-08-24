# Slack Web API — Reverse-Engineering Notes

How slack-mini talks to Slack. These are undocumented / session-token behaviors verified
by direct experimentation, not from Slack's official public API docs. Keep this file
current: whenever you learn something new about how Slack's API behaves (new field, changed
shape, new endpoint, auth quirk), add it here.

**Last verified:** 2026-08-07, against the Red Hat Enterprise workspace
(`redhat-internal.slack.com`) using session-mirroring tokens.

## Authentication (session mirroring)

slack-mini does not use OAuth. It reuses the browser session's tokens ("session
mirroring"), the same approach as the `slack-mcp` / `slack-mcp-server` projects. This gives
user-level access without admin app approval.

Two secrets are required:

| Secret | Prefix | Where it goes |
|--------|--------|---------------|
| API token | `xoxc-` | `Authorization: Bearer <xoxc-…>` header |
| Session cookie | `xoxd-` | `Cookie: d=<xoxd-…>` header |

**Both are required together.** An `xoxc-` token without the matching `d` cookie returns
`not_authed`.

Request shape:

```
POST https://slack.com/api/{method}
Authorization: Bearer xoxc-…
Cookie: d=xoxd-…
Content-Type: application/x-www-form-urlencoded; charset=utf-8

channel=C0EXAMPLE1&ts=1700000000.000001&limit=3
```

- Methods used by slack-mini (`conversations.replies`, `users.info`, `emoji.list`,
  `subscriptions.thread.mark`, `chat.postMessage`) accept
  **`application/x-www-form-urlencoded`** bodies. (Some other Slack methods want JSON, but
  `chat.postMessage` works form-encoded too — confirmed 2026-08-11.)
- Response is always JSON with a top-level `"ok": true|false`. On failure, `"error"` holds
  a code.

### Error codes seen

| `error` | Meaning | Handling |
|---------|---------|----------|
| `not_authed` | Missing/blank token or cookie | Treat as auth failure → prompt re-setup |
| `invalid_auth` | Token rejected | Auth failure → prompt re-setup |
| `token_expired` | Session token aged out (1–2 weeks) | Auth failure → prompt re-setup |
| `ratelimited` | Too many requests | Respect `Retry-After` header, back off, retry |

### Token acquisition & storage

- The Red Hat `slack-mcp` tool stores tokens at `~/.local/share/slack-mcp/tokens.env` as
  `SLACK_MCP_XOXC_TOKEN` / `SLACK_MCP_XOXD_TOKEN` (with a `# Team ID:` comment). Extraction
  is handled by its `scripts/setup-slack-mcp.py` (browser-session extraction via Playwright).
- `slack-mcp-server` (the jtalk22 project) stores at `~/.slack-mcp-tokens.json`
  (`SLACK_TOKEN` / `SLACK_COOKIE`) with fallbacks to macOS Keychain and Chrome extraction.
- slack-mini's own config lives at `~/.config/slack-mini/slack-mini.yaml`
  (`token`, `cookie`, `workspace_domain`, `port`). `slack-mini setup` is fully
  self-contained: it does NOT read any other tool's stored credentials. It guides the user
  through extracting the `xoxc-` token (from `localStorage.localConfig_v2`) and the `xoxd-`
  `d` cookie via browser dev tools, then stores them. It no longer prompts for a workspace
  domain: after fresh credentials are pasted, setup calls `team.info` and derives the
  workspace host from the team's `url` field (e.g. `myteam.slack.com`, or
  `myteam.enterprise.slack.com` on Enterprise Grid) — this is correct for Enterprise Grid,
  unlike naively assuming `{domain}.slack.com`. This call also doubles as credential
  validation. On re-run, setup first validates any existing saved token with `auth.test` and
  only re-collects (then re-derives the domain) when it's missing or invalid. (The
  `slack-mcp` / `slack-mcp-server` entries above are noted only as other tools that use the
  same session-mirroring technique — slack-mini is not coupled to them.)
- Optionally, `slack-mini setup` can extract the token/cookie itself instead of asking the
  user to use dev tools: it drives a headed Chromium (via a transient, on-demand Playwright
  install cached in `~/.cache/slack-mini`) through a persistent browser profile at
  `~/.cache/slack-mini/browser-profile`, navigates to `https://slack.com/signin`, and polls
  `localStorage.localConfig_v2` on every open tab in that browser context — since logging in
  spawns new tabs (SSO redirect, workspace picker, then the real client) rather than
  navigating the original one — until a team token starting with `xoxc-` shows up, then reads
  the matching `d` cookie. This is entirely optional and interactive (it requires a human to
  complete the login); the manual dev-tools flow above remains the fallback.

Tokens expire roughly every 1–2 weeks and must be re-extracted.

## `conversations.replies` — fetch a thread

Params: `channel`, `ts` (the thread root ts), `limit`, and cursor pagination via
`response_metadata.next_cursor` (loop while `has_more` is true).

Returns `messages[]`. **Message ordering is chronological**, index 0 is the thread parent.

### Read state lives on the parent message

The **first message** (the thread root) carries thread-level state fields that replies
don't:

| Field | Meaning |
|-------|---------|
| `last_read` | ts of the last message the current user has read on this thread |
| `subscribed` | whether the user is subscribed to the thread |
| `reply_count` | number of replies |
| `reply_users_count`, `reply_users[]` | distinct repliers |
| `latest_reply` | ts of the most recent reply |

**Unread divider** = the first reply whose `ts` (compared numerically) is greater than the
parent's `last_read`. No separate endpoint is needed. This was the key finding that removed
a whole class of complexity from the design.

### Per-message fields

Every message has: `ts`, `user` (author ID), `type` (`"message"`), `text` (mrkdwn), and
usually `blocks`. Optional: `reactions`, `edited`, `client_msg_id`, `parent_user_id`
(on replies), `thread_ts`.

## Message content: prefer `blocks` over `text`

Two representations coexist:

1. **`text`** — mrkdwn string with encoded tokens:
   - `<@U0EXAMPLE9>` — user mention
   - `<!subteam^S07CFUVMXBM>` — user group mention
   - `<!here>` / `<!channel>` — broadcasts
   - `<https://url|label>` — link with display label
   - `:emoji_name:` — emoji
   - `&amp;` `&lt;` `&gt;` — HTML-escaped entities
2. **`blocks`** — structured, typed representation. For normal messages this is a single
   block of `type: "rich_text"` whose `elements` are `rich_text_section` (and, in richer
   messages, `rich_text_list`, `rich_text_quote`, `rich_text_preformatted`). Each section's
   `elements` are typed leaves:

   | Element `type` | Key fields |
   |----------------|-----------|
   | `text` | `text`, optional `style: {bold, italic, code, strike}` |
   | `user` | `user_id` |
   | `link` | `url`, optional `text` (label) |
   | `emoji` | `name`, and `unicode` (codepoint) **for standard emoji only** — custom emoji have no `unicode` |
   | `usergroup` | `usergroup_id` (subteam) |
   | `broadcast` | `range` (`here`/`channel`/`everyone`) |

   **These two are keyed differently from every other leaf, and it bit us.**
   `usergroup` carries `usergroup_id` and `broadcast` carries `range` —
   neither uses `name`. The library's `rawElement` originally mapped only
   `name` (its comment even claimed it held the usergroup id), so both fields
   arrived empty: every group rendered as a generic placeholder, and every
   broadcast rendered as `@here` regardless of whether it was `@channel` or
   `@everyone`. Fixed in watcher v0.5.0, which adds `Element.UserGroupID` and
   `Element.Range`. If you add another leaf type, check its real key rather
   than assuming `name`.

### ⚠️ Automated probing can get the session token revoked

**Learned the hard way, 2026-08-24.** A short burst of scripted API calls
against a live workspace (a mix of `auth.test`, `usergroups.list`,
`auth.teams.list`, `conversations.info`) caused the user's `xoxc` session
token to be invalidated **twice within about twenty minutes** — once
mid-sequence, with calls that had just succeeded suddenly returning
`invalid_auth`. Session tokens are browser credentials; Slack appears to
treat unusual method mixes from a non-browser client as automation and kills
the session.

Practical rules for anyone reverse-engineering this API:

- **Prefer browser devtools over scripted probes.** Watching the real Slack
  web app's network traffic costs zero automated calls, uses the session
  exactly as Slack expects, and shows you the actual request the client makes
  — which is strictly more informative than guessing parameters.
- If you must call the API directly, keep it to a **single, targeted request**
  and stop on the first answer. Do not iterate over parameter variants.
- Never probe unusual admin/org methods (`auth.teams.list` and friends) —
  they are the most likely to look like automation, and on a session token
  they are usually rejected anyway (`not_allowed_token_type`).
- Re-authenticating is not free for the user: it means re-extracting a token
  and cookie by hand via `worktree setup`.

### `usergroups/info` on the edge cache — THE way to resolve group names

**This is what Slack's own web client uses**, discovered by watching its
network traffic in a real browser (Playwright, 2026-08-24). It is not
`usergroups.list`, and it is not on `slack.com/api` at all.

```
POST https://edgeapi.slack.com/cache/<TEAM_OR_ENTERPRISE_ID>/usergroups/info
     ?_x_app_name=client

body: {"token":"<xoxc-…>","ids":["S07CFUVMXBM"],"enterprise_token":"<xoxc-…>"}
```

Response (fields trimmed to the useful ones):

```json
{"ok":true,"results":[{
  "id":"S07CFUVMXBM",
  "handle":"openshift-ai-dashboard-zaffre-scrum",
  "name":"OpenShift AI Dashboard Zaffre Scrum",
  "team_id":"T027F3GAJ",
  "is_usergroup":true, "is_subteam":true,
  "user_count":6, "prefs":{"channels":["C069KSM8T9N"]}
}]}
```

Why this matters, given everything above:

- It is a **bulk lookup keyed by subteam id** — exactly the shape a renderer
  needs, since a `<!subteam^S…>` mention hands you the id and you only lack
  the name. The public API has no equivalent (`usergroups.list` enumerates and
  returns nothing on Grid; there is no `usergroups.info`).
- It works with the **same `xoxc` session token + `d` cookie** we already
  hold — no extra scope, no workspace `T…` id needed in the path, because the
  path takes the **enterprise/team id** which `auth.test` already returns as
  `team_id`.
- It even returns the workspace `team_id` (`T027F3GAJ`) that `auth.teams.list`
  refused to give us — so if per-workspace `usergroups.list` is ever wanted,
  this is where to get the id.
- `handle` is what renders in a message (`@openshift-ai-dashboard-zaffre-scrum`);
  `name` is the human label. Prefer `handle`, then `name`, then the bare id.

Note the `enterprise_token` field is sent alongside `token`; in the observed
request both were the same `xoxc` value. The URL path segment was the
enterprise id (`E030G10V24F`) on this Grid org.

**Do not paste real tokens into this file** — the observed request body
contained the live session token and is redacted above.

### `usergroups.list` — the user-group directory

Resolving a `<!subteam^S123>` mention to a readable label needs a directory;
the mention itself carries only the id.

```
POST /api/usergroups.list
-> {"ok":true,"usergroups":[{"id":"S1","name":"Platform Team","handle":"platform"}, ...]}
```

- **VERIFIED against a live workspace, and it does not work on Enterprise
  Grid.** The endpoint is callable with a session (`xoxc`) token — it does not
  403 — but on an org-level Grid token it returns `ok:true` with an **empty**
  `usergroups` array, even though the workspace plainly has groups.

  What the probe showed (redhat.enterprise.slack.com, 2026-08-24):

  | call | result |
  |---|---|
  | `auth.test` | `ok`, `team_id=E030…`, `enterprise_id=E030…` — **identical**, i.e. an org-level token |
  | `usergroups.list` (no params) | `ok`, 0 groups |
  | `usergroups.list` + `include_disabled=true` | `ok`, 0 groups |
  | `usergroups.list` + `team_id=E030…` | `ok:false`, `invalid_arguments` |

  The `team_id` it wants is a **workspace** id (`T…`), but an org-level token's
  `auth.test` reports the **enterprise** id (`E…`), which the endpoint rejects.
  Resolving group names on Grid would therefore mean discovering the org's
  member-workspace `T…` ids and calling `usergroups.list` per workspace, then
  merging — several undocumented calls. **We deliberately stopped short of
  that**; the UI degrades to a readable `@group` label with the subteam id in
  the title attribute.

  Additional negative results (fresh token, same outcome — so the empty list
  is a Grid scoping limit, not a stale-token artifact):

  | call | result |
  |---|---|
  | `usergroups.list` (fresh token, no params) | `ok`, 0 groups |
  | `auth.teams.list` (to discover member workspace `T…` ids) | `ok:false`, `not_allowed_token_type` |

  **There is no public single-group lookup** — the API has `usergroups.list`
  but no `usergroups.info`, so there is no way to resolve one known subteam id
  on demand either.

  If you pick this up, do it **from browser devtools, not scripted probes**
  (see the warning above). Open a channel containing a group mention in the
  Slack web app, filter the network tab, and find the request that supplies
  subteam names — the likely candidates are the client bootstrap payloads
  (`client.boot` / `client.userBoot` / `client.counts`) or an internal
  `subteams.*` method. Record the real request shape here before writing any
  code against it.

- `handle` is what Slack renders in a message (`@platform`); `name` is the
  human label shown in admin UI (`Platform Team`). Prefer `handle`, fall back
  to `name`, then to the bare id — never to a generic word, or every group
  looks alike.
- The directory is workspace-wide and changes rarely, so fetch it once and
  cache it rather than per thread. `watcher/slack.Client.UserGroups` returns
  it keyed by id; `internal/webui`'s `Server.userGroups` caches it exactly as
  `Server.emoji` caches the emoji map.
- A failed lookup returns an error rather than an empty map, so callers can
  tell "lookup failed" from "workspace has no groups" — the thread render
  degrades to showing ids instead of failing.

**Render from `blocks`** — it's typed and unambiguous, unlike reverse-parsing mrkdwn. Fall
back to `text` only for message subtypes that lack `blocks` (some Slackbot/bot messages).

### Example (real structure, sanitized)

```json
{
  "type": "rich_text",
  "elements": [{
    "type": "rich_text_section",
    "elements": [
      { "type": "user", "user_id": "U0EXAMPLE9" },
      { "type": "text", "text": " can we add this to the demo? The " },
      { "type": "emoji", "name": "green_ball" },
      { "type": "text", "text": " stakeholders differ " },
      { "type": "emoji", "name": "sweat_smile", "unicode": "1f605" }
    ]
  }]
}
```

## Reactions

`reactions: [{ "name": "agree+1", "users": ["U…","U…"], "count": 2 }]`. `name` may be a
custom emoji name (resolve via `emoji.list`) or a standard emoji name.

### `reactions.add` — add a reaction to a message

```
POST /api/reactions.add
channel={C…}&timestamp={message ts}&name={emoji name}
→ {"ok": true}
```

Add a reaction emoji to a message. Form-encoded params:
- `channel` — message's channel ID
- `timestamp` — **message** timestamp (the `ts` of the message being reacted to, NOT the thread root ts)
- `name` — emoji name without colons (e.g. `thumbsup`, not `:thumbsup:`)

**Idempotency:** If the current user has already added this reaction, Slack returns error
`already_reacted` (with `ok: false`). slack-mini treats this as success — the desired state
(user has reacted) already holds. Verified 2026-08-18.

These writes are gated behind the `send_allowlist` safety mechanism (same as
`chat.postMessage` / replies); users can only toggle reactions in allowlisted channels.

### `reactions.remove` — remove a reaction from a message

```
POST /api/reactions.remove
channel={C…}&timestamp={message ts}&name={emoji name}
→ {"ok": true}
```

Remove a reaction emoji from a message. Form-encoded params are identical to
`reactions.add`:
- `channel` — message's channel ID
- `timestamp` — **message** timestamp (the `ts` of the message being reacted to, NOT the thread root ts)
- `name` — emoji name without colons

**Idempotency:** If the current user has not added this reaction (or has already removed it),
Slack returns error `no_reaction` (with `ok: false`). slack-mini treats this as success —
the desired state (user has not reacted) already holds. Verified 2026-08-18.

These writes are gated behind the `send_allowlist` safety mechanism (same as
`chat.postMessage` / replies); users can only toggle reactions in allowlisted channels.

## File uploads (`files[]`)

A message can carry a `files` array of uploaded files (images and documents), separate
from `blocks` and `attachments`. Common fields:

- `id`, `name`, `title`, `mimetype` (e.g. `image/png`, `application/pdf`), `filetype`
  (`png`), `pretty_type` (`PNG`), `size` (bytes), `permalink` (the file's Slack web page).
- `url_private` — the raw file bytes. `url_private_download` — same, as an attachment.
- **Images** additionally have `original_w`/`original_h` and a ladder of server-generated
  thumbnails `thumb_64`, `thumb_80`, `thumb_160`, `thumb_360`, `thumb_480`, `thumb_720`,
  `thumb_800`, `thumb_1024` — each with matching `_w`/`_h` dimension fields. Treat a file as
  an image when `mimetype` starts with `image/`.

**Auth:** `url_private` and every `thumb_*` are hosted on **`files.slack.com`** and require
the session `d=` cookie — a bare request without it returns HTML/403, not the image. So
slack-mini serves them through `GET /api/file?url=…`, which allowlists `files.slack.com` and
forwards the `d=` cookie (the same image-proxy machinery as `/api/avatar` and `/api/emoji`,
which already forward the cookie). `permalink` (not `url_private`) is what you open in the
browser for non-image files — Slack renders the preview/download there with the user's
session. slack-mini only proxies image bytes; non-image file content is opened via
`permalink`, never proxied.

## Link previews (`attachments[]`)

Slack generates "unfurls" for URLs in a message and delivers them as a message
`attachments` array (separate from `blocks` and `files`). Two kinds matter:

- **Web link unfurl** (GitHub PR, Jira, article, etc.): `title`, `title_link`, `text`
  (Slack **mrkdwn**), `service_name`, `service_icon`, `footer`, `footer_icon`, `color`
  (hex without `#` — Slack renders it as a left-border accent), and optionally `image_url`
  or `thumb_url` with `image_width`/`image_height`. Preview images are hosted on the
  **service's own CDN** (e.g. `github.com/user-attachments/…`), NOT Slack — so slack-mini
  loads them directly with a plain `<img src>` (no proxy) and hides the image on error.
- **Slack thread unfurl** (a pasted link to another thread): `is_msg_unfurl` and/or
  `is_reply_unfurl` are true, `from_url` is a Slack archive URL (parseable to
  channel+thread_ts), plus `author_name`, `text`, `channel_id`, `ts`, and
  `footer: "Thread in Slack Conversation"`. slack-mini renders these with an "Open thread"
  button that opens the linked thread as a tab (plain click = foreground, Cmd/Ctrl+click =
  background), reusing the same thread-URL parsing as the "+" tab / `?open=` flow.

A message can carry multiple attachments. Attachment `text`/`footer` and the message `text`
fallback (when no `blocks[]` is present) now render through the shared inline mrkdwn renderer
(v3c, `ui/src/lib/mrkdwn.tsx`): mentions (`<@U…>`, `<!subteam^…|label>`, `<!here>`/`<!channel>`/
`<!everyone>`), links (`<url>`/`<url|label>`), `:emoji:` tokens (standard glyphs, custom
workspace images, and `:name:` fallback for unknown names), and single-level `*bold*`/
`_italic_`/`~strike~`/`` `code` `` styling. Link hrefs are scheme-sanitized — only `http:`,
`https:`, and `mailto:` are allowed (case-insensitively), so a `<javascript:...|label>` token
renders as plain text instead of a live anchor (see `safeHref` in `ui/src/lib/api.ts`).
Emphasis is the outer parse and its inner content is recursed, so a mention, link, or emoji
inside `*bold*`/`_italic_`/`~strike~` is both resolved and styled (e.g. `*<url|label>*` → a
bold anchor). Known limitations: (1) emphasis does not nest within emphasis (single level);
(2) skin-tone modifier suffixes (e.g. `:wave::skin-tone-2:`) are not combined — each colon
token resolves independently.

### App unfurls (`is_app_unfurl`) and attachment Block Kit blocks

App integrations (Confluence, Jira, etc.) deliver link previews as attachments
flagged `is_app_unfurl: true`. Unlike web-link unfurls, these carry **no**
`title`/`text`/`service_name` — their content lives entirely in a Block Kit
`blocks[]` array on the attachment. slack-mini renders the following block types
(verified against a captured corpus; interactive blocks are shown as nothing
since slack-mini cannot execute Slack interactions):

| Block `type` | Fields used | Rendering |
|--------------|-------------|-----------|
| `section` | `text` (`{type: "mrkdwn"\|"plain_text", text}`), optional `accessory` (image) | mrkdwn via the shared renderer; accessory as a right-aligned thumbnail |
| `context` | `elements[]` of `image` and `mrkdwn`/`plain_text` | a dimmed row of small images + text |
| `header` | `text` (`plain_text`) | bold heading |
| `image` | `image_url`, `alt_text` | inline image |
| `divider` | — | horizontal rule |
| `rich_text` | `elements[]` (same as message rich_text) | delegated to the rich_text renderer |
| `actions`, `button`, `static_select`, other/unknown | — | **not rendered** (normalized to `"unsupported"`) |

Notes:
- `section.fields[]` was not observed in the corpus and is not modeled.
- Block/accessory/context image URLs are on **public CDNs** (e.g.
  `…public.atl-paas.net`), not the auth'd `files.slack.com`, so they load
  directly with a plain `<img src>` (no proxy), hidden on error.
- An attachment whose blocks are all `"unsupported"` renders nothing (the
  empty-card guard treats "no renderable block" the same as "no content").

## `users.info` — resolve authors & mentions

Param: `user` (one ID per call — no batch endpoint; cache aggressively). Returns `user` with:

- `real_name`
- `profile.display_name` (may be empty; fall back to `real_name`)
- `profile.image_24|32|48|72|192|512|1024|original` — avatar URLs on
  `avatars.slack-edge.com`. `image_72` is a good default.

## `emoji.list` — resolve custom emoji

No params. Returns `emoji`: a `name → URL` map (URLs on `emoji.slack-edge.com`). The Red Hat
workspace had ~22,700 entries. Some values are **aliases**: `"alias:other-name"` — deref one
level to the target name's URL. Fetch once and cache for the process; it's large.

## `subscriptions.thread.mark` — mark a thread read

```
POST /api/subscriptions.thread.mark
channel={C…}&thread_ts={root ts}&ts={latest message ts}&read=1
→ {"ok": true}
```

Use `latest_reply` (from the parent message) as `ts` to mark the whole thread read.
slack-mini only calls this on an explicit user click — **it never auto-marks**, because as
our own client we simply don't fire it otherwise. (Contrast: the sensible-slack-extension
had to *intercept and suppress* Slack's own auto-mark calls — see
`sensible-slack-extension/docs/reverse-engineering/thread-read-control.md`.)

**Marking unread:** the same endpoint with `read=0` (same `channel`/`thread_ts`/`ts`) marks
the thread **unread from `ts`** for the current user — it sets `last_read` to just before
`ts`. Verified 2026-08-11 against the self-channel test thread.

## `chat.postMessage` — post a threaded reply

```
POST /api/chat.postMessage
channel={C…}&thread_ts={root ts}&text={reply text}
→ {"ok": true, "ts": "{new message ts}", "message": {"ts": "...", "user": "U…", "text": "...",
   "thread_ts": "...", "blocks": [...], "type": "message", ...}}
```

Form-encoded, same as every other call through the `call()` helper — no JSON body needed.
The response's top-level `ts` duplicates `message.ts`. The `message` object has the **same
shape** as a message entry in `conversations.replies` (`ts`/`user`/`text`/`thread_ts`/`blocks`),
so it can be decoded into the same raw message struct and normalized with the same per-message
logic used for thread messages. Auth/other errors surface via the standard `ok:false` +
`error` field (`invalid_auth`, etc.), handled by `call()` like any other method. Verified
2026-08-11 against the self-channel test thread.

## Real-time updates

slack-mini v1 uses **server-side polling** of `conversations.replies` (~5–10s per subscribed
thread) rather than Slack's real-time WebSocket. The WS flow for session tokens is
undocumented and fragile; polling is simple and robust. Change detection is a cheap
signature over `(ts, reaction count, edited)` per message. Revisit if latency matters.

## Slack archive URL format

Thread/message permalinks encode the timestamp by removing the dot:

```
https://redhat-internal.slack.com/archives/C0EXAMPLE2/p1700000000000009
  → channel C0EXAMPLE2, ts 1700000000.000009   (dot before the last 6 digits)

…/p1700000000000009?thread_ts=1700000000.000005&cid=C0EXAMPLE2
  → thread root ts 1700000000.000005, reply ts 1700000000.000009
```

To build an "Open in Slack" deep link:
`https://{workspace}.slack.com/archives/{channel}/p{ts-without-dot}?thread_ts={threadTs}&cid={channel}`.

## What is NOT covered yet (future findings go here)

- File/image attachment and link-unfurl block shapes (v3).
- Non-`rich_text` block types (`section`, `context`, `actions`, `image`) (v3).
- Slack's real-time WebSocket protocol for session tokens (not used; document if adopted).

## Related prior work (in the sibling sensible-slack-extension repo)

- `docs/reverse-engineering/navigation.md` — driving Slack's SPA navigation (webpack module
  discovery, Redux thunks, `openThread`) to open a specific thread/reply in the real client.
- `docs/reverse-engineering/thread-read-control.md` — how Slack auto-marks threads read and
  how to intercept it at the XHR layer.
