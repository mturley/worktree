# slack-mini v3b (Link & Thread Unfurls) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Slack message `attachments` — web link unfurls (title/link, color accent, service, footer, direct preview image) and Slack thread unfurls (preview + "Open thread" button: plain click = foreground tab, Cmd/Ctrl+click = background tab).

**Architecture:** Capture the message `attachments[]` into the domain `Message` via the shared `normalizeMessage`; expose in the thread JSON (MessageView embeds Message). Render via a new `Attachments` React component in `Message.tsx`. A new App-level `onOpenThread(url, {background})` handler (reusing the tab machinery) is threaded App → ThreadView → Message → Attachments.

**Tech Stack:** Go (slackapi/server); React 18 + TS + Mantine v7.

## Global Constraints

- `slackapi` returns domain structs; new fields in `internal/slackapi/types.go`, mapping in the shared `normalizeMessage` (`internal/slackapi/normalize.go`) so attachments are captured for thread messages AND posted replies. Empty raw slice → nil.
- Wire format: `MessageView` embeds `slackapi.Message` (no json tags → PascalCase nested keys); frontend TS `Attachment` fields are PascalCase.
- Unfurl `text`/`footer` are rendered ESCAPE-ONLY for now: unescape `&amp;`/`&lt;`/`&gt;`; do NOT parse mrkdwn tokens (`<url|label>`, `<@U>` stay literal). The v3c mrkdwn renderer supersedes this later.
- Unfurl preview images load DIRECTLY from their external CDN (`<img src={ImageURL}>`, no proxy), with an `onError` that hides the image. Do NOT proxy external hosts.
- Thread unfurl "Open thread": plain click → foreground tab (add + switch); Cmd/Ctrl+click (or middle-click optionally) → background tab (add, do not switch). Reuse `parseThreadUrl` + `addTabFromUrl`/`findTab` (dedup). If `FromURL` doesn't parse, render the card without a working button.
- Fixtures MUST be hand-built synthetic (fake URLs/names/content), per `internal/slackapi/testdata/replies.json`.
- TDD: failing test → confirm fail → implement → confirm pass → commit. `go test ./... -race`, `go vet`, `gofmt -l .` clean; `cd ui && npx vitest run`, `npm run build`, `go build ./...` all green before commit.
- Frontend tests: repo has NO jest-dom matchers and RTL needs `afterEach(cleanup)` per file — use plain assertions (`expect(el).not.toBeNull()`, `.getAttribute(...)`).
- Commit style: conventional prefix, `--signoff`, end body with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Update `docs/reverse-engineering/slack-web-api.md` with the attachments[] shapes (Task 4).

---

### Task 1: Capture attachments in the slackapi domain model

**Files:**
- Modify: `internal/slackapi/types.go`, `internal/slackapi/normalize.go`
- Modify: `internal/slackapi/normalize_test.go`, `internal/slackapi/testdata/replies.json`

**Interfaces:**
- Produces domain struct:
  ```go
  type Attachment struct {
      Title          string
      TitleLink      string
      Text           string
      ServiceName    string
      ServiceIcon    string
      Footer         string
      FooterIcon     string
      Color          string // hex, no '#'
      ImageURL       string
      ThumbURL       string
      ImageWidth     int
      ImageHeight    int
      AuthorName     string
      IsMsgUnfurl    bool
      IsReplyUnfurl  bool
      FromURL        string
      ChannelID      string
      IsThreadUnfurl bool // derived: IsMsgUnfurl || IsReplyUnfurl
  }
  ```
  and `Attachments []Attachment` on `Message`.

- [ ] **Step 1: Add synthetic attachments to the fixture.** In `internal/slackapi/testdata/replies.json`, add an `attachments` array to one message with TWO entries (fake values):
```json
"attachments": [
  { "title": "#123 Example PR title", "title_link": "https://github.com/example/repo/pull/123",
    "text": "Example unfurl text with an &amp; entity", "service_name": "GitHub",
    "service_icon": "https://example.com/gh.png", "footer": "example/repo",
    "footer_icon": "https://example.com/f.png", "color": "36a64f",
    "image_url": "https://example.com/preview.png", "image_width": 571, "image_height": 243 },
  { "is_msg_unfurl": true, "is_reply_unfurl": true,
    "from_url": "https://example.slack.com/archives/C0EXAMPLE2/p1700000000000009?thread_ts=1700000000.000005&cid=C0EXAMPLE2",
    "author_name": "Test Person", "text": "Preview of the linked thread", "channel_id": "C0EXAMPLE2",
    "footer": "Thread in Slack Conversation" }
]
```
Verify parse: `python3 -m json.tool internal/slackapi/testdata/replies.json >/dev/null && echo ok`.

- [ ] **Step 2: Write the failing test** (`normalize_test.go`):
```go
func TestNormalizeThreadCapturesAttachments(t *testing.T) {
	raw := loadFixture(t)
	th := NormalizeThread("C0EXAMPLE1", "1700000000.000001", raw)
	var m *Message
	for i := range th.Messages {
		if len(th.Messages[i].Attachments) > 0 { m = &th.Messages[i]; break }
	}
	if m == nil { t.Fatal("expected a message with attachments") }
	if len(m.Attachments) != 2 { t.Fatalf("attachments=%d, want 2", len(m.Attachments)) }
	web := m.Attachments[0]
	if web.Title == "" || web.TitleLink == "" || web.Color != "36a64f" { t.Fatalf("web=%+v", web) }
	if web.ImageURL == "" || web.ImageWidth != 571 { t.Fatalf("web image: %+v", web) }
	if web.IsThreadUnfurl { t.Fatal("web unfurl should not be a thread unfurl") }
	th2 := m.Attachments[1]
	if !th2.IsThreadUnfurl || th2.FromURL == "" || th2.AuthorName == "" { t.Fatalf("thread unfurl=%+v", th2) }
}
```

- [ ] **Step 3: Run to verify fail** — `go test ./internal/slackapi/ -run TestNormalizeThreadCapturesAttachments -v` → FAIL (no Attachments field).

- [ ] **Step 4: Implement.** In types.go add the domain `Attachment` struct (above), `Attachments []Attachment` on `Message`, and a raw struct:
```go
type rawAttachment struct {
	Title string `json:"title"`; TitleLink string `json:"title_link"`; Text string `json:"text"`
	ServiceName string `json:"service_name"`; ServiceIcon string `json:"service_icon"`
	Footer string `json:"footer"`; FooterIcon string `json:"footer_icon"`; Color string `json:"color"`
	ImageURL string `json:"image_url"`; ThumbURL string `json:"thumb_url"`
	ImageWidth int `json:"image_width"`; ImageHeight int `json:"image_height"`
	AuthorName string `json:"author_name"`; IsMsgUnfurl bool `json:"is_msg_unfurl"`
	IsReplyUnfurl bool `json:"is_reply_unfurl"`; FromURL string `json:"from_url"`; ChannelID string `json:"channel_id"`
}
```
Add `Attachments []rawAttachment \`json:"attachments"\`` to `rawMessage`. In `normalizeMessage`, map each raw attachment to a domain `Attachment`, setting `IsThreadUnfurl: a.IsMsgUnfurl || a.IsReplyUnfurl`. Leave `Attachments` nil when empty.

- [ ] **Step 5: Run to verify pass** — `go test ./internal/slackapi/ -v` → PASS (existing tests unaffected).

- [ ] **Step 6: Commit**
```bash
git add internal/slackapi/
git commit --signoff -m "feat: capture message attachments in the slackapi domain model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Frontend types + unescape helper + App onOpenThread wiring

**Files:**
- Modify: `ui/src/lib/api.ts` (`Attachment` type, `Message.Attachments`, `unescapeSlackText`)
- Create: `ui/src/lib/openThread.ts` (pure helper) + `ui/src/lib/openThread.test.ts`
- Modify: `ui/src/App.tsx` (handleOpenThread), `ui/src/components/ThreadView.tsx` + `ui/src/components/Message.tsx` (thread the prop through)

**Interfaces:**
- Produces:
  - `interface Attachment { Title; TitleLink; Text; ServiceName; ServiceIcon; Footer; FooterIcon; Color; ImageURL; ThumbURL; ImageWidth:number; ImageHeight:number; AuthorName; IsMsgUnfurl:boolean; IsReplyUnfurl:boolean; FromURL; ChannelID; IsThreadUnfurl:boolean }` (all PascalCase), `Attachments: Attachment[] | null` on `Message`.
  - `unescapeSlackText(s: string): string`.
  - `computeOpenThread(tabs: Tab[], url: string, background: boolean): { tabs: Tab[]; activeId: string | null | undefined }` — pure: parse+dedup, returns new tabs and the active id to set (undefined = leave active unchanged, for background when nothing to switch).
  - `onOpenThread(url: string, opts: { background: boolean }): void` threaded App → ThreadView → Message → Attachments.

- [ ] **Step 1: Add types + unescape to api.ts.**
```ts
export interface Attachment {
  Title: string; TitleLink: string; Text: string
  ServiceName: string; ServiceIcon: string; Footer: string; FooterIcon: string
  Color: string; ImageURL: string; ThumbURL: string; ImageWidth: number; ImageHeight: number
  AuthorName: string; IsMsgUnfurl: boolean; IsReplyUnfurl: boolean
  FromURL: string; ChannelID: string; IsThreadUnfurl: boolean
}
// add to Message: Attachments: Attachment[] | null
export function unescapeSlackText(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
```
Add `Attachments: Attachment[] | null` to the `Message` interface.

- [ ] **Step 2: Write failing tests** for `openThread.ts` (`openThread.test.ts`) and `unescapeSlackText`:
```ts
import { computeOpenThread } from './openThread'
// (tabs from state/tabs Tab type; use minimal Tab objects)
it('foreground: adds a new thread tab and makes it active', () => {
  const r = computeOpenThread([], 'https://x.slack.com/archives/C1/p1700000000000001', false)
  expect(r.tabs.length).toBe(1)
  expect(r.activeId).toBe(r.tabs[0].id)
})
it('background: adds a new tab but does not change active', () => {
  const r = computeOpenThread([], 'https://x.slack.com/archives/C1/p1700000000000001', true)
  expect(r.tabs.length).toBe(1)
  expect(r.activeId).toBeUndefined() // leave active unchanged
})
it('existing thread: foreground switches to it, no duplicate', () => {
  const first = computeOpenThread([], 'https://x.slack.com/archives/C1/p1700000000000001', false)
  const again = computeOpenThread(first.tabs, 'https://x.slack.com/archives/C1/p1700000000000001', false)
  expect(again.tabs.length).toBe(1)
  expect(again.activeId).toBe(first.tabs[0].id)
})
it('unparseable url: no change', () => {
  const r = computeOpenThread([], 'https://example.com/not-slack', false)
  expect(r.tabs.length).toBe(0)
})
// unescapeSlackText: '&amp;&lt;&gt;' -> '&<>'
```

- [ ] **Step 3: Run to verify fail** — `cd ui && npx vitest run src/lib/openThread.test.ts` → FAIL.

- [ ] **Step 4: Implement `openThread.ts`.** Use `parseThreadUrl` + `addTabFromUrl`/`findTab` from `state/tabs`:
```ts
import { addTabFromUrl, findTab, type Tab } from '../state/tabs'
import { parseThreadUrl } from './parseThreadUrl'
export function computeOpenThread(tabs: Tab[], url: string, background: boolean) {
  const parsed = parseThreadUrl(url)
  if (!parsed) return { tabs, activeId: undefined as string | null | undefined }
  const existing = findTab(tabs, parsed.channel, parsed.threadTs)
  if (existing) return { tabs, activeId: background ? undefined : existing.id }
  const next = addTabFromUrl(tabs, url)
  const added = next[next.length - 1]
  return { tabs: next, activeId: background ? undefined : added.id }
}
```
(Verify `addTabFromUrl`/`findTab` signatures; adjust to their actual API. If `addTabFromUrl` already dedups, the `existing` branch may be redundant but keeps the activeId logic explicit.)

- [ ] **Step 5: Wire `handleOpenThread` in App.tsx.**
```ts
function handleOpenThread(url: string, opts: { background: boolean }) {
  const r = computeOpenThread(tabs, url, opts.background)
  if (r.tabs !== tabs) setTabs(r.tabs)
  if (r.activeId !== undefined) setActiveTabId(r.activeId)
}
```
Pass `onOpenThread={handleOpenThread}` to `<ThreadView>`. In ThreadView, add `onOpenThread` to its props and pass it to each `<Message onOpenThread={onOpenThread} …>`. In Message, add optional `onOpenThread?: (url, opts) => void` to props and pass it to `<Attachments>` (Task 3).

- [ ] **Step 6: Run to verify pass** — `cd ui && npx vitest run` → PASS; `npm run build`; `go build ./...`.

- [ ] **Step 7: Commit**
```bash
git add ui/src/lib/api.ts ui/src/lib/openThread.ts ui/src/lib/openThread.test.ts ui/src/App.tsx ui/src/components/ThreadView.tsx ui/src/components/Message.tsx
git commit --signoff -m "feat(ui): attachment types + open-thread tab wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Attachments component (web + thread unfurl rendering)

**Files:**
- Create: `ui/src/components/Attachments.tsx`, `ui/src/components/Attachments.test.tsx`
- Modify: `ui/src/components/Message.tsx` (render `<Attachments>`)

**Interfaces:**
- Consumes: `Message.Attachments`, `onOpenThread`.
- Produces: `<Attachments attachments={Attachment[]} onOpenThread={(url, opts) => void} />`.

- [ ] **Step 1: Write failing tests** (`Attachments.test.tsx`, `afterEach(cleanup)`, plain assertions):
```tsx
const web: Attachment = { Title:'#123 Example PR', TitleLink:'https://github.com/example/repo/pull/123', Text:'body &amp; more', ServiceName:'GitHub', ServiceIcon:'https://ex.com/gh.png', Footer:'example/repo', FooterIcon:'', Color:'36a64f', ImageURL:'https://ex.com/preview.png', ThumbURL:'', ImageWidth:571, ImageHeight:243, AuthorName:'', IsMsgUnfurl:false, IsReplyUnfurl:false, FromURL:'', ChannelID:'', IsThreadUnfurl:false }
const thread: Attachment = { Title:'', TitleLink:'', Text:'preview text', ServiceName:'', ServiceIcon:'', Footer:'Thread in Slack Conversation', FooterIcon:'', Color:'', ImageURL:'', ThumbURL:'', ImageWidth:0, ImageHeight:0, AuthorName:'Test Person', IsMsgUnfurl:true, IsReplyUnfurl:true, FromURL:'https://x.slack.com/archives/C1/p1700000000000001?thread_ts=1700000000.000001&cid=C1', ChannelID:'C1', IsThreadUnfurl:true }

it('web unfurl: title links to TitleLink and preview image uses the raw external src', () => {
  const { container } = renderWithProvider(<Attachments attachments={[web]} onOpenThread={()=>{}} />)
  const link = container.querySelector('a[href="https://github.com/example/repo/pull/123"]')
  expect(link).not.toBeNull()
  const img = container.querySelector('img')
  expect(img?.getAttribute('src')).toBe('https://ex.com/preview.png') // direct, NOT /api/file
})
it('web unfurl: preview image hides on error', () => {
  const { container } = renderWithProvider(<Attachments attachments={[web]} onOpenThread={()=>{}} />)
  const img = container.querySelector('img')!
  fireEvent.error(img)
  expect(container.querySelector('img')).toBeNull()
})
it('thread unfurl: Open thread click calls onOpenThread foreground; Cmd+click background', () => {
  const onOpenThread = vi.fn()
  const { getByRole } = renderWithProvider(<Attachments attachments={[thread]} onOpenThread={onOpenThread} />)
  const btn = getByRole('button', { name: /open thread/i })
  fireEvent.click(btn)
  expect(onOpenThread).toHaveBeenLastCalledWith(thread.FromURL, { background: false })
  fireEvent.click(btn, { metaKey: true })
  expect(onOpenThread).toHaveBeenLastCalledWith(thread.FromURL, { background: true })
})
```

- [ ] **Step 2: Run to verify fail** — `cd ui && npx vitest run src/components/Attachments.test.tsx` → FAIL (no component).

- [ ] **Step 3: Implement `Attachments.tsx`.** Map each attachment:
  - **Thread unfurl** (`IsThreadUnfurl` or a parseable FromURL): a Mantine `Paper` card with `AuthorName` (if present, bold/small), the `unescapeSlackText(Text)` preview, and an "Open thread" `Button`. onClick handler reads the mouse event: `onOpenThread(FromURL, { background: e.metaKey || e.ctrlKey })`. If `parseThreadUrl(FromURL)` is null, render the card but omit/disable the button.
  - **Web unfurl** (otherwise): a Mantine `Paper` with a left border accent `style={{ borderLeft: '3px solid #'+(Color||'888') }}`. Rows: `ServiceName` + `ServiceIcon` (small `<img>` favicon, direct src, onError hide) if present; `Title` as `<a href={TitleLink} target="_blank" rel="noreferrer">` (or plain text if no TitleLink); `unescapeSlackText(Text)`; `Footer` (+FooterIcon) if present; a preview `<img src={ImageURL || ThumbURL}>` (DIRECT, no proxy) bounded (maxWidth ~360, maxHeight ~300, width/height hint from ImageWidth/Height) with `onError` that hides it (per-attachment errored state).
  - Multiple attachments stack vertically.

- [ ] **Step 4: Render in Message.tsx** — after files/body (near reactions): `{message.Attachments && message.Attachments.length > 0 && <Attachments attachments={message.Attachments} onOpenThread={onOpenThread ?? (() => {})} />}`.

- [ ] **Step 5: Run to verify pass** — `cd ui && npx vitest run` → PASS; `npm run build`; `go build ./...`.

- [ ] **Step 6: Commit**
```bash
git add ui/src/components/Attachments.tsx ui/src/components/Attachments.test.tsx ui/src/components/Message.tsx
git commit --signoff -m "feat(ui): render link & thread unfurls with open-as-tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: RE doc update + live verification (read-only)

**Files:**
- Modify: `docs/reverse-engineering/slack-web-api.md`

- [ ] **Step 1: Update the RE doc.** Add an `attachments[]` section: web link unfurl fields (title/title_link/text[mrkdwn]/service_name/service_icon/footer/footer_icon/color/image_url+dims/thumb_url) and thread unfurl fields (is_msg_unfurl/is_reply_unfurl/from_url/author_name/channel_id/ts, footer "Thread in Slack Conversation"). Note attachment `text` contains mrkdwn (rendered escape-only until the v3c mrkdwn renderer) and unfurl preview images are on external CDNs (loaded directly, not proxied). Commit:
```bash
git add docs/reverse-engineering/slack-web-api.md
git commit --signoff -m "docs: document message attachments[] unfurl shapes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Live verification (read-only, controller-run — NOT a subagent).** Build + serve; open a real thread with a GitHub/Jira web unfurl and one with a Slack thread unfurl (read-only; user authorized reading anywhere, no posting). Confirm: web unfurl card renders (color accent, title link, footer, direct preview image loads or hides gracefully); thread unfurl "Open thread" opens a foreground tab on click and a background tab on Cmd/Ctrl+click. Verify in a browser (Playwright). Report; do not post.

---

## Notes for the executor

- `normalizeMessage` is shared by `NormalizeThread` and `PostReply` → attachments captured for both automatically.
- The `onOpenThread` prop is threaded exactly like the existing `onMarkUnread` (App → ThreadView → Message → Attachments); mirror that wiring.
- Unfurl text is escape-only (v3c does mrkdwn). Unfurl preview images load DIRECTLY (no proxy) with onError-hide.
- Fixtures stay hand-built synthetic.
- Live verification (Task 4 Step 2) is read-only; never post.
