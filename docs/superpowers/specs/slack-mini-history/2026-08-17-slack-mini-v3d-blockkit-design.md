# slack-mini v3d — Block Kit rendering in attachments

**Date:** 2026-08-17
**Status:** Design approved (pending spec review)
**Depends on:** v3c (shared inline mrkdwn renderer, `ui/src/lib/mrkdwn.tsx`)

## Problem

App integrations (Confluence, Jira, etc.) deliver their link previews as legacy
`attachments[]` entries flagged `is_app_unfurl: true`. Unlike web-link unfurls, these
carry no `title`/`text`/`service_name`; their content lives entirely in a Block Kit
`blocks[]` array on the attachment. slack-mini does not model or render those blocks, so
these unfurls have no renderable content. The v3b empty-card guard (`hasContent` in
`WebUnfurlCard`) currently hides them — a deliberate stopgap until this phase.

v3d renders those attachment Block Kit blocks so Confluence/Jira previews show their real
content instead of being hidden.

## Corpus evidence

Verified against a captured corpus of 300 real messages (3 channels; structure only,
fixtures are hand-built synthetic per the project rule):

- Top-level Block Kit blocks are rare: across 300 messages, `rich_text` dominates
  (already rendered by `RichText`); only 1 `header`, 1 `section`, 1 `actions` appeared at
  the message top level.
- Block Kit **inside attachments** is common: 85 attachments carry `blocks[]`, 46 are
  `is_app_unfurl`.
- Block types observed inside app-unfurl attachments: `section` (25), `rich_text` (14),
  `context` (2), `actions` (2, interactive).
- Every `section` used `text.type: "mrkdwn"`; 9 of 25 sections had an `accessory` (image
  thumbnail); **no** section used `fields[]`.
- `context` elements were `image` and `mrkdwn`. `actions` elements were `button` and
  `static_select` (interactive).
- Block/accessory/context image URLs are on **public CDNs** (e.g.
  `avatar-management--avatars…public.atl-paas.net`), **not** the auth'd `files.slack.com`.

## Scope

**In scope — render this "core set":**
- `section` — `text` (mrkdwn or plain_text) + optional image `accessory` (thumbnail).
- `context` — a row of small `image` and `mrkdwn`/`plain_text` elements.
- `header` — `plain_text`, rendered bold/larger.
- `image` — standalone image block (`image_url`, `alt_text`).
- `divider` — horizontal rule.
- `rich_text` — delegate to the existing `RichText` renderer (no new logic).

**Out of scope — graceful skip (render nothing):**
- Interactive blocks and elements: `actions`, `button`, `static_select`, `input`, any
  block/element type not in the core set. These normalize to `unsupported` and render
  nothing. slack-mini cannot execute Slack interactions, so dead controls are avoided.
- `section.fields[]` (unused in the corpus). Not modeled; can be added if it appears.

## Architecture

Decision (approved): a **new `BlockKit` component** that delegates `rich_text` blocks to
the existing `RichText`, rather than growing `RichText` into a Block Kit grab-bag.
`RichText` stays rich_text-only; `BlockKit` owns Block Kit. Section/context mrkdwn text
flows through the v3c `Mrkdwn` renderer (so mentions/links/emoji/styling and `safeHref`
sanitization all apply for free).

### Data model (Go — `internal/slackapi/types.go`)

Raw:
- Add `Blocks []rawBlockKit` (json `blocks`) to `rawAttachment`.
- `rawBlockKit` models the superset of fields the core set needs: `type`, `text`
  (a text object `{type, text}`), `elements` (for context), `accessory` (a block element),
  `image_url`, `alt_text`. Interactive fields are not modeled.

Domain:
- Add `Blocks []BlockKit` to `Attachment`.
- `BlockKit`:
  - `Type string` — one of `section | context | image | divider | header | rich_text | unsupported`.
  - `Text *TextObject` — for section/header. `TextObject{Type string; Text string}`
    (`Type` is `mrkdwn` or `plain_text`).
  - `Elements []BlockElement` — for context.
  - `Accessory *BlockElement` — for section.
  - `ImageURL string`, `AltText string` — for standalone `image` blocks.
  - `RichText []Block` — populated only when `Type == "rich_text"`; the normalized
    rich_text groups (reuses the existing `Block`/`Element` types).
- `BlockElement`:
  - `Type string` — `image` | `mrkdwn` | `plain_text`.
  - `ImageURL string`, `AltText string` — for image elements/accessories.
  - `Text string` — for mrkdwn/plain_text elements.

Normalization:
- `normalizeAttachment` gains block normalization. Each raw block maps by `type` to the
  domain `BlockKit`; unknown/interactive types → `Type: "unsupported"`.
- The existing rich_text block normalizer (currently inside the message-block path) is
  factored into a shared helper so a `rich_text` block is normalized identically whether it
  appears at the message top level or inside an attachment. This shared helper is the single
  source of truth for rich_text → `[]Block`.

Wire: `Attachment` embeds into `Message` with PascalCase field names (no json tags), so the
frontend receives `attachment.Blocks` automatically, consistent with the existing
convention. TS types in `ui/src/lib/api.ts` are extended to match (`BlockKit`,
`TextObject`, `BlockElement`, and `Attachment.Blocks`).

### React (`ui/src/components/BlockKit.tsx`)

`<BlockKit blocks={BlockKit[]} users={Record<string,User>} emoji={Record<string,string>} />`
maps each block by `Type`:

- `section` — render `Text` via `<Mrkdwn>` (mrkdwn) or plain text (plain_text). If
  `Accessory` is an image, lay it to the right as a fixed-width thumbnail (`<img>`, direct
  src, hide-on-error). Text flex-grows.
- `context` — a horizontal `Group` of small elements: `image` → tiny `<img>` (~18px);
  `mrkdwn`/`plain_text` → dimmed small text via `<Mrkdwn>`.
- `header` — `Text fw={700}` (larger).
- `image` — standalone `<img>` (maxWidth ~360, hide-on-error), `alt={AltText}`.
- `divider` — Mantine `<Divider />`.
- `rich_text` — delegate to `<RichText blocks={block.RichText} users={users} emoji={emoji} />`.
- `unsupported` — render nothing.

Image loading reuses the v3b pattern: direct `<img src>` (block images are on public CDNs),
per-image `onError` state that hides the broken image. No proxy host is added.

### Integration (`ui/src/components/Attachments.tsx`)

- Extend `WebUnfurlCard`'s `hasContent` guard so an attachment with ≥1 **renderable**
  (non-`unsupported`) block counts as content and renders. An attachment whose blocks are
  all `unsupported` stays hidden — this preserves the v3b empty-card fix (no reintroduced
  empty bordered cards).
- Inside `WebUnfurlCard`, render the existing chrome (service/title/text/footer) as today,
  then render `<BlockKit blocks={attachment.Blocks} … />` below. App-unfurls are
  blocks-only in practice, so the card becomes "left-border color accent + BlockKit
  content" — the correct Confluence/Jira look. The `borderColor` left accent still applies.
- `ThreadUnfurlCard` (the `is_msg_unfurl`/`from_url` path) is unchanged; app-unfurls are not
  thread unfurls.
- `users`/`emoji` are already threaded into `Attachments` → cards (v3c), so `BlockKit`
  receives them.

## Error handling / degenerate states

- Attachment with no blocks: `Blocks` is empty/nil; behavior unchanged from v3c.
- Attachment with only `unsupported` blocks: card stays hidden (guard checks for a
  renderable block).
- Broken image URL (accessory/context/image): that image hides on error; surrounding
  content still renders (per-image error state).
- Unknown block or element type: normalized to `unsupported` / skipped; never crashes.
- Malformed text object (missing `text`): renders empty, no crash.
- mrkdwn inside a section: sanitized by v3c (`safeHref`), so a `javascript:` link renders as
  plain text, not a live anchor.

## Testing

**Go:** hand-built synthetic fixture `internal/slackapi/testdata/attachment_blocks.json`
(a `conversations.replies`-shaped response; a message with one `is_app_unfurl` attachment
carrying `section` (mrkdwn + image accessory), `context` (image + mrkdwn), `rich_text`,
`divider`, and one interactive `actions`/`static_select` block). No real content, names, or
URLs. Table tests on normalization assert: correct type mapping, section text + accessory
captured, rich_text-in-attachment normalizes to the same `[]Block` as a top-level rich_text
block (shared helper), and interactive → `unsupported`.

**Frontend (`ui/src/components/BlockKit.test.tsx`):** project conventions — no jest-dom,
`afterEach(cleanup)`, `matchMedia` stub, `MantineProvider` wrapper. Cases: section mrkdwn
renders (mention → `@Name`, `:emoji:`, `*bold*`) and accessory image present + hides on
error; context renders image + dimmed text; header bold; divider renders; standalone image
with alt; rich_text block delegates to `RichText`; `unsupported` renders nothing.
`Attachments.test.tsx`: an app-unfurl with only blocks now renders (not hidden); an
app-unfurl with only `unsupported` blocks stays hidden.

**Verification:** `make test` (Go + frontend), `npm run build`, `go build ./...`, then a
read-only Playwright live check against the real Confluence/Jira thread
(`p1786721890599109`) confirming the previously-empty cards now show content.

## Documentation

Update `docs/reverse-engineering/slack-web-api.md`: replace the current "deferred to v3d"
note with a subsection documenting the verified `is_app_unfurl` attachment block shapes
(section `{text:{type:mrkdwn}, accessory?:image}`, context `{elements:[image|mrkdwn]}`,
`rich_text`, `divider`, `image`, `header`), that `fields[]` was unused in the corpus, that
interactive blocks (`actions`/`button`/`static_select`) are rendered as nothing, and that
block image URLs are on public CDNs (loaded direct, no proxy).

## Follow-ups (not in v3d)

- **v3e** — core ↔ full fidelity settings toggle.
- `section.fields[]` and interactive-block rendering, if they turn out to matter in
  practice.
