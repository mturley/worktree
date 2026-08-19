# slack-mini v3a (Images & Files) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Slack file/image uploads in threads — inline image thumbnails (click → modal lightbox) and non-image file cards linking to Slack.

**Architecture:** Capture the message `files[]` array into the domain `Message` via the shared `normalizeMessage` helper; expose it in the thread JSON (MessageView already embeds Message). Add an `/api/file` image proxy that serves auth'd `files.slack.com` URLs. Render via a new `FileAttachments` React component in `Message.tsx`.

**Tech Stack:** Go (stdlib net/http, slackapi/server); React 18 + TS + Mantine v7.

## Global Constraints

- `slackapi` returns domain structs, never raw Slack JSON. New client/struct fields go in `internal/slackapi/types.go`; normalization in `internal/slackapi/normalize.go`.
- The existing image proxy (`internal/server/proxy.go` `handleImageProxy(allowedHost string)`) ALREADY forwards the `d=` cookie (proxy.go:180-181), enforces exact-host allowlist (400 before any fetch), https-only, and a no-redirect `CheckRedirect`. So `/api/file` just needs `files.slack.com` added as an allowed host via the same factory — NO new cookie logic needed. Keep the SSRF protections identical across all three proxy endpoints.
- Wire format: `MessageView` embeds `slackapi.Message` (no json tags → PascalCase nested keys); `ThreadResponse` top-level is camelCase. Frontend TS types must match: `Message.Files` and the `File` fields are PascalCase.
- Fixtures MUST be hand-built synthetic (fake IDs/URLs/names, no real people/topics/content), following `internal/slackapi/testdata/replies.json`.
- Image files: `IsImage = strings.HasPrefix(mimetype, "image/")`. Inline thumbnail from `Thumb360` (fallback `URLPrivate`) via the `/api/file` proxy, bounded (~max 360w×300h, aspect preserved). Click → Mantine `Modal` lightbox showing `URLPrivate` (proxied). Non-image files: card with `PrettyType`/`Filetype`, `Name`, human-readable `Size`, opening `Permalink` in a new tab (`target=_blank rel=noreferrer`). Only images are proxied; non-image file content is never proxied.
- TDD: failing test → confirm fail → implement → confirm pass → commit. `go test ./... -race`, `go vet`, `gofmt -l .` clean; `cd ui && npx vitest run`, `npm run build`, `go build ./...` all green before commit.
- Commit style: conventional prefix, `--signoff`, end body with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- After implementing, update `docs/reverse-engineering/slack-web-api.md` with the files[] shape + files.slack.com/cookie note (Task 4).

---

### Task 1: Capture files in the slackapi domain model

**Files:**
- Modify: `internal/slackapi/types.go` (raw `files` + domain `File` + `Message.Files`)
- Modify: `internal/slackapi/normalize.go` (`normalizeMessage` maps files)
- Modify: `internal/slackapi/normalize_test.go`, `internal/slackapi/testdata/replies.json`

**Interfaces:**
- Produces domain structs:
  ```go
  type File struct {
      ID          string
      Name        string
      Title       string
      Mimetype    string
      Filetype    string
      PrettyType  string
      Size        int
      Permalink   string
      URLPrivate  string
      Thumb360    string
      Thumb360W   int
      Thumb360H   int
      Thumb720    string
      OriginalW   int
      OriginalH   int
      IsImage     bool
  }
  ```
  and `Files []File` on `Message`.

- [ ] **Step 1: Add a synthetic file to the fixture.** In `internal/slackapi/testdata/replies.json`, add a `files` array to one message with TWO entries — an image and a non-image — using fake values:
```json
"files": [
  { "id": "F0IMG", "name": "diagram.png", "title": "diagram.png", "mimetype": "image/png",
    "filetype": "png", "pretty_type": "PNG", "size": 12345,
    "permalink": "https://example.slack.com/files/U0/F0IMG/diagram.png",
    "url_private": "https://files.slack.com/files-pri/T0-F0IMG/diagram.png",
    "thumb_360": "https://files.slack.com/files-tmb/T0-F0IMG/diagram_360.png",
    "thumb_360_w": 360, "thumb_360_h": 200, "thumb_720": "https://files.slack.com/files-tmb/T0-F0IMG/diagram_720.png",
    "original_w": 1200, "original_h": 667 },
  { "id": "F0DOC", "name": "notes.pdf", "title": "notes.pdf", "mimetype": "application/pdf",
    "filetype": "pdf", "pretty_type": "PDF", "size": 67890,
    "permalink": "https://example.slack.com/files/U0/F0DOC/notes.pdf",
    "url_private": "https://files.slack.com/files-pri/T0-F0DOC/notes.pdf" }
]
```
Verify it parses: `python3 -m json.tool internal/slackapi/testdata/replies.json >/dev/null && echo ok`.

- [ ] **Step 2: Write the failing test** in `normalize_test.go`:
```go
func TestNormalizeThreadCapturesFiles(t *testing.T) {
	raw := loadFixture(t) // existing helper
	th := NormalizeThread("C0EXAMPLE1", "1700000000.000001", raw)
	var withFiles *Message
	for i := range th.Messages {
		if len(th.Messages[i].Files) > 0 { withFiles = &th.Messages[i]; break }
	}
	if withFiles == nil { t.Fatal("expected a message with files") }
	if len(withFiles.Files) != 2 { t.Fatalf("files=%d, want 2", len(withFiles.Files)) }
	img := withFiles.Files[0]
	if !img.IsImage || img.Mimetype != "image/png" { t.Fatalf("img=%+v", img) }
	if img.Thumb360 == "" || img.OriginalW != 1200 { t.Fatalf("img thumbs/dims: %+v", img) }
	doc := withFiles.Files[1]
	if doc.IsImage { t.Fatal("pdf should not be IsImage") }
	if doc.PrettyType != "PDF" || doc.Size != 67890 || doc.Permalink == "" { t.Fatalf("doc=%+v", doc) }
}
```

- [ ] **Step 3: Run to verify fail** — `go test ./internal/slackapi/ -run TestNormalizeThreadCapturesFiles -v` → FAIL (no Files field).

- [ ] **Step 4: Implement.** In types.go: add the domain `File` struct (above); add `Files []File` to `Message`; add a raw file struct and `Files []rawFile` to `rawMessage`:
```go
type rawFile struct {
	ID string `json:"id"`; Name string `json:"name"`; Title string `json:"title"`
	Mimetype string `json:"mimetype"`; Filetype string `json:"filetype"`; PrettyType string `json:"pretty_type"`
	Size int `json:"size"`; Permalink string `json:"permalink"`; URLPrivate string `json:"url_private"`
	Thumb360 string `json:"thumb_360"`; Thumb360W int `json:"thumb_360_w"`; Thumb360H int `json:"thumb_360_h"`
	Thumb720 string `json:"thumb_720"`; OriginalW int `json:"original_w"`; OriginalH int `json:"original_h"`
}
```
Add `Files []rawFile \`json:"files"\`` to `rawMessage`. In `normalizeMessage`, map each raw file to a domain `File`, setting `IsImage: strings.HasPrefix(m.Mimetype, "image/")` (add `strings` import if needed). Leave `Files` nil when the raw slice is empty.

- [ ] **Step 5: Run to verify pass** — `go test ./internal/slackapi/ -v` → PASS (existing normalize tests still pass — reactions/blocks/edited unaffected).

- [ ] **Step 6: Commit**
```bash
git add internal/slackapi/
git commit --signoff -m "feat: capture message files in the slackapi domain model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: /api/file image proxy

**Files:**
- Modify: `internal/server/server.go` (register route), `internal/server/proxy.go` (only if the factory needs no change — likely just the route)
- Modify: `internal/server/server_test.go` (proxy tests)

**Interfaces:**
- Produces route `GET /api/file?url=` served by `s.handleImageProxy("files.slack.com")`.

- [ ] **Step 1: Write failing tests** in server_test.go (mirror the existing avatar/emoji proxy tests):
```go
func TestFileProxyRejectsForeignHost(t *testing.T) {
	s := New(&config.Config{}, &fakeClient{}, nil)
	req := httptest.NewRequest("GET", "/api/file?url=https://evil.example/x.png", nil)
	rec := httptest.NewRecorder(); s.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 { t.Fatalf("code=%d, want 400", rec.Code) }
}

func TestFileProxyRejectsNonHTTPS(t *testing.T) {
	s := New(&config.Config{}, &fakeClient{}, nil)
	req := httptest.NewRequest("GET", "/api/file?url=http://files.slack.com/x.png", nil)
	rec := httptest.NewRecorder(); s.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 { t.Fatalf("code=%d, want 400", rec.Code) }
}
```
(If an existing avatar/emoji proxy test proves the allowed-host path via an injected transport, add an analogous allowed-host test for `files.slack.com` using the same `imageProxyTransport` seam so no real network is hit.)

- [ ] **Step 2: Run to verify fail** — `go test ./internal/server/ -run TestFileProxy -v` → FAIL (route not registered → likely 404, not 400).

- [ ] **Step 3: Implement.** In `server.go` `Handler()`, add:
```go
mux.HandleFunc("/api/file", s.handleImageProxy("files.slack.com"))
```
The existing `handleImageProxy` factory already forwards the `d=` cookie, enforces the exact-host allowlist, https-only, and no-redirect — so `files.slack.com` gets identical protections with no other change. (If a proxy test needs the allowed-host path, set `s.imageProxyTransport` in the test to a fake RoundTripper returning a canned image, as the existing avatar/emoji allowed-path test does.)

- [ ] **Step 4: Run to verify pass** — `go test ./internal/server/ -v` → PASS; `go test ./... -race` clean.

- [ ] **Step 5: Commit**
```bash
git add internal/server/
git commit --signoff -m "feat: /api/file proxy for auth'd files.slack.com images

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: FileAttachments frontend (types, proxy helper, rendering, modal)

**Files:**
- Modify: `ui/src/lib/api.ts` (`File` type, `Message.Files`, `fileProxy`)
- Create: `ui/src/components/FileAttachments.tsx`, `ui/src/components/FileAttachments.test.tsx`
- Modify: `ui/src/components/Message.tsx` (render `<FileAttachments>`)

**Interfaces:**
- Consumes: `Message.Files` from `/api/thread`.
- Produces:
  - `api.fileProxy(url): string` → `/api/file?url=<enc>`.
  - `interface File { ID; Name; Title; Mimetype; Filetype; PrettyType; Size; Permalink; URLPrivate; Thumb360; Thumb360W; Thumb360H; Thumb720; OriginalW; OriginalH; IsImage }` (all PascalCase; Size/dims are numbers, IsImage boolean).
  - `<FileAttachments files={File[]} />`.

- [ ] **Step 1: Add types + helper to api.ts.**
```ts
export interface File {
  ID: string; Name: string; Title: string; Mimetype: string; Filetype: string
  PrettyType: string; Size: number; Permalink: string; URLPrivate: string
  Thumb360: string; Thumb360W: number; Thumb360H: number; Thumb720: string
  OriginalW: number; OriginalH: number; IsImage: boolean
}
// add to Message: Files: File[] | null
export function fileProxy(url: string): string {
  return `/api/file?url=${encodeURIComponent(url)}`
}
```
Add `Files: File[] | null` to the `Message` interface.

- [ ] **Step 2: Write failing FileAttachments tests** (`FileAttachments.test.tsx`, mirror existing component-test setup with `renderWithProvider` + matchMedia stub). NOTE: this repo has NO jest-dom matchers registered and RTL needs an explicit `afterEach(cleanup)` per test file (see Composer.test.tsx) — use plain assertions (`expect(el).not.toBeNull()`, `expect(el.getAttribute(...)).toBe(...)`, `.disabled`) rather than `toBeInTheDocument()`/`toBeDisabled()`, and add `afterEach(cleanup)`:
```tsx
const img: File = { ID:'F1', Name:'diagram.png', Title:'diagram.png', Mimetype:'image/png', Filetype:'png', PrettyType:'PNG', Size:12345, Permalink:'https://x.slack.com/files/U0/F1/diagram.png', URLPrivate:'https://files.slack.com/files-pri/T0-F1/diagram.png', Thumb360:'https://files.slack.com/files-tmb/T0-F1/d_360.png', Thumb360W:360, Thumb360H:200, Thumb720:'', OriginalW:1200, OriginalH:667, IsImage:true }
const doc: File = { ID:'F2', Name:'notes.pdf', Title:'notes.pdf', Mimetype:'application/pdf', Filetype:'pdf', PrettyType:'PDF', Size:67890, Permalink:'https://x.slack.com/files/U0/F2/notes.pdf', URLPrivate:'', Thumb360:'', Thumb360W:0, Thumb360H:0, Thumb720:'', OriginalW:0, OriginalH:0, IsImage:false }

it('renders an image file as a proxied thumbnail', () => {
  const { container } = renderWithProvider(<FileAttachments files={[img]} />)
  const el = container.querySelector('img')
  expect(el?.getAttribute('src')).toContain('/api/file?url=')
  expect(el?.getAttribute('src')).toContain(encodeURIComponent(img.Thumb360))
})

it('opens a modal with the full image when the thumbnail is clicked', () => {
  const { container, getByAltText } = renderWithProvider(<FileAttachments files={[img]} />)
  fireEvent.click(container.querySelector('img')!)
  // modal shows the full image via url_private (proxied)
  const full = getByAltText('diagram.png')  // whichever alt you set on the modal image
  expect(full.getAttribute('src')).toContain(encodeURIComponent(img.URLPrivate))
})

it('renders a non-image file as a card linking to the permalink', () => {
  const { getByText, container } = renderWithProvider(<FileAttachments files={[doc]} />)
  expect(getByText('notes.pdf')).toBeTruthy()
  const link = container.querySelector('a[href="'+doc.Permalink+'"]')
  expect(link).not.toBeNull()
})
```

- [ ] **Step 3: Run to verify fail** — `cd ui && npx vitest run src/components/FileAttachments.test.tsx` → FAIL (no component).

- [ ] **Step 4: Implement `FileAttachments.tsx`.**
  - For each file: if `IsImage`, render a bounded `<img>` (src = `fileProxy(Thumb360 || URLPrivate)`, `alt={Name}`, style maxWidth ~360, maxHeight ~300, width/height hint from Thumb360W/H when present, cursor pointer, `loading="lazy"`). On `onError`, swap to the non-image card fallback (track a per-file error state). Clicking sets modal state to that file.
  - Else render a non-image **card**: Mantine `Paper`/`Anchor` with a filetype label (`PrettyType || Filetype || 'file'`), `Name`, and human-readable `Size` (add a small `formatBytes(n)` helper — e.g. KB/MB), wrapped in an `<a href={Permalink} target="_blank" rel="noreferrer">` when Permalink is non-empty (else a non-clickable card).
  - Modal: a Mantine `Modal` (opened when a file is selected) showing `<img src={fileProxy(selected.URLPrivate)} alt={selected.Name}>` at large size; close resets selection.
  - Multiple images: lay out in a wrapped `Group`/flex row.
  - Extract `formatBytes` as a tiny pure function (optionally in a lib file) and unit-test it if convenient.

- [ ] **Step 5: Render in Message.tsx** — after the message body (RichText/blocks), before or alongside reactions, add `{message.Files && message.Files.length > 0 && <FileAttachments files={message.Files} />}`.

- [ ] **Step 6: Run to verify pass** — `cd ui && npx vitest run` → PASS; `npm run build`; `go build ./...`.

- [ ] **Step 7: Commit**
```bash
git add ui/src/lib/api.ts ui/src/components/FileAttachments.tsx ui/src/components/FileAttachments.test.tsx ui/src/components/Message.tsx
git commit --signoff -m "feat(ui): render file/image attachments with modal lightbox

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: RE doc update + live verification (read-only)

**Files:**
- Modify: `docs/reverse-engineering/slack-web-api.md`

- [ ] **Step 1: Update the RE doc.** Add a `files[]` section: message `files` array shape (image vs non-image), image fields (`mimetype image/*`, `thumb_360`/`thumb_720` with `_w`/`_h`, `original_w/h`, `url_private`), non-image fields (`pretty_type`, `size`, `permalink`, `url_private_download`). Note that `url_private`/`thumb_*` are on **`files.slack.com`** and REQUIRE the `d=` cookie — hence `/api/file` forwards it (like the avatar/emoji proxies already do). Commit:
```bash
git add docs/reverse-engineering/slack-web-api.md
git commit --signoff -m "docs: document message files[] shape and files.slack.com auth

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2: Live verification (read-only, controller-run — NOT a subagent).** Build (`cd ui && npm run build && cd .. && go build -o bin/slack-mini . && ./bin/slack-mini serve`) and open a real thread in the user's channels that has an image upload and a file upload (read-only; the user authorized reading anywhere, no posting). Confirm: inline image thumbnail loads (via /api/file), clicking opens the modal with the full image, and a non-image file card opens the Slack permalink. Verify in a browser (Playwright). Report results; do not post anything.

---

## Notes for the executor

- The existing image proxy already forwards the `d=` cookie for all hosts, so Task 2 is essentially just registering `/api/file` with the `files.slack.com` allowlist — do not add duplicate cookie logic.
- `normalizeMessage` is shared by `NormalizeThread` and `PostReply`, so files are captured for both thread messages and posted replies automatically.
- Fixtures stay hand-built synthetic (no real content).
- Run the full suite (go + vitest) before each commit.
- Live verification (Task 4 Step 2) is read-only; never post.
