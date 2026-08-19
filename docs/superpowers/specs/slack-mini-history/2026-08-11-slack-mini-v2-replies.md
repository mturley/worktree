# slack-mini v2 (Replies + Mark-Unread) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user reply to a thread from within slack-mini, and mark a thread unread from a specific message — turning the read-only viewer into one you can respond from.

**Architecture:** Two new Slack Web API calls behind the existing `slackapi.Client` interface (`MarkUnread`, `PostReply`), each exposed through a new Go proxy endpoint (`/api/thread/mark-unread`, `/api/thread/reply`). The reply endpoint enforces an optional config **send-allowlist** (dev safeguard) and marks the thread read on success. The React frontend gains a per-message "Mark unread from here" hover action (Step 0) and a reply composer above the floating footer (mrkdwn toolbar, Enter-sends, optimistic-and-reconcile).

**Tech Stack:** Go (stdlib net/http), `slackapi` package; React 18 + TS + Mantine v7; existing SSE/useThread live-update path.

## Global Constraints

- SAFETY: never send a real reply to a multi-person thread during development. All live reply/mark-unread probes use ONLY the user's self-channel test thread: channel `DMFAS8V0X`, thread_ts `1786457091.390699`. Before ANY live `chat.postMessage`, confirm the target channel is `DMFAS8V0X`.
- Send-allowlist: optional `send_allowlist []string` in `~/.config/slack-mini/slack-mini.yaml`. Non-empty → `/api/thread/reply` rejects any channel not in the list with HTTP 403 and a readable error. Empty/absent → no restriction. NOT written by a fresh `slack-mini setup`. For dev, the user's config is seeded with `send_allowlist: ["DMFAS8V0X"]`. No proactive UI / no `/api/config` exposure — the server 403 is the safeguard; the composer surfaces it as a readable send error.
- Slack auth/call conventions (unchanged): `POST https://slack.com/api/{method}`, `Authorization: Bearer <xoxc>` + `Cookie: d=<xoxd>`, via the existing `HTTPClient.call`. `subscriptions.thread.mark` is form-encoded. `chat.postMessage` payload format (form vs JSON) is VERIFIED via a live probe in Task 3 before wiring.
- `slackapi` returns domain structs, never raw Slack JSON. Client methods go on both the `Client` interface and `HTTPClient`, and every fake client in tests (server_test.go `fakeClient`; watcher_test.go `fakeClient`/`slowClient`/`countingClient`/`controlledClient`) must implement any new interface method.
- Endpoint error mapping: `errors.Is(err, slackapi.ErrAuth)` → 401; allowlist-blocked → 403; empty/missing fields → 400; other → 502. Mirror the existing `handleMarkRead` (internal/server/proxy.go) shape.
- TDD: failing test → confirm fail → implement → confirm pass → commit. `go test ./... -race`, `go vet`, `gofmt -l .` clean; `cd ui && npx vitest run`, `npm run build`, `go build ./...` all green before commit.
- Commit style: conventional prefix, `--signoff`, end body with exactly:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- After live probes confirm details, UPDATE `docs/reverse-engineering/slack-web-api.md` (chat.postMessage payload+response; subscriptions.thread.mark read=0 for mark-unread).

---

# Part A — Mark Unread From Here (Step 0)

Ships first so the user can give styling feedback before reply-sending.

### Task 1: config send-allowlist field

**Files:**
- Modify: `internal/config/config.go` (add field)
- Modify: `internal/config/config_test.go` (round-trip includes the field)

**Interfaces:**
- Produces: `Config.SendAllowlist []string` with yaml tag `send_allowlist`.

- [ ] **Step 1: Write the failing test** — extend the existing save/load round-trip test to include the allowlist.

```go
// in config_test.go TestSaveThenLoadRoundTrips, add to the in-Config:
//   SendAllowlist: []string{"DMFAS8V0X"},
// and after Load, assert:
if len(got.SendAllowlist) != 1 || got.SendAllowlist[0] != "DMFAS8V0X" {
    t.Fatalf("SendAllowlist round trip mismatch: %+v", got.SendAllowlist)
}
```

- [ ] **Step 2: Run to verify fail**

Run: `go test ./internal/config/ -run TestSaveThenLoad -v`
Expected: FAIL (field doesn't exist / not persisted).

- [ ] **Step 3: Add the field**

```go
// internal/config/config.go — add to Config struct:
	SendAllowlist   []string `yaml:"send_allowlist"`
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/config/ -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/config/
git commit --signoff -m "feat: add send_allowlist config field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: slackapi.MarkUnread (with live probe)

**Files:**
- Modify: `internal/slackapi/client.go` (interface + method)
- Modify: `internal/slackapi/client_test.go` (httptest)
- Modify: `internal/server/server_test.go`, `internal/watcher/watcher_test.go` (add `MarkUnread` to all fake clients)

**Interfaces:**
- Produces: `MarkUnread(ctx context.Context, channel, threadTS, ts string) error` on `Client` + `HTTPClient`. Calls `subscriptions.thread.mark` form-encoded with `channel`, `thread_ts`, `ts`, `read=0`.

- [ ] **Step 1: LIVE PROBE (verify the mark-unread param shape).** Marking unread is safe (posts nothing, only moves the current user's read cursor). Probe against the self-channel test thread. In a shell (tokens from `~/.local/share/slack-mcp/tokens.env`):

```bash
# Load the session tokens from the slack-mcp tokens file:
set -a; . ~/.local/share/slack-mcp/tokens.env; set +a
T="$SLACK_MCP_XOXC_TOKEN"; C="$SLACK_MCP_XOXD_TOKEN"
# Mark unread from a reply ts in the self-channel test thread:
curl -s -X POST https://slack.com/api/subscriptions.thread.mark \
  -H "Authorization: Bearer $T" -H "Cookie: d=$C" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode channel=DMFAS8V0X --data-urlencode thread_ts=1786457091.390699 \
  --data-urlencode ts=<a-reply-ts-in-that-thread> --data-urlencode read=0
```
Expected: `{"ok":true}`. Confirm in the slack-mini UI (or a re-fetch) that the thread now shows unread from that ts. If `read=0` is not the correct param, adjust (record the working shape). DO NOT proceed to Step 3 until the probe returns `ok:true` and produces the unread state. Record the confirmed shape in the RE doc as part of this task's final commit.

- [ ] **Step 2: Write the failing test (httptest, no real network)**

```go
// client_test.go
func TestMarkUnreadPostsReadZero(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body); gotBody = string(b)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("xoxc-t", "xoxd-c", srv.URL)
	if err := c.MarkUnread(context.Background(), "C1", "1.1", "1.2"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"channel=C1", "thread_ts=1.1", "ts=1.2", "read=0"} {
		if !strings.Contains(gotBody, want) { t.Fatalf("body %q missing %q", gotBody, want) }
	}
}
```

- [ ] **Step 3: Run to verify fail** — `go test ./internal/slackapi/ -run TestMarkUnread -v` → FAIL (undefined).

- [ ] **Step 4: Implement** — add to the interface and HTTPClient (mirror `MarkRead`):

```go
// client.go interface: add
	MarkUnread(ctx context.Context, channel, threadTS, ts string) error
// client.go impl:
func (c *HTTPClient) MarkUnread(ctx context.Context, channel, threadTS, ts string) error {
	return c.call(ctx, "subscriptions.thread.mark", url.Values{
		"channel": {channel}, "thread_ts": {threadTS}, "ts": {ts}, "read": {"0"},
	}, nil)
}
```
Add a trivial `MarkUnread` returning `nil` to every fake client (server_test.go `fakeClient`; watcher_test.go's 4 fakes) so they still satisfy `Client`.

- [ ] **Step 5: Run to verify pass** — `go test ./... -race` → PASS.

- [ ] **Step 6: Update the RE doc** — in `docs/reverse-engineering/slack-web-api.md`, add a note under the mark-read section: `subscriptions.thread.mark` with `read=0` (same channel/thread_ts/ts) marks the thread unread from `ts` for the current user (verified <date>).

- [ ] **Step 7: Commit**

```bash
git add internal/slackapi/ internal/server/server_test.go internal/watcher/watcher_test.go docs/reverse-engineering/slack-web-api.md
git commit --signoff -m "feat: slackapi MarkUnread via subscriptions.thread.mark read=0

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: /api/thread/mark-unread endpoint

**Files:**
- Modify: `internal/server/proxy.go` (handler), `internal/server/server.go` (route)
- Modify: `internal/server/server_test.go` (endpoint test)

**Interfaces:**
- Consumes: `slackapi.Client.MarkUnread`.
- Produces: `POST /api/thread/mark-unread` body `{channel, thread_ts, ts}` → 204 on success; 401 on `ErrAuth`; 400 on missing fields; 502 other. `fakeClient` gains a `markUnreadTS string` capture field.

- [ ] **Step 1: Write the failing test**

```go
func TestMarkUnreadCallsClient(t *testing.T) {
	fc := &fakeClient{}
	s := New(&config.Config{}, fc, nil)
	body := strings.NewReader(`{"channel":"C","thread_ts":"1.1","ts":"1.2"}`)
	req := httptest.NewRequest("POST", "/api/thread/mark-unread", body)
	rec := httptest.NewRecorder(); s.Handler().ServeHTTP(rec, req)
	if rec.Code != 204 { t.Fatalf("code=%d", rec.Code) }
	if fc.markUnreadTS != "1.2" { t.Fatalf("markUnread ts=%q", fc.markUnreadTS) }
}
```
(Add `markUnreadTS` to `fakeClient` and set it in its `MarkUnread`.)

- [ ] **Step 2: Run to verify fail** — `go test ./internal/server/ -run TestMarkUnread -v` → FAIL.

- [ ] **Step 3: Implement** — mirror `handleMarkRead` in proxy.go (decode `{channel, thread_ts, ts}`, 400 on any empty, call `MarkUnread`, `ErrAuth`→401, other→502, success→204). Register `mux.HandleFunc("/api/thread/mark-unread", s.handleMarkUnread)` in server.go.

- [ ] **Step 4: Run to verify pass** — `go test ./... -race` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/
git commit --signoff -m "feat: POST /api/thread/mark-unread endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: "Mark unread from here" hover action (frontend, Step 0)

**Files:**
- Modify: `ui/src/lib/api.ts` (add `markUnread`)
- Modify: `ui/src/components/Message.tsx` (hover action + prop)
- Modify: `ui/src/components/ThreadView.tsx` (pass handler; refetch on success)
- Modify: `ui/src/components/Message.test.tsx`

**Interfaces:**
- Consumes: `POST /api/thread/mark-unread`.
- Produces: `api.markUnread(channel, threadTs, ts): Promise<void>`; `Message` gains an optional `onMarkUnread?: (ts: string) => void` prop that renders a hover action.

- [ ] **Step 1: Add `markUnread` to api.ts** (mirror `markRead`):

```ts
export async function markUnread(channel: string, threadTs: string, ts: string): Promise<void> {
  const res = await fetch('/api/thread/mark-unread', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: threadTs, ts }),
  })
  if (!res.ok) throw new Error(`mark-unread failed: ${res.status}`)
}
```

- [ ] **Step 2: Write the failing Message test** — hovering shows a "Mark unread from here" control that calls `onMarkUnread` with the message ts.

```tsx
it('calls onMarkUnread with the message ts when the hover action is clicked', () => {
  const onMarkUnread = vi.fn()
  const message = baseMessage({ TS: '111.222' })
  const { getByLabelText } = renderWithProvider(
    <Message message={message} users={users} emoji={{}} onMarkUnread={onMarkUnread} />,
  )
  fireEvent.click(getByLabelText('Mark unread from here'))
  expect(onMarkUnread).toHaveBeenCalledWith('111.222')
})
```

- [ ] **Step 3: Run to verify fail** — `cd ui && npx vitest run src/components/Message.test.tsx` → FAIL.

- [ ] **Step 4: Implement** — add `onMarkUnread?: (ts: string) => void` to `MessageProps`. Render a subtle action (Mantine `ActionIcon`, e.g. an "unread"/dot icon or a small button) with `aria-label="Mark unread from here"`, visible on row hover (use a CSS hover reveal — e.g. a wrapper with a `:hover` that shows the action, or Mantine `hoverCard`/opacity; keep it unobtrusive so the user can restyle). onClick → `onMarkUnread(message.TS)`. In `ThreadView`, pass `onMarkUnread={handleMarkUnread}` where `handleMarkUnread(ts)` calls `api.markUnread(tab.channel, tab.threadTs, ts)` then triggers a thread refresh (reuse the existing `refresh()` from useThread) so the divider + tab dot update.

- [ ] **Step 5: Run to verify pass** — `cd ui && npx vitest run` → PASS; `npm run build`; `go build ./...`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/api.ts ui/src/components/Message.tsx ui/src/components/ThreadView.tsx ui/src/components/Message.test.tsx
git commit --signoff -m "feat(ui): 'Mark unread from here' per-message hover action

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: STOP for user style feedback.** Rebuild + live-verify in the browser (mark unread from a message in the self-channel test thread; confirm the divider moves and the tab dot lights). Present to the user for styling feedback before starting Part B.

---

# Part B — Reply Sending

### Task 5: slackapi.PostReply (with live probe)

**Files:**
- Modify: `internal/slackapi/client.go`, `internal/slackapi/client_test.go`
- Modify: `internal/server/server_test.go`, `internal/watcher/watcher_test.go` (fakes)

**Interfaces:**
- Produces: `PostReply(ctx context.Context, channel, threadTS, text string) (Message, error)` on `Client` + `HTTPClient`. Calls `chat.postMessage`; returns the created message normalized (at minimum `TS`, `UserID`, `Text`; `Blocks` if present in the response).

- [ ] **Step 1: LIVE PROBE (verify chat.postMessage payload format + response) — SELF-CHANNEL ONLY.** Confirm the target is `DMFAS8V0X`. Post a test reply to the self-channel test thread and inspect the response:

```bash
set -a; . ~/.local/share/slack-mcp/tokens.env; set +a
T="$SLACK_MCP_XOXC_TOKEN"; C="$SLACK_MCP_XOXD_TOKEN"
# form-encoded attempt:
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $T" -H "Cookie: d=$C" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode channel=DMFAS8V0X --data-urlencode thread_ts=1786457091.390699 \
  --data-urlencode text='slack-mini v2 probe (form)'
```
Expected: `{"ok":true,"ts":"...","message":{...}}`. If form fails, try JSON body (`-H 'Content-Type: application/json; charset=utf-8'` with a JSON object and, for session tokens, the token in the Authorization header). Record which format returns `ok:true` and the shape of `message` (does it include `ts`, `user`, `text`, `blocks`?). DO NOT proceed until confirmed against `DMFAS8V0X`. Update the RE doc with the confirmed format + response shape in this task's commit.

- [ ] **Step 2: Write the failing test (httptest)** — assert the method, params/text, and that the returned Message carries the response's ts.

```go
func TestPostReplyReturnsCreatedMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// respond like chat.postMessage
		w.Write([]byte(`{"ok":true,"ts":"1700.9","message":{"ts":"1700.9","user":"U1","text":"hi"}}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("xoxc-t", "xoxd-c", srv.URL)
	msg, err := c.PostReply(context.Background(), "C1", "1.1", "hi")
	if err != nil { t.Fatal(err) }
	if msg.TS != "1700.9" || msg.Text != "hi" { t.Fatalf("msg=%+v", msg) }
}

func TestPostReplyAuthError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"invalid_auth"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("x","y",srv.URL)
	if _, err := c.PostReply(context.Background(),"C","1.1","hi"); !errors.Is(err, ErrAuth) {
		t.Fatalf("err=%v want ErrAuth", err)
	}
}
```

- [ ] **Step 3: Run to verify fail** — `go test ./internal/slackapi/ -run TestPostReply -v` → FAIL.

- [ ] **Step 4: Implement** — add to interface + HTTPClient using the payload format confirmed in Step 1. Decode the response's `message`/`ts` and normalize to a domain `Message` (reuse the raw→domain mapping used by `NormalizeThread` for a single message if convenient; at minimum map `ts`,`user`,`text`,`blocks`). Map `ok:false` errors via the existing `call` error handling (ErrAuth etc.). Add `PostReply` to all fake clients (server_test.go returns a canned Message + optional error field; watcher fakes return zero Message, nil).

- [ ] **Step 5: Run to verify pass** — `go test ./... -race` → PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/slackapi/ internal/server/server_test.go internal/watcher/watcher_test.go docs/reverse-engineering/slack-web-api.md
git commit --signoff -m "feat: slackapi PostReply via chat.postMessage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: /api/thread/reply endpoint (allowlist + mark-read on success)

**Files:**
- Modify: `internal/server/proxy.go` (handler), `internal/server/server.go` (route; Server already has `cfg`)
- Modify: `internal/server/server_test.go`

**Interfaces:**
- Consumes: `slackapi.Client.PostReply`, `MarkRead`; `config.Config.SendAllowlist`.
- Produces: `POST /api/thread/reply` body `{channel, thread_ts, text}` → 200 with the created message JSON on success; 403 if allowlist non-empty and channel not listed (readable error body); 400 empty text/fields; 401 ErrAuth; 502 other. On success also calls `MarkRead(channel, thread_ts, newMsg.TS)` (best-effort: log on failure, still return 200 with the message).

- [ ] **Step 1: Write failing tests**

```go
func TestReplyPostsAndMarksRead(t *testing.T) {
	fc := &fakeClient{replyMsg: slackapi.Message{TS: "1700.9", Text: "hi"}}
	s := New(&config.Config{}, fc, nil) // empty allowlist = unrestricted
	body := strings.NewReader(`{"channel":"C","thread_ts":"1.1","text":"hi"}`)
	req := httptest.NewRequest("POST", "/api/thread/reply", body)
	rec := httptest.NewRecorder(); s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 { t.Fatalf("code=%d body=%s", rec.Code, rec.Body) }
	if !strings.Contains(rec.Body.String(), "1700.9") { t.Fatalf("resp missing new ts: %s", rec.Body) }
	if fc.markedTS != "1700.9" { t.Fatalf("should mark read up to new msg; got %q", fc.markedTS) }
}

func TestReplyBlockedByAllowlist(t *testing.T) {
	fc := &fakeClient{}
	s := New(&config.Config{SendAllowlist: []string{"DMFAS8V0X"}}, fc, nil)
	body := strings.NewReader(`{"channel":"C0OTHER","thread_ts":"1.1","text":"hi"}`)
	req := httptest.NewRequest("POST", "/api/thread/reply", body)
	rec := httptest.NewRecorder(); s.Handler().ServeHTTP(rec, req)
	if rec.Code != 403 { t.Fatalf("code=%d, want 403", rec.Code) }
	if fc.replyCalled { t.Fatal("must NOT call PostReply for a blocked channel") }
}

func TestReplyAllowedWhenInAllowlist(t *testing.T) {
	fc := &fakeClient{replyMsg: slackapi.Message{TS: "1700.9", Text: "hi"}}
	s := New(&config.Config{SendAllowlist: []string{"DMFAS8V0X"}}, fc, nil)
	body := strings.NewReader(`{"channel":"DMFAS8V0X","thread_ts":"1.1","text":"hi"}`)
	req := httptest.NewRequest("POST", "/api/thread/reply", body)
	rec := httptest.NewRecorder(); s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 { t.Fatalf("code=%d", rec.Code) }
}

func TestReplyEmptyTextReturns400(t *testing.T) {
	s := New(&config.Config{}, &fakeClient{}, nil)
	body := strings.NewReader(`{"channel":"C","thread_ts":"1.1","text":"  "}`)
	req := httptest.NewRequest("POST", "/api/thread/reply", body)
	rec := httptest.NewRecorder(); s.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 { t.Fatalf("code=%d, want 400", rec.Code) }
}
```
(Extend `fakeClient` with `replyMsg slackapi.Message`, `replyErr error`, `replyCalled bool`, and a `PostReply` that records the call/returns replyMsg,replyErr; keep the existing `markedTS` capture from MarkRead.)

- [ ] **Step 2: Run to verify fail** — `go test ./internal/server/ -run TestReply -v` → FAIL.

- [ ] **Step 3: Implement `handleReply`** in proxy.go:
  - Decode `{channel, thread_ts, text}`; trim text; empty → 400.
  - Allowlist check: `if len(s.cfg.SendAllowlist) > 0 && !contains(s.cfg.SendAllowlist, channel) { http.Error(w, "sending is disabled for this channel (not in send_allowlist)", 403); return }`.
  - `msg, err := s.client.PostReply(ctx, channel, thread_ts, text)`; `ErrAuth`→401, other→502.
  - On success: `if err := s.client.MarkRead(ctx, channel, thread_ts, msg.TS); err != nil { log.Printf("reply: mark-read after send failed: %v", err) }` (non-fatal).
  - Write the created message as JSON (200). Reuse the same MessageView/JSON shape the thread endpoint uses for a single message so the frontend can render it consistently.
  Register the route in server.go.

- [ ] **Step 4: Run to verify pass** — `go test ./... -race` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/
git commit --signoff -m "feat: POST /api/thread/reply with send-allowlist and mark-read on success

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Reply composer (frontend) — send, optimistic+reconcile, toolbar

**Files:**
- Create: `ui/src/components/Composer.tsx`, `ui/src/components/Composer.test.tsx`
- Modify: `ui/src/lib/api.ts` (add `postReply`), `ui/src/components/ThreadView.tsx` (render composer above footer; optimistic state + reconcile)

**Interfaces:**
- Consumes: `POST /api/thread/reply`.
- Produces:
  - `api.postReply(channel, threadTs, text): Promise<Message>` (returns the created message JSON, typed as the existing `Message`).
  - `Composer` component: props `{ onSend: (text: string) => void; disabled?: boolean }`. Renders a Mantine `Textarea` (autosize), an mrkdwn toolbar (bold/italic/code/link that wrap the current selection), and a Send button. Enter → `onSend(text)` and clear; Shift+Enter → newline. Empty/whitespace text → Send disabled and Enter does nothing.

- [ ] **Step 1: Add `postReply` to api.ts**

```ts
export async function postReply(channel: string, threadTs: string, text: string): Promise<Message> {
  const res = await fetch('/api/thread/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  })
  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(msg || `reply failed: ${res.status}`)
  }
  return (await res.json()) as Message
}
```

- [ ] **Step 2: Write failing Composer tests**

```tsx
it('sends on Enter and clears; Shift+Enter inserts a newline', () => {
  const onSend = vi.fn()
  const { getByRole } = renderWithProvider(<Composer onSend={onSend} />)
  const ta = getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: 'hello' } })
  fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
  expect(onSend).not.toHaveBeenCalled() // shift+enter = newline
  fireEvent.keyDown(ta, { key: 'Enter' })
  expect(onSend).toHaveBeenCalledWith('hello')
})

it('disables Send for empty/whitespace text', () => {
  const onSend = vi.fn()
  const { getByRole } = renderWithProvider(<Composer onSend={onSend} />)
  const send = getByRole('button', { name: /send/i })
  expect(send).toBeDisabled()
  fireEvent.change(getByRole('textbox'), { target: { value: '   ' } })
  expect(send).toBeDisabled()
})

it('bold toolbar wraps the selection in *asterisks*', () => {
  const { getByRole, getByLabelText } = renderWithProvider(<Composer onSend={() => {}} />)
  const ta = getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(ta, { target: { value: 'word' } })
  ta.setSelectionRange(0, 4)
  fireEvent.click(getByLabelText('Bold'))
  expect(ta.value).toBe('*word*')
})
```

- [ ] **Step 3: Run to verify fail** — `cd ui && npx vitest run src/components/Composer.test.tsx` → FAIL (no component).

- [ ] **Step 4: Implement `Composer.tsx`** — Mantine `Textarea` (autosize, minRows 1), a toolbar row of `ActionIcon`s labelled Bold/Italic/Code/Link that wrap the current selection (`selectionStart/End`) with `*`/`_`/`` ` ``/`<url|text>` (for link, a simple prompt or wrap-as-`<text>` is fine — keep minimal), and a Send `Button`. `onKeyDown`: Enter (no shift) → if non-empty, `onSend(trimmed)`; preventDefault; clear. Shift+Enter → default (newline). Send button disabled when trimmed empty or `disabled` prop.

- [ ] **Step 5: Run to verify pass** — `cd ui && npx vitest run` → PASS.

- [ ] **Step 6: Wire into ThreadView (optimistic + reconcile)** — render `<Composer onSend={handleSend} />` ABOVE the floating footer. `handleSend(text)`:
  - Append an optimistic message to a local `pending` list: `{ ts: 'pending-'+localId, UserID: currentUserId, Text: text, status: 'sending' }`, rendered after the real messages with a "sending…" affordance.
  - `try { const msg = await api.postReply(tab.channel, tab.threadTs, text) }`:
    - success → mark that pending entry 'sent' with the real `msg.TS`; the next SSE/refresh will include the real message — dedupe so we don't show it twice (when `data.messages` contains a message whose `TS === msg.TS`, drop the pending entry with that ts).
    - failure → mark the pending entry 'failed' with the error text; keep it with a retry affordance (clicking retry re-posts the same text).
  - Render pending entries (sending/failed) after `data.messages`. Reconciliation: when rendering, filter out any pending entry whose real ts now appears in `data.messages`.
  Keep the composer controlled by its own internal text state (cleared on successful enqueue).

- [ ] **Step 7: Run to verify pass** — `cd ui && npx vitest run`; `npm run build`; `go build ./...` → all PASS/succeed.

- [ ] **Step 8: Commit**

```bash
git add ui/src/lib/api.ts ui/src/components/Composer.tsx ui/src/components/Composer.test.tsx ui/src/components/ThreadView.tsx
git commit --signoff -m "feat(ui): reply composer with mrkdwn toolbar and optimistic send

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Live end-to-end verification (self-channel only) + seed dev allowlist

**Files:** none (verification + local config).

- [ ] **Step 1: Seed the dev allowlist** in the user's config `~/.config/slack-mini/slack-mini.yaml`: add `send_allowlist: ["DMFAS8V0X"]` (preserve existing token/cookie/workspace_domain/port; do not print secrets). This ensures a stray send to any other channel is refused during testing.

- [ ] **Step 2: Rebuild + serve** — `cd ui && npm run build && cd .. && go build -o bin/slack-mini . && ./bin/slack-mini serve`.

- [ ] **Step 3: Live verify in the SELF-CHANNEL test thread only** (`DMFAS8V0X` / `1786457091.390699`):
  - Send a reply from the composer → appears optimistically, then reconciles to the real message; the thread's unread state clears (mark-read on send); Enter sends, Shift+Enter newlines; toolbar wraps selection.
  - Attempt a send while viewing a NON-allowlisted channel (open any other read thread) → the composer shows the readable 403 error and no message is posted. (Confirm via the UI; do not actually reach Slack.)
  - Mark-unread hover action still works.
- [ ] **Step 4:** Present results to the user. Do NOT test sending in any multi-person thread.

---

## Notes for the executor

- SAFETY is paramount: the only channel any live send touches is `DMFAS8V0X`. Before running the Task 5 probe or Task 8 send, echo/confirm the channel is `DMFAS8V0X`.
- Follow Global Constraints for every task; run `make test` (or the go+vitest commands) before each commit.
- Two tasks (2, 5) begin with a LIVE PROBE that gates implementation — do not write the client method until the probe confirms the wire shape, and update the RE doc in the same task.
- Part A ends at a user style-feedback checkpoint (Task 4 Step 7) before Part B begins.
