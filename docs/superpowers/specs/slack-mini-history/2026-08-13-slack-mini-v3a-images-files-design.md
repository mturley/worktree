# slack-mini v3a — Images & Files

**Date:** 2026-08-13
**Status:** Approved (brainstorming complete)
**Part of:** v3 (full-fidelity rendering), decomposed into sub-phases. This is v3a.
**Builds on:** v1/v2. See prior specs in `docs/superpowers/specs/` and the RE doc
`docs/reverse-engineering/slack-web-api.md`.

## Purpose

Render file and image uploads that appear in Slack threads. Today slack-mini only
renders a message's `blocks` (rich_text) and drops the `files` array entirely, so any
uploaded image or document is invisible. v3a makes images show inline (with a full-size
modal) and non-image files show as cards linking to Slack.

## v3 roadmap (context; each sub-phase is its own spec/plan/build/verify)

- **v3a (this spec)** — Images & files.
- **v3b** — Link unfurls: web link previews AND Slack thread unfurls (thread unfurls
  include a button to open that thread as a new slack-mini tab, via the existing
  parseThreadUrl/tab machinery).
- **v3c** — Block Kit blocks (`header`/`section`/`actions`/`context`/`image`/`divider`) +
  a shared mrkdwn renderer (Block Kit `section` text is an mrkdwn string, unlike rich_text).
- **v3d** — Core ↔ full-fidelity settings toggle.

## Corpus grounding

Real payload shapes were inventoried read-only across the user's channels (structure only;
NO real content is copied). Findings for v3a: a message's `files[]` entries have `id`,
`name`, `title`, `mimetype` (e.g. `image/png`), `filetype`/`pretty_type`, `size`,
`permalink`, `url_private`, and for images `original_w`/`original_h` plus thumbnails
`thumb_64..thumb_800` (each with `_w`/`_h`). `url_private` and `thumb_*` are hosted on
`files.slack.com` and are **auth'd** — fetching them requires the `d=` session cookie.

**Fixtures MUST be hand-constructed synthetic data** (fake IDs/URLs/names, no real people,
topics, or content), following v1's `testdata/replies.json` discipline — do not commit
captured real payloads.

## Backend (`slackapi` + `server`)

### Capture files into the domain model

- Add a domain `File` struct (in `internal/slackapi/types.go`):
  - `ID string`, `Name string`, `Title string`, `Mimetype string`, `Filetype string`,
    `PrettyType string`, `Size int`, `Permalink string`, `URLPrivate string`,
    `Thumb360 string`, `Thumb360W int`, `Thumb360H int`, `Thumb720 string`,
    `OriginalW int`, `OriginalH int`, `IsImage bool`.
  - `IsImage` is derived during normalization: `strings.HasPrefix(mimetype, "image/")`.
- Add `Files []File` to the domain `Message`.
- Add a raw `files` struct to the raw message shape and map it in `normalizeMessage`
  (the shared helper used by both `NormalizeThread` and `PostReply`), so thread messages
  AND posted replies carry files consistently. Missing/absent fields default to zero
  values; a message with no files gets `Files: nil`.
- `MessageView` embeds `slackapi.Message`, so `Files` flows into the JSON automatically
  with PascalCase keys (matching the established wire convention: top-level camelCase,
  embedded Message fields PascalCase).

### New `/api/file` image proxy

- `GET /api/file?url=<encoded>`: mirrors the existing `handleImageProxy` hardening but for
  a new host.
  - Allowlist host **exactly** `files.slack.com`; reject any other host with 400 **before**
    any outbound request (SSRF prevention), same as the avatar/emoji proxies.
  - Require `https` scheme.
  - Forward the `d=<cookie>` on the outbound request (unlike avatar/emoji, `url_private`
    and `thumb_*` require auth).
  - No-redirect policy (`CheckRedirect` returns `http.ErrUseLastResponse` or errors), so a
    redirect can't escape the allowlisted host.
  - Stream the response back with its Content-Type.
- Register the route in `server.go`. Preferred implementation: parameterize the existing
  `handleImageProxy` factory with a "forward cookie" boolean (avatar/emoji pass false,
  `/api/file` passes true) so the allowlist/scheme/no-redirect/streaming logic stays in one
  place and the only difference is whether the `d=` cookie is attached. Keep the SSRF
  protections byte-for-byte identical across all three proxy endpoints.

## Frontend (React + Mantine)

### Types

- Add a `File` interface to `ui/src/lib/api.ts` matching the Go `File` fields (PascalCase),
  and `Files: File[] | null` on `Message`.
- Add `fileProxy(url: string): string` → `/api/file?url=${encodeURIComponent(url)}`
  (alongside the existing `avatarProxy`/`emojiProxy`).

### Rendering

- New component `ui/src/components/FileAttachments.tsx` taking `files: File[]`, rendered by
  `Message.tsx` below the message body (after the RichText/blocks, near reactions). Keeping
  it separate keeps `Message.tsx` focused.
- **Image files** (`IsImage`): a bounded inline **thumbnail** sourced from `Thumb360` (or
  `Thumb720` for crispness) through `fileProxy`, constrained to a sensible max (e.g.
  max-width ~360px, max-height ~300px) preserving aspect ratio using `Thumb360W/H` (or
  `OriginalW/H`). Clicking opens a **Mantine `Modal` lightbox** showing the full image
  (`URLPrivate` via `fileProxy`). Multiple images lay out as a wrapped row/grid. The modal
  state lives in `FileAttachments` (or a small `ImageLightbox`).
- **Non-image files:** a compact **file card** — a filetype label (`PrettyType` or
  `Filetype`) or a generic file icon, the `Name`, and a human-readable `Size`. The whole
  card is a link opening the file's Slack `Permalink` in a new tab
  (`target="_blank" rel="noreferrer"`), where Slack handles preview/download with the
  user's session. (No file content beyond images is proxied.)

## Error handling

- A broken/expired image (proxy returns 4xx, or `<img>` onError) falls back to the
  non-image file card (filename) instead of a broken image icon.
- Missing `Thumb360` falls back to `URLPrivate` (proxied) for the inline image.
- A file with no `Permalink` still renders the card, just non-clickable.
- The `/api/file` proxy returns 400 for non-allowlisted hosts and does not fetch them.

## Testing

- **Go:** `normalizeMessage` captures files from a hand-built synthetic fixture containing
  one image file (mimetype `image/png`, thumbs, dimensions) and one non-image file
  (e.g. `application/pdf`), asserting `IsImage` derivation, thumbnails, size, permalink.
  `/api/file` proxy tests: a foreign host → 400 with no outbound fetch; a `files.slack.com`
  URL is accepted (served via a fake/httptest transport); non-https → 400.
- **Frontend:** `FileAttachments` tests — an image file renders an `<img>` whose src goes
  through `/api/file`, and clicking it opens the modal (full image, also proxied); a
  non-image file renders a card with name + size linking to the `Permalink`; an image
  `onError` falls back to the filename card.
- **Live verification (read-only):** against real threads in the user's channels that have
  image and file uploads — confirm inline thumbnails load, the modal opens the full image,
  and file cards open the Slack permalink. Never post anything.

## Non-goals (v3a)

- No web link unfurls or Slack thread unfurls (v3b).
- No Block Kit blocks or mrkdwn renderer (v3c).
- No core/full fidelity toggle (v3d).
- No file *uploading* (sending files/images) — v3a is display-only.
- No inline video/audio playback — such files render as cards/permalinks.

## RE doc updates (deliverable)

Update `docs/reverse-engineering/slack-web-api.md` with the `files[]` message field shape
(image vs non-image, thumb_* + dimensions, url_private/permalink) and the note that
`url_private`/`thumb_*` are on `files.slack.com` and require the `d=` cookie (hence the
`/api/file` proxy forwards it, unlike the avatar/emoji proxies).
