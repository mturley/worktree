# slack-mini v3d — Block Kit rendering in attachments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Block Kit blocks carried inside `is_app_unfurl` attachments (Confluence/Jira link previews) so they show real content instead of being hidden.

**Architecture:** Add a `Blocks` field to the Go domain `Attachment` and normalize the attachment's Block Kit `blocks[]` (reusing the existing rich_text normalizer via a shared helper; interactive/unknown blocks become `"unsupported"`). Add a new `ui/src/components/BlockKit.tsx` React component that renders the core block set (section/context/header/image/divider) and delegates `rich_text` blocks to the existing `RichText`; section/context mrkdwn text flows through the v3c `Mrkdwn` renderer. Wire it into `WebUnfurlCard` in `Attachments.tsx`, extending the empty-card guard so an attachment renders iff it has renderable (non-`unsupported`) blocks.

**Tech Stack:** Go (stdlib `encoding/json`), React 18 + TypeScript + Vite + Mantine v7, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-17-slack-mini-v3d-blockkit-design.md`

## Global Constraints

- Domain structs live in `internal/slackapi`; `slackapi` returns domain types, never raw Slack JSON. All Slack payload quirks are contained there.
- Wire format: `ThreadResponse` top-level keys are camelCase (explicit json tags in `internal/server/server.go`); embedded `slackapi.Message` and its nested structs (incl. `Attachment`) serialize with **PascalCase** Go field names (no json tags). TS interfaces in `ui/src/lib/api.ts` MUST use PascalCase for these nested fields.
- Go nil slices and nil pointers marshal to JSON `null` (Go has no `omitempty` on these structs). New TS array/object fields MUST be typed nullable (`| null`) and guarded at use sites.
- `normalizeMessage` is the SINGLE per-message raw→domain mapper, used by both `NormalizeThread` and `PostReply`. Add new attachment fields there so replies get them too.
- Test fixtures under `internal/slackapi/testdata/` MUST be hand-built synthetic — no real Slack content (names, message text, URLs) and no secrets.
- Frontend tests: NO jest-dom matchers; plain assertions only. Each test file uses `afterEach(cleanup)` and a `window.matchMedia` stub, and renders through `MantineProvider`. Copy the pattern from `ui/src/components/Attachments.test.tsx`.
- Render mrkdwn text via the v3c `Mrkdwn` component (`ui/src/lib/mrkdwn.tsx`); link hrefs are already `safeHref`-sanitized there. Never introduce a second mrkdwn parser.
- Commits: conventional-commit prefixes, `--signoff`, and end each message with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Run `make test` (Go + frontend) before the final commit.

## File Structure

- `internal/slackapi/types.go` — MODIFY: add `rawBlockKit`, `rawTextObject`, `rawBlockElement` raw structs + `rawAttachment.Blocks`; add `BlockKit`, `TextObject`, `BlockElement` domain types + `Attachment.Blocks`.
- `internal/slackapi/normalize.go` — MODIFY: factor rich_text normalization into `normalizeRichTextBlocks`; add `normalizeBlockKit`; populate `Attachment.Blocks` in `normalizeMessage`.
- `internal/slackapi/normalize_test.go` (or existing test file) — MODIFY/ADD: table tests for block normalization.
- `internal/slackapi/testdata/attachment_blocks.json` — CREATE: synthetic fixture.
- `ui/src/lib/api.ts` — MODIFY: add `TextObject`, `BlockElement`, `BlockKit` interfaces + `Attachment.Blocks`.
- `ui/src/components/BlockKit.tsx` — CREATE: the renderer.
- `ui/src/components/BlockKit.test.tsx` — CREATE: component tests.
- `ui/src/components/Attachments.tsx` — MODIFY: extend `hasContent`; render `<BlockKit>` in `WebUnfurlCard`; add a `hasRenderableBlocks` helper.
- `ui/src/components/Attachments.test.tsx` — MODIFY: add blocks-render / all-unsupported-hidden cases.
- `docs/reverse-engineering/slack-web-api.md` — MODIFY: document `is_app_unfurl` block shapes.

---

## Task 1: Go domain + raw types for attachment Block Kit

**Files:**
- Modify: `internal/slackapi/types.go`

**Interfaces:**
- Consumes: existing `Block`, `Element` domain types; existing `rawAttachment`.
- Produces:
  - Raw: `rawTextObject{Type string; Text string}` (json `type`,`text`); `rawBlockElement{Type string; Text *rawTextObject; ImageURL string; AltText string}` (json `type`,`text`,`image_url`,`alt_text`); `rawBlockKit{Type string; BlockID string; Text *rawTextObject; Elements []rawBlockElement; Accessory *rawBlockElement; ImageURL string; AltText string; RichTextElements []rawElemGrp}` — where `RichTextElements` maps json `elements` for a `rich_text` block. **Problem:** `elements` is used by BOTH `context` (array of block elements) and `rich_text` (array of rich_text groups). Model `context` elements from `Elements []rawBlockElement` and rich_text groups by re-decoding — see Step 2 note; simplest is to give `rawBlockKit` a single `Elements json.RawMessage` and decode per-type in normalize. Use `json.RawMessage` for `Elements`.
  - Domain: `TextObject{Type string; Text string}`; `BlockElement{Type string; ImageURL string; AltText string; Text string}`; `BlockKit{Type string; Text *TextObject; Elements []BlockElement; Accessory *BlockElement; ImageURL string; AltText string; RichText []Block}`; add `Blocks []BlockKit` to `Attachment`.

- [ ] **Step 1: Add raw structs to `internal/slackapi/types.go`**

Add after `rawAttachment` (and add `"encoding/json"` import if not present — it is not currently imported in types.go, so add it):

```go
type rawTextObject struct {
	Type string `json:"type"` // "mrkdwn" | "plain_text"
	Text string `json:"text"`
}

type rawBlockElement struct {
	Type     string         `json:"type"` // "image" | "mrkdwn" | "plain_text" | (interactive)
	Text     string         `json:"text"` // for mrkdwn/plain_text elements
	ImageURL string         `json:"image_url"`
	AltText  string         `json:"alt_text"`
}

// rawBlockKit models a Block Kit block carried inside an attachment. `elements`
// is decoded per-type in normalize: for "context" it is []rawBlockElement, for
// "rich_text" it is []rawElemGrp (the same rich_text groups as message blocks).
type rawBlockKit struct {
	Type      string          `json:"type"`
	Text      *rawTextObject  `json:"text"`      // section/header
	Accessory *rawBlockElement `json:"accessory"` // section
	ImageURL  string          `json:"image_url"` // image block
	AltText   string          `json:"alt_text"`  // image block
	Elements  json.RawMessage `json:"elements"`  // context: []rawBlockElement; rich_text: []rawElemGrp
}
```

Then add `Blocks []rawBlockKit` to `rawAttachment` (json `blocks`):

```go
	FromURL       string `json:"from_url"`
	ChannelID     string `json:"channel_id"`
	Blocks        []rawBlockKit `json:"blocks"`
}
```

- [ ] **Step 2: Add domain structs to `internal/slackapi/types.go`**

Add after the `Attachment` struct:

```go
// TextObject is a Block Kit text object ({type: mrkdwn|plain_text, text}).
type TextObject struct {
	Type string // "mrkdwn" | "plain_text"
	Text string
}

// BlockElement is a leaf inside a context block or a section accessory: an
// image, or an mrkdwn/plain_text text element.
type BlockElement struct {
	Type     string // "image" | "mrkdwn" | "plain_text"
	ImageURL string // image
	AltText  string // image
	Text     string // mrkdwn/plain_text
}

// BlockKit is one normalized Block Kit block carried inside an attachment
// (e.g. a Confluence/Jira is_app_unfurl preview). Type is one of:
// "section" | "context" | "image" | "divider" | "header" | "rich_text" |
// "unsupported". Interactive/unknown blocks normalize to "unsupported" and
// render nothing.
type BlockKit struct {
	Type      string        // see above
	Text      *TextObject   // section/header
	Elements  []BlockElement // context
	Accessory *BlockElement // section
	ImageURL  string        // image
	AltText   string        // image
	RichText  []Block       // rich_text: normalized rich_text groups
}
```

Then add `Blocks []BlockKit` to the `Attachment` struct (after `IsThreadUnfurl`):

```go
	IsThreadUnfurl bool // derived: IsMsgUnfurl || IsReplyUnfurl
	Blocks         []BlockKit
}
```

- [ ] **Step 3: Verify it compiles**

Run: `go build ./...`
Expected: builds cleanly (no usages yet).

- [ ] **Step 4: Commit**

```bash
git add internal/slackapi/types.go
git commit --signoff -m "feat(slackapi): add domain types for attachment Block Kit blocks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Factor the shared rich_text normalizer

**Files:**
- Modify: `internal/slackapi/normalize.go`
- Test: `internal/slackapi/normalize_test.go` (create if absent)

**Interfaces:**
- Consumes: existing `rawBlock`, `normalizeLeaves`.
- Produces: `func normalizeRichTextBlocks(raw []rawBlock) []Block` — normalizes a slice of raw blocks, keeping only `rich_text` blocks, into domain `[]Block` (section/quote/preformatted/list). `normalizeMessage` now calls this for `m.Blocks`.

- [ ] **Step 1: Write the failing test**

Add to `internal/slackapi/normalize_test.go` (create the file with `package slackapi` + imports if it doesn't exist):

```go
func TestNormalizeRichTextBlocks_SectionAndList(t *testing.T) {
	raw := []rawBlock{{
		Type: "rich_text",
		Elements: []rawElemGrp{
			{Type: "rich_text_section", Elements: []rawElement{{Type: "text", Text: "hi"}}},
			{Type: "rich_text_list", Style: "bullet", Indent: 0, Elements: []rawElement{
				{Type: "rich_text_section", Elements: []rawElement{{Type: "text", Text: "one"}}},
			}},
		},
	}}
	got := normalizeRichTextBlocks(raw)
	if len(got) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(got))
	}
	if got[0].Type != "section" || len(got[0].Elements) != 1 || got[0].Elements[0].Text != "hi" {
		t.Errorf("section block wrong: %+v", got[0])
	}
	if got[1].Type != "list" || got[1].Style != "bullet" || len(got[1].Items) != 1 || got[1].Items[0][0].Text != "one" {
		t.Errorf("list block wrong: %+v", got[1])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/slackapi/ -run TestNormalizeRichTextBlocks_SectionAndList`
Expected: FAIL — `undefined: normalizeRichTextBlocks`.

- [ ] **Step 3: Extract the function**

In `internal/slackapi/normalize.go`, add:

```go
// normalizeRichTextBlocks converts a slice of raw blocks into domain Blocks,
// keeping only "rich_text" blocks (section/quote/preformatted/list). Shared by
// message-level blocks and rich_text blocks carried inside an attachment.
func normalizeRichTextBlocks(raw []rawBlock) []Block {
	var out []Block
	for _, b := range raw {
		if b.Type != "rich_text" {
			continue
		}
		for _, grp := range b.Elements {
			switch grp.Type {
			case "rich_text_section":
				out = append(out, Block{Type: "section", Elements: normalizeLeaves(grp.Elements)})
			case "rich_text_quote":
				out = append(out, Block{Type: "quote", Elements: normalizeLeaves(grp.Elements)})
			case "rich_text_preformatted":
				out = append(out, Block{Type: "preformatted", Elements: normalizeLeaves(grp.Elements)})
			case "rich_text_list":
				var items [][]Element
				for _, item := range grp.Elements {
					items = append(items, normalizeLeaves(item.Elements))
				}
				out = append(out, Block{Type: "list", Style: grp.Style, Indent: grp.Indent, Items: items})
			default:
				// Unknown group type: skip rather than guess at its shape.
			}
		}
	}
	return out
}
```

Then replace the `for _, b := range m.Blocks { ... }` loop in `normalizeMessage` (the block-normalizing loop, currently lines ~30-52) with:

```go
	msg.Blocks = normalizeRichTextBlocks(m.Blocks)
```

- [ ] **Step 4: Run tests to verify pass**

Run: `go test ./internal/slackapi/`
Expected: PASS — the new test and all existing tests (behavior is unchanged; this is a pure refactor).

- [ ] **Step 5: Commit**

```bash
git add internal/slackapi/normalize.go internal/slackapi/normalize_test.go
git commit --signoff -m "refactor(slackapi): extract normalizeRichTextBlocks for reuse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Normalize attachment Block Kit blocks

**Files:**
- Modify: `internal/slackapi/normalize.go`
- Test: `internal/slackapi/normalize_test.go`

**Interfaces:**
- Consumes: `rawBlockKit`, `rawBlockElement`, `rawTextObject`, `rawElemGrp`, `normalizeRichTextBlocks`, `normalizeLeaves`.
- Produces: `func normalizeBlockKit(raw []rawBlockKit) []BlockKit`. `normalizeMessage` populates `Attachment.Blocks` from `a.Blocks` via this function.

- [ ] **Step 1: Write the failing test**

Add to `internal/slackapi/normalize_test.go`:

```go
func TestNormalizeBlockKit_CoreTypesAndUnsupported(t *testing.T) {
	raw := []rawBlockKit{
		{Type: "section",
			Text:      &rawTextObject{Type: "mrkdwn", Text: "hello <@U1>"},
			Accessory: &rawBlockElement{Type: "image", ImageURL: "https://cdn.example/x.png", AltText: "thumb"}},
		{Type: "context", Elements: json.RawMessage(`[
			{"type":"image","image_url":"https://cdn.example/i.png","alt_text":"a"},
			{"type":"mrkdwn","text":"ctx *b*"}
		]`)},
		{Type: "rich_text", Elements: json.RawMessage(`[
			{"type":"rich_text_section","elements":[{"type":"text","text":"rt"}]}
		]`)},
		{Type: "divider"},
		{Type: "image", ImageURL: "https://cdn.example/big.png", AltText: "big"},
		{Type: "header", Text: &rawTextObject{Type: "plain_text", Text: "Title"}},
		{Type: "actions"}, // interactive → unsupported
	}
	got := normalizeBlockKit(raw)
	if len(got) != 7 {
		t.Fatalf("want 7 blocks, got %d", len(got))
	}
	if got[0].Type != "section" || got[0].Text == nil || got[0].Text.Text != "hello <@U1>" {
		t.Errorf("section text wrong: %+v", got[0])
	}
	if got[0].Accessory == nil || got[0].Accessory.Type != "image" || got[0].Accessory.ImageURL != "https://cdn.example/x.png" {
		t.Errorf("section accessory wrong: %+v", got[0].Accessory)
	}
	if got[1].Type != "context" || len(got[1].Elements) != 2 || got[1].Elements[0].Type != "image" || got[1].Elements[1].Text != "ctx *b*" {
		t.Errorf("context wrong: %+v", got[1])
	}
	if got[2].Type != "rich_text" || len(got[2].RichText) != 1 || got[2].RichText[0].Type != "section" || got[2].RichText[0].Elements[0].Text != "rt" {
		t.Errorf("rich_text wrong: %+v", got[2])
	}
	if got[3].Type != "divider" {
		t.Errorf("divider wrong: %+v", got[3])
	}
	if got[4].Type != "image" || got[4].ImageURL != "https://cdn.example/big.png" || got[4].AltText != "big" {
		t.Errorf("image wrong: %+v", got[4])
	}
	if got[5].Type != "header" || got[5].Text == nil || got[5].Text.Text != "Title" {
		t.Errorf("header wrong: %+v", got[5])
	}
	if got[6].Type != "unsupported" {
		t.Errorf("actions should be unsupported, got %q", got[6].Type)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/slackapi/ -run TestNormalizeBlockKit_CoreTypesAndUnsupported`
Expected: FAIL — `undefined: normalizeBlockKit`.

- [ ] **Step 3: Implement `normalizeBlockKit`**

In `internal/slackapi/normalize.go` (ensure `"encoding/json"` is imported):

```go
// normalizeBlockKit converts an attachment's raw Block Kit blocks into domain
// BlockKit values. Only the core set is modeled (section/context/image/
// divider/header/rich_text); interactive or unknown blocks become
// "unsupported" and render nothing. The `elements` field is decoded per-type
// because context uses block elements while rich_text uses rich_text groups.
func normalizeBlockKit(raw []rawBlockKit) []BlockKit {
	var out []BlockKit
	for _, b := range raw {
		switch b.Type {
		case "section":
			bk := BlockKit{Type: "section"}
			if b.Text != nil {
				bk.Text = &TextObject{Type: b.Text.Type, Text: b.Text.Text}
			}
			if b.Accessory != nil {
				bk.Accessory = normalizeBlockElementPtr(b.Accessory)
			}
			out = append(out, bk)
		case "header":
			bk := BlockKit{Type: "header"}
			if b.Text != nil {
				bk.Text = &TextObject{Type: b.Text.Type, Text: b.Text.Text}
			}
			out = append(out, bk)
		case "context":
			bk := BlockKit{Type: "context"}
			var els []rawBlockElement
			if len(b.Elements) > 0 {
				_ = json.Unmarshal(b.Elements, &els) // malformed → empty, no crash
			}
			for _, e := range els {
				bk.Elements = append(bk.Elements, normalizeBlockElement(e))
			}
			out = append(out, bk)
		case "image":
			out = append(out, BlockKit{Type: "image", ImageURL: b.ImageURL, AltText: b.AltText})
		case "divider":
			out = append(out, BlockKit{Type: "divider"})
		case "rich_text":
			var grps []rawElemGrp
			if len(b.Elements) > 0 {
				_ = json.Unmarshal(b.Elements, &grps)
			}
			out = append(out, BlockKit{Type: "rich_text", RichText: normalizeRichTextBlocks([]rawBlock{{Type: "rich_text", Elements: grps}})})
		default:
			out = append(out, BlockKit{Type: "unsupported"})
		}
	}
	return out
}

func normalizeBlockElement(e rawBlockElement) BlockElement {
	return BlockElement{Type: e.Type, ImageURL: e.ImageURL, AltText: e.AltText, Text: e.Text}
}

func normalizeBlockElementPtr(e *rawBlockElement) *BlockElement {
	ne := normalizeBlockElement(*e)
	return &ne
}
```

- [ ] **Step 4: Populate `Attachment.Blocks` in `normalizeMessage`**

In the attachment loop inside `normalizeMessage`, add `Blocks` to the constructed `Attachment`:

```go
			IsThreadUnfurl: a.IsMsgUnfurl || a.IsReplyUnfurl,
			Blocks:         normalizeBlockKit(a.Blocks),
		})
```

- [ ] **Step 5: Run tests to verify pass**

Run: `go test ./internal/slackapi/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/slackapi/normalize.go internal/slackapi/normalize_test.go
git commit --signoff -m "feat(slackapi): normalize Block Kit blocks inside attachments

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Synthetic fixture + end-to-end normalization test

**Files:**
- Create: `internal/slackapi/testdata/attachment_blocks.json`
- Test: `internal/slackapi/normalize_test.go`

**Interfaces:**
- Consumes: `RepliesResponse`, `NormalizeThread`.
- Produces: none (test-only).

- [ ] **Step 1: Create the synthetic fixture**

Create `internal/slackapi/testdata/attachment_blocks.json` (INVENTED content — no real names/URLs/text):

```json
{
  "ok": true,
  "messages": [
    {
      "ts": "1700000000.000100",
      "user": "U0EXAMPLE1",
      "text": "posted a link",
      "thread_ts": "1700000000.000100",
      "last_read": "1700000000.000100",
      "latest_reply": "1700000000.000100",
      "attachments": [
        {
          "is_app_unfurl": true,
          "color": "2684ff",
          "blocks": [
            {
              "type": "section",
              "block_id": "b1",
              "text": { "type": "mrkdwn", "text": "*Sample Page* by <@U0EXAMPLE2> :page_facing_up:" },
              "accessory": { "type": "image", "image_url": "https://cdn.example.test/thumb.png", "alt_text": "thumb" }
            },
            {
              "type": "context",
              "block_id": "b2",
              "elements": [
                { "type": "image", "image_url": "https://cdn.example.test/icon.png", "alt_text": "space" },
                { "type": "mrkdwn", "text": "Updated 2 days ago" }
              ]
            },
            {
              "type": "rich_text",
              "block_id": "b3",
              "elements": [
                { "type": "rich_text_section", "elements": [ { "type": "text", "text": "excerpt" } ] }
              ]
            },
            { "type": "divider", "block_id": "b4" },
            {
              "type": "actions",
              "block_id": "b5",
              "elements": [ { "type": "button", "text": { "type": "plain_text", "text": "Open" } } ]
            }
          ]
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Add to `internal/slackapi/normalize_test.go` (add imports `encoding/json`, `os` if needed):

```go
func TestNormalizeThread_AttachmentBlocksFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/attachment_blocks.json")
	if err != nil {
		t.Fatal(err)
	}
	var raw RepliesResponse
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	th := NormalizeThread("C0EXAMPLE", "1700000000.000100", raw)
	if len(th.Messages) != 1 || len(th.Messages[0].Attachments) != 1 {
		t.Fatalf("want 1 message with 1 attachment, got %d msgs", len(th.Messages))
	}
	blocks := th.Messages[0].Attachments[0].Blocks
	if len(blocks) != 5 {
		t.Fatalf("want 5 blocks, got %d", len(blocks))
	}
	if blocks[0].Type != "section" || blocks[0].Accessory == nil || blocks[0].Accessory.ImageURL == "" {
		t.Errorf("section+accessory wrong: %+v", blocks[0])
	}
	if blocks[1].Type != "context" || len(blocks[1].Elements) != 2 {
		t.Errorf("context wrong: %+v", blocks[1])
	}
	if blocks[2].Type != "rich_text" || len(blocks[2].RichText) != 1 {
		t.Errorf("rich_text wrong: %+v", blocks[2])
	}
	if blocks[3].Type != "divider" {
		t.Errorf("divider wrong: %+v", blocks[3])
	}
	if blocks[4].Type != "unsupported" {
		t.Errorf("actions should be unsupported: %+v", blocks[4])
	}
}
```

- [ ] **Step 3: Run test to verify pass**

Run: `go test ./internal/slackapi/ -run TestNormalizeThread_AttachmentBlocksFixture`
Expected: PASS (Tasks 1-3 already implement the behavior).

- [ ] **Step 4: Commit**

```bash
git add internal/slackapi/testdata/attachment_blocks.json internal/slackapi/normalize_test.go
git commit --signoff -m "test(slackapi): synthetic fixture for attachment Block Kit normalization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: TypeScript types for Block Kit

**Files:**
- Modify: `ui/src/lib/api.ts`

**Interfaces:**
- Consumes: existing `Block` interface.
- Produces: `TextObject`, `BlockElement`, `BlockKit` interfaces; `Attachment.Blocks: BlockKit[] | null`.

- [ ] **Step 1: Add the interfaces**

In `ui/src/lib/api.ts`, add before the `Attachment` interface:

```ts
export interface TextObject {
  Type: string // "mrkdwn" | "plain_text"
  Text: string
}

export interface BlockElement {
  Type: string // "image" | "mrkdwn" | "plain_text"
  ImageURL: string
  AltText: string
  Text: string
}

// A Block Kit block carried inside an attachment (Confluence/Jira app unfurl).
// Type: "section" | "context" | "image" | "divider" | "header" | "rich_text"
// | "unsupported". Go nil slices/pointers serialize as null, so nested arrays
// and pointer fields are nullable.
export interface BlockKit {
  Type: string
  Text: TextObject | null
  Elements: BlockElement[] | null
  Accessory: BlockElement | null
  ImageURL: string
  AltText: string
  RichText: Block[] | null
}
```

Then add `Blocks` to the `Attachment` interface (after `IsThreadUnfurl`):

```ts
  IsThreadUnfurl: boolean
  Blocks: BlockKit[] | null
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd ui && npx tsc -b`
Expected: no errors (no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/api.ts
git commit --signoff -m "feat(ui): add BlockKit wire types on Attachment

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `BlockKit` React component

**Files:**
- Create: `ui/src/components/BlockKit.tsx`
- Test: `ui/src/components/BlockKit.test.tsx`

**Interfaces:**
- Consumes: `BlockKit`, `User` (from `../lib/api`); `Mrkdwn` (from `../lib/mrkdwn`); `RichText` (from `./RichText`).
- Produces: `export function BlockKit({ blocks, users, emoji }: { blocks: BlockKitType[] | null; users: Record<string, User>; emoji: Record<string, string> }): JSX.Element | null` — import the type as `BlockKit as BlockKitType` to avoid name clash with the component, OR name the component `BlockKitBlocks`. **Decision: name the component `BlockKitBlocks`** to avoid the type/component name collision; export `hasRenderableBlocks`.
- Produces: `export function hasRenderableBlocks(blocks: BlockKitType[] | null): boolean` — true iff at least one block has `Type !== 'unsupported'`.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/BlockKit.test.tsx` (copy the matchMedia stub + `afterEach(cleanup)` + `renderWithProvider` from `Attachments.test.tsx`):

```tsx
import { afterEach, describe, it, expect } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { BlockKitBlocks, hasRenderableBlocks } from './BlockKit'
import type { BlockKit, User } from '../lib/api'

afterEach(cleanup)

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

const users: Record<string, User> = { U1: { ID: 'U1', RealName: 'Jane Doe', DisplayName: 'jane', Avatar72: '' } }

function block(overrides: Partial<BlockKit>): BlockKit {
  return { Type: 'unsupported', Text: null, Elements: null, Accessory: null, ImageURL: '', AltText: '', RichText: null, ...overrides }
}

describe('hasRenderableBlocks', () => {
  it('is false for null and for all-unsupported', () => {
    expect(hasRenderableBlocks(null)).toBe(false)
    expect(hasRenderableBlocks([block({ Type: 'unsupported' })])).toBe(false)
  })
  it('is true when a renderable block is present', () => {
    expect(hasRenderableBlocks([block({ Type: 'unsupported' }), block({ Type: 'divider' })])).toBe(true)
  })
})

describe('BlockKitBlocks', () => {
  it('section: renders mrkdwn text (mention resolved) and an accessory image', () => {
    const b = block({ Type: 'section', Text: { Type: 'mrkdwn', Text: 'hi <@U1> *bold*' },
      Accessory: { Type: 'image', ImageURL: 'https://cdn.test/x.png', AltText: 'thumb', Text: '' } })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    expect(container.textContent).toContain('@jane')
    expect(container.querySelector('strong')).not.toBeNull()
    expect(container.querySelector('img[src="https://cdn.test/x.png"]')).not.toBeNull()
  })

  it('section: accessory image hides on error', () => {
    const b = block({ Type: 'section', Text: { Type: 'mrkdwn', Text: 'hi' },
      Accessory: { Type: 'image', ImageURL: 'https://cdn.test/x.png', AltText: '', Text: '' } })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    const img = container.querySelector('img')!
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
  })

  it('context: renders an image and dimmed text', () => {
    const b = block({ Type: 'context', Elements: [
      { Type: 'image', ImageURL: 'https://cdn.test/i.png', AltText: 'a', Text: '' },
      { Type: 'mrkdwn', ImageURL: '', AltText: '', Text: 'updated' },
    ] })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    expect(container.querySelector('img[src="https://cdn.test/i.png"]')).not.toBeNull()
    expect(container.textContent).toContain('updated')
  })

  it('header renders bold text; divider renders an hr', () => {
    const { container } = renderWithProvider(
      <BlockKitBlocks blocks={[
        block({ Type: 'header', Text: { Type: 'plain_text', Text: 'Title' } }),
        block({ Type: 'divider' }),
      ]} users={users} emoji={{}} />,
    )
    expect(container.textContent).toContain('Title')
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('image block renders an img with alt', () => {
    const b = block({ Type: 'image', ImageURL: 'https://cdn.test/big.png', AltText: 'big' })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    const img = container.querySelector('img[src="https://cdn.test/big.png"]')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('alt')).toBe('big')
  })

  it('rich_text block delegates to RichText', () => {
    const b = block({ Type: 'rich_text', RichText: [
      { Type: 'section', Elements: [{ Type: 'text', Text: 'excerpt', URL: '', UserID: '', Name: '', Unicode: '', Style: { Bold: false, Italic: false, Code: false, Strike: false } }], Style: '', Indent: 0, Items: null },
    ] })
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[b]} users={users} emoji={{}} />)
    expect(container.textContent).toContain('excerpt')
  })

  it('unsupported block renders nothing', () => {
    const { container } = renderWithProvider(<BlockKitBlocks blocks={[block({ Type: 'unsupported' })]} users={users} emoji={{}} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('hr')).toBeNull()
    expect(container.textContent?.trim()).toBe('')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/components/BlockKit.test.tsx`
Expected: FAIL — module `./BlockKit` not found.

- [ ] **Step 3: Implement the component**

Create `ui/src/components/BlockKit.tsx`:

```tsx
import { useState } from 'react'
import { Divider, Group, Stack, Text } from '@mantine/core'
import type { BlockKit as BlockKitType, BlockElement, User } from '../lib/api'
import { Mrkdwn } from '../lib/mrkdwn'
import { RichText } from './RichText'

interface BlockKitProps {
  blocks: BlockKitType[] | null
  users: Record<string, User>
  emoji: Record<string, string>
}

/** True iff at least one block is renderable (not "unsupported"). Used by the
 * attachment card's empty-content guard so an attachment whose blocks are all
 * unsupported stays hidden rather than showing an empty bordered card. */
export function hasRenderableBlocks(blocks: BlockKitType[] | null): boolean {
  return !!blocks && blocks.some((b) => b.Type !== 'unsupported')
}

/** An image that removes itself from layout if it fails to load. Block images
 * are on public CDNs, so they load directly (no proxy), matching the v3b
 * unfurl-preview behavior. */
function HideableImage({ src, alt, size }: { src: string; alt: string; size?: number }) {
  const [errored, setErrored] = useState(false)
  if (errored || !src) return null
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      style={{ maxWidth: size ?? 360, maxHeight: size ?? 300, objectFit: 'contain', borderRadius: 4 }}
      onError={() => setErrored(true)}
    />
  )
}

function renderTextObject(
  text: { Type: string; Text: string } | null,
  users: Record<string, User>,
  emoji: Record<string, string>,
) {
  if (!text || !text.Text) return null
  if (text.Type === 'mrkdwn') {
    return <Mrkdwn text={text.Text} users={users} emoji={emoji} />
  }
  return <>{text.Text}</>
}

function ContextElement({
  el,
  users,
  emoji,
}: {
  el: BlockElement
  users: Record<string, User>
  emoji: Record<string, string>
}) {
  if (el.Type === 'image') {
    return <HideableImage src={el.ImageURL} alt={el.AltText} size={18} />
  }
  return (
    <Text span size="xs" c="dimmed">
      {el.Type === 'mrkdwn' ? <Mrkdwn text={el.Text} users={users} emoji={emoji} /> : el.Text}
    </Text>
  )
}

export function BlockKitBlocks({ blocks, users, emoji }: BlockKitProps) {
  if (!blocks || blocks.length === 0) return null
  return (
    <Stack gap={6}>
      {blocks.map((b, i) => {
        switch (b.Type) {
          case 'section':
            return (
              <Group key={i} align="flex-start" wrap="nowrap" gap="sm">
                <Text size="sm" component="div" style={{ flex: 1, minWidth: 0 }}>
                  {renderTextObject(b.Text, users, emoji)}
                </Text>
                {b.Accessory && b.Accessory.Type === 'image' && (
                  <HideableImage src={b.Accessory.ImageURL} alt={b.Accessory.AltText} size={72} />
                )}
              </Group>
            )
          case 'context':
            return (
              <Group key={i} gap={6} align="center">
                {(b.Elements ?? []).map((el, j) => (
                  <ContextElement key={j} el={el} users={users} emoji={emoji} />
                ))}
              </Group>
            )
          case 'header':
            return (
              <Text key={i} size="md" fw={700} component="div">
                {renderTextObject(b.Text, users, emoji)}
              </Text>
            )
          case 'image':
            return <HideableImage key={i} src={b.ImageURL} alt={b.AltText} />
          case 'divider':
            return <Divider key={i} />
          case 'rich_text':
            return (
              <Text key={i} size="sm" component="div">
                <RichText blocks={b.RichText} users={users} emoji={emoji} />
              </Text>
            )
          default:
            return null // "unsupported" and anything unknown render nothing
        }
      })}
    </Stack>
  )
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd ui && npx vitest run src/components/BlockKit.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/BlockKit.tsx ui/src/components/BlockKit.test.tsx
git commit --signoff -m "feat(ui): add BlockKit component for attachment Block Kit blocks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire BlockKit into the attachment card

**Files:**
- Modify: `ui/src/components/Attachments.tsx`
- Test: `ui/src/components/Attachments.test.tsx`

**Interfaces:**
- Consumes: `BlockKitBlocks`, `hasRenderableBlocks` (from `./BlockKit`); existing `WebUnfurlCard`, `hasContent`.
- Produces: none new (integration).

- [ ] **Step 1: Write the failing tests**

Add to `ui/src/components/Attachments.test.tsx`. First extend the `web` fixture's shape awareness — the `Attachment` type now has `Blocks`; existing fixtures need `Blocks: null` added. Update the `web` and `thread` fixture objects to include `Blocks: null` (and any other fixtures), then add:

```tsx
it('app unfurl with only blocks renders the block content (not hidden)', () => {
  const appUnfurl: Attachment = {
    ...web,
    Title: '', TitleLink: '', Text: '', ServiceName: '', ServiceIcon: '',
    Footer: '', FooterIcon: '', ImageURL: '', ThumbURL: '', Color: '#2684ff',
    Blocks: [
      { Type: 'section', Text: { Type: 'mrkdwn', Text: 'Confluence page summary' },
        Elements: null, Accessory: null, ImageURL: '', AltText: '', RichText: null },
    ],
  }
  const { getByText } = renderWithProvider(
    <Attachments attachments={[appUnfurl]} users={{}} emoji={{}} onOpenThread={() => {}} />,
  )
  expect(getByText('Confluence page summary')).toBeTruthy()
})

it('app unfurl with only unsupported blocks stays hidden', () => {
  const appUnfurl: Attachment = {
    ...web,
    Title: '', TitleLink: '', Text: '', ServiceName: '', ServiceIcon: '',
    Footer: '', FooterIcon: '', ImageURL: '', ThumbURL: '', Color: '#2684ff',
    Blocks: [
      { Type: 'unsupported', Text: null, Elements: null, Accessory: null, ImageURL: '', AltText: '', RichText: null },
    ],
  }
  const { container } = renderWithProvider(
    <Attachments attachments={[appUnfurl]} users={{}} emoji={{}} onOpenThread={() => {}} />,
  )
  expect(container.querySelector('.mantine-Paper-root')).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/components/Attachments.test.tsx`
Expected: FAIL — app-unfurl-with-blocks renders nothing (blocks not yet wired; `hasContent` returns false), and/or type errors from missing `Blocks` on fixtures once added.

- [ ] **Step 3: Wire it in**

In `ui/src/components/Attachments.tsx`:

1. Add the import:

```tsx
import { BlockKitBlocks, hasRenderableBlocks } from './BlockKit'
```

2. Extend `hasContent` in `WebUnfurlCard` to include renderable blocks:

```tsx
  const hasContent =
    !!attachment.Title ||
    !!attachment.Text ||
    !!attachment.ServiceName ||
    !!attachment.Footer ||
    !!imageSrc ||
    hasRenderableBlocks(attachment.Blocks)
```

3. `WebUnfurlCard` currently receives `attachment` only. It needs `users`/`emoji` to render blocks. **Check the current signature** — v3c already threads `users`/`emoji` into `WebUnfurlCard` (it renders `<Mrkdwn>` for `attachment.Text`). If so, no prop change is needed. If `WebUnfurlCard` does NOT yet receive them, add `users`/`emoji` to its props and pass them from the `Attachments` map. (As of v3c it does receive them — verify.)

4. Render the blocks after the existing `Text` block inside `WebUnfurlCard`'s `<Stack>`:

```tsx
        {attachment.Blocks && hasRenderableBlocks(attachment.Blocks) && (
          <BlockKitBlocks blocks={attachment.Blocks} users={users} emoji={emoji} />
        )}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd ui && npx vitest run src/components/Attachments.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full frontend suite + build**

Run: `cd ui && npx vitest run && npm run build`
Expected: all tests pass; build clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/Attachments.tsx ui/src/components/Attachments.test.tsx
git commit --signoff -m "feat(ui): render attachment Block Kit blocks in unfurl cards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Update the reverse-engineering doc

**Files:**
- Modify: `docs/reverse-engineering/slack-web-api.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Replace the "deferred to v3d" note**

In `docs/reverse-engineering/slack-web-api.md`, find the sentence at the end of the "Link previews (`attachments[]`)" section:

> Attachments can also carry their own `blocks[]` (Block Kit) — rendering those is deferred to the Block Kit phase (v3d).

Replace it with a new subsection:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/reverse-engineering/slack-web-api.md
git commit --signoff -m "docs(re): document is_app_unfurl attachment Block Kit shapes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `make test`
Expected: Go + frontend suites all pass.

- [ ] **Step 2: Build both**

Run: `go build ./... && cd ui && npm run build`
Expected: both clean.

- [ ] **Step 3: Live browser verification (read-only)**

Build and serve (`go build -o bin/slack-mini . && ./bin/slack-mini serve`), then via a read-only Playwright subagent open the real Confluence/Jira thread
`https://redhat-internal.slack.com/archives/C069KSM8T9N/p1786721890599109`
and confirm: the previously-empty app-unfurl cards now render section text (with resolved mentions/emoji/bold), context rows, thumbnails, and rich_text excerpts; no empty bordered cards; no console errors. SAFETY: read-only — never post, never mark read, never touch a composer. Stop the server and remove `bin/slack-mini` afterward.

- [ ] **Step 4: Final confirmation**

Report results. No commit (all work already committed task-by-task).

---

## Self-Review

**Spec coverage:**
- Data model (Go domain + wire) → Tasks 1, 5. ✓
- Shared rich_text normalizer → Task 2. ✓
- Attachment block normalization + interactive→unsupported → Task 3. ✓
- Synthetic fixture + normalization test → Task 4. ✓
- BlockKit component (section/context/header/image/divider/rich_text/unsupported) → Task 6. ✓
- Direct `<img>` hide-on-error → Task 6 (`HideableImage`). ✓
- Integration + empty-card guard (renderable-block) → Task 7. ✓
- RE-doc update → Task 8. ✓
- Testing conventions, live verification → Tasks 6, 7, 9. ✓

**Type consistency:** Go `BlockKit`/`TextObject`/`BlockElement` (Task 1) match TS interfaces (Task 5) field-for-field (PascalCase). Component imports the type as `BlockKit as BlockKitType` and names the component `BlockKitBlocks` to avoid the name clash; `hasRenderableBlocks` signature is identical in Task 6 (definition) and Task 7 (use). `normalizeRichTextBlocks` signature identical in Tasks 2 (def) and 3 (use).

**Placeholder scan:** All steps contain concrete code/commands. Task 7 Step 3 item 3 asks the implementer to verify whether `WebUnfurlCard` already receives `users`/`emoji` (it does as of v3c) — this is a verification instruction with the expected answer stated, not a placeholder.

**Known nuance flagged for implementer:** the `elements` field is polymorphic (context block-elements vs rich_text groups); Task 1 models it as `json.RawMessage` and Task 3 decodes per-type — this is the one non-obvious modeling decision and is spelled out in both tasks.
