# slack-mini v3b — Link & Thread Unfurls

**Date:** 2026-08-13
**Status:** Approved (brainstorming complete)
**Part of:** v3 (full-fidelity rendering), decomposed into sub-phases. This is v3b.
**Builds on:** v1/v2/v3a. See prior specs in `docs/superpowers/specs/` and the RE doc.

## Purpose

Render Slack message `attachments` — the link previews ("unfurls") Slack generates for
URLs. Two kinds matter for slack-mini's use: **web link unfurls** (GitHub PRs, Jira issues,
articles) and **Slack thread unfurls** (a pasted link to another thread). Today slack-mini
renders `blocks` and `files` but drops `attachments` entirely, so these previews are
invisible. Thread unfurls additionally get an "Open thread" button that opens the linked
thread as a slack-mini tab.

## v3 roadmap (updated; each sub-phase is its own spec/plan/build/verify)

- ✅ **v3a** — Images & files.
- **v3b (this spec)** — Link & thread unfurls.
- **v3c** — Shared **mrkdwn renderer** (parse Slack mrkdwn strings: `<@U>`, `<!subteam^…>`,
  `<url|label>`, `:emoji:`, `*bold*`/`_italic_`/`~strike~`/`` `code` ``). Reused by unfurl
  text, the message `text` fallback, and (v3d) Block Kit `section` text.
- **v3d** — Block Kit blocks (`header`/`section`/`actions`/`context`/`image`/`divider`),
  built on the v3c mrkdwn renderer.
- **v3e** — Core ↔ full-fidelity settings toggle.

## Corpus grounding

Real attachment shapes were inventoried read-only (structure only; NO real content copied):
- **Web link unfurl:** `title`, `title_link`, `text` (contains Slack mrkdwn), `service_name`,
  `service_icon`, `footer`, `footer_icon`, `color` (hex — a left-border accent), optional
  `image_url`/`thumb_url` with `image_width`/`image_height`. Preview images are on
  non-Slack CDNs (e.g. `github.com/user-attachments/…`).
- **Thread unfurl:** `is_msg_unfurl`/`is_reply_unfurl` true, `from_url` (a Slack archive URL,
  parseable to channel+thread_ts), `author_name`, `text`, `channel_id`, `ts`, `footer`
  ("Thread in Slack Conversation").
- A message can have multiple attachments.

**Fixtures MUST be hand-built synthetic** (fake IDs/URLs/names/content), per the
`testdata/replies.json` discipline.

## Backend (`slackapi` + `server`)

- Add a domain `Attachment` struct (in `internal/slackapi/types.go`) with exported fields:
  `Title`, `TitleLink`, `Text`, `ServiceName`, `ServiceIcon`, `Footer`, `FooterIcon`,
  `Color` (hex string, no `#`), `ImageURL`, `ThumbURL`, `ImageWidth int`, `ImageHeight int`,
  `AuthorName`, `IsMsgUnfurl bool`, `IsReplyUnfurl bool`, `FromURL`, `ChannelID`,
  and derived `IsThreadUnfurl bool` (= `IsMsgUnfurl || IsReplyUnfurl`).
- Add `Attachments []Attachment` to the domain `Message`.
- Add a raw attachment struct + `Attachments []rawAttachment \`json:"attachments"\`` to
  `rawMessage`, and map them in the shared `normalizeMessage` (so both thread messages AND
  posted replies carry attachments). Empty raw slice → `Attachments` nil.
- `MessageView` embeds `slackapi.Message`, so `Attachments` flows to JSON automatically
  (PascalCase nested keys, per the established wire convention).
- No new endpoint. Unfurl preview images load directly from their CDN (see Frontend); text
  is escape-only. The Slack thread proxy is not needed here.

## Frontend (React + Mantine)

### Types

- Add an `Attachment` interface to `ui/src/lib/api.ts` matching the Go fields (PascalCase;
  `ImageWidth`/`ImageHeight` numbers, the `Is*` fields booleans), and
  `Attachments: Attachment[] | null` on `Message`.
- Add a small `unescapeSlackText(s: string): string` helper — unescape `&amp;`→`&`,
  `&lt;`→`<`, `&gt;`→`>`. It does NOT parse mrkdwn tokens (`<url|label>`, `<@U>` remain
  literal); the v3c mrkdwn renderer will supersede this for attachment text.

### Rendering

- New component `ui/src/components/Attachments.tsx`, rendered by `Message.tsx` after the
  body and files (near reactions). It maps each attachment to one of two sub-renders:
  - **Thread unfurl** (`IsThreadUnfurl`, or a parseable `FromURL`): a card showing
    `AuthorName` (if present), an escape-only `Text` preview, and an **"Open thread"**
    button. Behavior:
    - Plain click → open the linked thread as a **foreground** tab (add + switch).
    - **Cmd/Ctrl+click** → open as a **background** tab (add, do not switch) — browser-like.
    - The linked thread is derived by parsing `FromURL` with the existing `parseThreadUrl`.
      Wired through a new App-level `onOpenThread(url: string, opts: { background: boolean })`
      handler that reuses `addTabFromUrl`/`findTab` (dedup) and conditionally sets the active
      tab. If `FromURL` doesn't parse, still render the text card but disable/hide the button.
  - **Web link unfurl** (otherwise): a card with a **left-border color accent** (`Color`,
    prefixed with `#`, default a neutral border when empty). Shows `ServiceName` with its
    `ServiceIcon` favicon (loaded directly), `Title` as a link to `TitleLink`
    (`target="_blank" rel="noreferrer"`) or plain text if no link, the escape-only `Text`,
    the `Footer` (+`FooterIcon`), and a preview image from `ImageURL` (or `ThumbURL`)
    rendered **directly** (`<img src>` at the external URL — NO proxy), bounded to a
    reasonable max size using `ImageWidth`/`ImageHeight` when present, with an `onError` that
    hides the image.

### App wiring

- `App.tsx` gains `handleOpenThread(url, { background })`: parse via the tab machinery; if
  the thread isn't already a tab, add it (`addTabFromUrl`); if not background, set it active
  (foreground); if it already exists, switch to it on foreground / no-op selection on
  background. Pass `onOpenThread` down through `ThreadView` → `Message` → `Attachments`.

## Error handling

- External unfurl preview image fails to load → `onError` hides it (card still shows text).
- Thread unfurl with an unparseable `FromURL` → text card renders, "Open thread" hidden/
  disabled.
- Empty `Color` → neutral/default left border, not a broken `#` value.
- Missing `Title`/`ServiceName`/`Footer` fields simply omit those rows.

## Testing

- **Go:** `normalizeMessage` captures both attachment kinds from a hand-built synthetic
  fixture (one web unfurl with title/title_link/color/footer/image_url; one thread unfurl
  with is_reply_unfurl/from_url/author_name/text), asserting field mapping and
  `IsThreadUnfurl` derivation.
- **Frontend:** `Attachments` tests — a web unfurl renders the title linking to
  `TitleLink`, the color accent, footer, and a direct-src preview image that hides on
  `onError`; a thread unfurl renders "Open thread" and calls `onOpenThread` with the parsed
  URL and `{ background: false }` on plain click, `{ background: true }` on Cmd/Ctrl+click;
  an unparseable thread `FromURL` still renders the card without a working button. (Repo has
  no jest-dom; use plain assertions + `afterEach(cleanup)`.)
- **App-level:** unit-test the `handleOpenThread` logic (extract a pure helper if practical:
  given tabs + url + background, returns new tabs + next active id) — foreground adds+selects,
  background adds without selecting, existing thread dedups.
- **Live verification (read-only):** against real threads with GitHub/Jira web unfurls and
  a Slack thread unfurl — confirm web unfurl cards render (color accent, title link, preview
  image), and the thread unfurl's "Open thread" opens a foreground tab (and Cmd/Ctrl+click a
  background tab). Never post anything.

## Non-goals (v3b)

- No mrkdwn rendering of unfurl `text`/`footer` (escape-only; v3c does it properly).
- No Block Kit blocks (v3d), no fidelity toggle (v3e).
- No proxying of external unfurl images (they load directly; Slack-hosted images continue
  via the v3a `/api/file`/avatar/emoji proxies where applicable).
- No rendering of attachments that carry their own `blocks[]` as rich Block Kit — those
  fall back to the attachment's `text`/`title` for now (full Block-Kit-in-attachment is v3d
  territory).

## RE doc updates (deliverable)

Update `docs/reverse-engineering/slack-web-api.md` with the message `attachments[]` shapes:
web link unfurl fields (title/title_link/text/service_*/footer_*/color/image_*) and thread
unfurl fields (is_msg_unfurl/is_reply_unfurl/from_url/author_name/channel_id), noting that
attachment `text` is mrkdwn and unfurl preview images are on external CDNs (not proxied).
