# slack-mini — toggleable reaction pills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user click an existing reaction pill to add/remove themselves from that reaction (Slack `reactions.add`/`reactions.remove`), with optimistic UI and the same write-safety guard as replies.

**Architecture:** Add `AddReaction`/`RemoveReaction` to the `slackapi.Client`; expose them via a new `POST /api/thread/react` handler gated by the existing `send_allowlist` (403 before any Slack call); toggle optimistically on the frontend via a pure `applyReactionToggle` reducer + `applyLocal`, rolling back with `refresh()` on any error (including a disallowed-channel 403). No emoji picker (out of scope).

**Tech Stack:** Go (stdlib net/http, encoding/json), React 18 + TypeScript + Vite + Mantine v7, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-18-slack-mini-reaction-toggle-design.md`

## Global Constraints

- **Slack write safety:** the `send_allowlist` guard MUST run before any Slack write. If `len(cfg.SendAllowlist) > 0 && !containsString(cfg.SendAllowlist, channel)` → HTTP 403 before calling the client. Empty/nil allowlist = unrestricted (consistent with `handleReply`). During any live testing, only ever write to the self-channel `DMFAS8V0X`; never toggle a reaction in a shared thread.
- `slackapi` returns domain types; all Slack quirks stay in that package. `reactions.add`/`reactions.remove` are keyed by the **message `ts`** (form field `timestamp`), NOT the thread ts. Emoji `name` has NO surrounding colons.
- Slack idempotency errors are treated as SUCCESS: `reactions.add` → `already_reacted`; `reactions.remove` → `no_reaction`. All other Slack errors propagate. `call()` surfaces non-auth Slack errors as `fmt.Errorf("slack error: %s", head.Error)`, so detect these by substring on the error text.
- Wire format: request bodies use snake_case JSON (matching `replyRequest`). `ThreadResponse`/`Message` nested fields are PascalCase in TS.
- Frontend tests: NO jest-dom; `afterEach(cleanup)`; `window.matchMedia` stub; `MantineProvider` wrapper. Copy the pattern from `ui/src/components/ReactionPill.test.tsx`.
- Optimistic-UI rollback uses `refresh()` (re-fetch), mirroring `handleMarkUnread` — NOT snapshot/restore.
- Commits: conventional-commit prefix, `--signoff`, and end each message with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Add files by name; never `git add -A`.
- Run `make test` before the final commit.

## File Structure

- `internal/slackapi/client.go` — MODIFY: add `AddReaction`/`RemoveReaction` to the `Client` interface + `HTTPClient`.
- `internal/slackapi/client_test.go` — MODIFY/ADD: stub-server tests for the two methods incl. idempotency mapping.
- `internal/server/proxy.go` — MODIFY: add `reactRequest` + `handleReact` (allowlist-guarded).
- `internal/server/server.go` — MODIFY: register `POST /api/thread/react`.
- `internal/server/server_test.go` — MODIFY: extend `fakeClient` with the two methods; test `handleReact`.
- `ui/src/lib/reactionToggle.ts` — CREATE: pure `applyReactionToggle` reducer.
- `ui/src/lib/reactionToggle.test.ts` — CREATE: reducer unit tests.
- `ui/src/lib/api.ts` — MODIFY: add `toggleReaction`.
- `ui/src/components/ReactionPill.tsx` — MODIFY: optional `onToggle`; clickable when toggle enabled.
- `ui/src/components/ReactionPill.test.tsx` — MODIFY: click-calls-onToggle + display-only cases.
- `ui/src/components/Message.tsx` — MODIFY: thread `onToggleReaction` through to `ReactionPill`.
- `ui/src/components/ThreadView.tsx` — MODIFY: `handleToggleReaction` (optimistic + rollback); pass to `Message`.
- `docs/reverse-engineering/slack-web-api.md` — MODIFY: document `reactions.add`/`reactions.remove`.

---

## Task 1: slackapi AddReaction / RemoveReaction

**Files:**
- Modify: `internal/slackapi/client.go`
- Test: `internal/slackapi/client_test.go`

**Interfaces:**
- Produces: `AddReaction(ctx, channel, ts, name string) error` and `RemoveReaction(ctx, channel, ts, name string) error` on both the `Client` interface and `HTTPClient`.

- [ ] **Step 1: Write the failing tests**

Add to `internal/slackapi/client_test.go`. Follow the existing stub-server style in that file (find an existing test that stands up an `httptest.Server` and constructs the client via `NewWithBaseURL`; mirror it). Tests:

```go
func TestAddReaction_SendsParams(t *testing.T) {
	var gotPath string
	var gotForm url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = r.ParseForm()
		gotForm = r.Form
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("tok", "cook", srv.URL)
	if err := c.AddReaction(context.Background(), "C1", "1700000000.000100", "tada"); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/reactions.add" {
		t.Errorf("path = %q, want /reactions.add", gotPath)
	}
	if gotForm.Get("channel") != "C1" || gotForm.Get("timestamp") != "1700000000.000100" || gotForm.Get("name") != "tada" {
		t.Errorf("form = %v", gotForm)
	}
}

func TestAddReaction_AlreadyReactedIsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"already_reacted"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("tok", "cook", srv.URL)
	if err := c.AddReaction(context.Background(), "C1", "1", "tada"); err != nil {
		t.Errorf("already_reacted should be success, got %v", err)
	}
}

func TestRemoveReaction_NoReactionIsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"no_reaction"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("tok", "cook", srv.URL)
	if err := c.RemoveReaction(context.Background(), "C1", "1", "tada"); err != nil {
		t.Errorf("no_reaction should be success, got %v", err)
	}
}

func TestRemoveReaction_OtherErrorPropagates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"message_not_found"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("tok", "cook", srv.URL)
	if err := c.RemoveReaction(context.Background(), "C1", "1", "tada"); err == nil {
		t.Error("expected message_not_found to propagate")
	}
}
```

Ensure `net/url`, `net/http`, `net/http/httptest`, `context` are imported (add any missing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/slackapi/ -run 'Reaction'`
Expected: FAIL — `AddReaction`/`RemoveReaction` undefined.

- [ ] **Step 3: Implement the methods**

In `internal/slackapi/client.go`, add to the `Client` interface (after `PostReply`):

```go
	AddReaction(ctx context.Context, channel, ts, name string) error
	RemoveReaction(ctx context.Context, channel, ts, name string) error
```

Add the implementations near `MarkRead` (ensure `strings` is imported — it already is):

```go
// AddReaction adds the current user's reaction `name` (no colons) to the
// message at `ts` in `channel` via reactions.add. Slack's `already_reacted`
// error means the reaction is already present, which is the desired end state,
// so it is treated as success.
func (c *HTTPClient) AddReaction(ctx context.Context, channel, ts, name string) error {
	err := c.call(ctx, "reactions.add", url.Values{
		"channel":   {channel},
		"timestamp": {ts},
		"name":      {name},
	}, nil)
	if err != nil && strings.Contains(err.Error(), "already_reacted") {
		return nil
	}
	return err
}

// RemoveReaction removes the current user's reaction `name` from the message at
// `ts` via reactions.remove. Slack's `no_reaction` error means it was already
// absent (the desired end state), so it is treated as success.
func (c *HTTPClient) RemoveReaction(ctx context.Context, channel, ts, name string) error {
	err := c.call(ctx, "reactions.remove", url.Values{
		"channel":   {channel},
		"timestamp": {ts},
		"name":      {name},
	}, nil)
	if err != nil && strings.Contains(err.Error(), "no_reaction") {
		return nil
	}
	return err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/slackapi/`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add internal/slackapi/client.go internal/slackapi/client_test.go
git commit --signoff -m "feat(slackapi): add AddReaction/RemoveReaction

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: server POST /api/thread/react (allowlist-guarded)

**Files:**
- Modify: `internal/server/proxy.go`, `internal/server/server.go`
- Test: `internal/server/server_test.go`

**Interfaces:**
- Consumes: `Client.AddReaction`/`RemoveReaction` (Task 1); `containsString`, `s.cfg.SendAllowlist`.
- Produces: `POST /api/thread/react`.

- [ ] **Step 1: Write the failing tests**

First, the test `fakeClient` (in `server_test.go`) must satisfy the `Client` interface, which Task 1 widened — add the two methods to it, recording calls:

```go
	// add these fields to fakeClient:
	reactAddTS, reactRemoveTS, reactName string
	reactCalls                           int
```

```go
func (f *fakeClient) AddReaction(_ context.Context, _ , ts, name string) error {
	f.reactCalls++
	f.reactAddTS, f.reactName = ts, name
	return f.err
}
func (f *fakeClient) RemoveReaction(_ context.Context, _, ts, name string) error {
	f.reactCalls++
	f.reactRemoveTS, f.reactName = ts, name
	return f.err
}
```

(Match the receiver name and existing field/style already used by `fakeClient` — read the struct first. If `err` is already a field used to simulate failures, reuse it; otherwise use the existing failure-injection field.)

Then the handler tests:

```go
func TestHandleReact_AllowedAddsReaction(t *testing.T) {
	fc := &fakeClient{}
	s := newTestServer(t, fc, config.Config{}) // empty allowlist = unrestricted
	body := `{"channel":"C1","ts":"1700000000.000100","name":"tada","add":true}`
	rr := doPost(t, s, "/api/thread/react", body)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body)
	}
	if fc.reactCalls != 1 || fc.reactAddTS != "1700000000.000100" || fc.reactName != "tada" {
		t.Errorf("AddReaction not called correctly: calls=%d ts=%q name=%q", fc.reactCalls, fc.reactAddTS, fc.reactName)
	}
}

func TestHandleReact_BlockedByAllowlist(t *testing.T) {
	fc := &fakeClient{}
	s := newTestServer(t, fc, config.Config{SendAllowlist: []string{"DMFAS8V0X"}})
	body := `{"channel":"C1","ts":"1","name":"tada","add":true}`
	rr := doPost(t, s, "/api/thread/react", body)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
	if fc.reactCalls != 0 {
		t.Error("client must NOT be called when channel is not in allowlist")
	}
}

func TestHandleReact_RemoveDispatches(t *testing.T) {
	fc := &fakeClient{}
	s := newTestServer(t, fc, config.Config{})
	body := `{"channel":"C1","ts":"9","name":"eyes","add":false}`
	rr := doPost(t, s, "/api/thread/react", body)
	if rr.Code != http.StatusOK || fc.reactRemoveTS != "9" || fc.reactName != "eyes" {
		t.Fatalf("remove not dispatched: code=%d ts=%q name=%q", rr.Code, fc.reactRemoveTS, fc.reactName)
	}
}

func TestHandleReact_BadBody(t *testing.T) {
	fc := &fakeClient{}
	s := newTestServer(t, fc, config.Config{})
	rr := doPost(t, s, "/api/thread/react", `{"channel":"","ts":"","name":"","add":true}`)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}
```

NOTE: `newTestServer`/`doPost` are placeholders — use whatever construction and request helpers the existing `server_test.go` already uses for `handleReply` tests (read the file: find `TestHandleReply*` and copy its exact setup — server construction, config injection, and request execution). Do not invent helpers that don't exist; reuse the file's conventions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/ -run 'React'`
Expected: FAIL — handler/route not present (and fakeClient may need the methods to compile; add those first so the package compiles, then the handler tests fail on 404/route).

- [ ] **Step 3: Implement the handler**

In `internal/server/proxy.go`, add near `replyRequest`/`handleReply`:

```go
type reactRequest struct {
	Channel string `json:"channel"`
	TS      string `json:"ts"`
	Name    string `json:"name"`
	Add     bool   `json:"add"`
}

// handleReact implements POST /api/thread/react: it toggles the current user's
// reaction on a message via reactions.add/remove, subject to the same
// send-allowlist guard as replies. The allowlist check MUST happen before any
// Slack call.
func (s *Server) handleReact(w http.ResponseWriter, r *http.Request) {
	var req reactRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if req.Channel == "" || req.TS == "" || req.Name == "" {
		http.Error(w, "channel, ts, and name required", http.StatusBadRequest)
		return
	}
	if len(s.cfg.SendAllowlist) > 0 && !containsString(s.cfg.SendAllowlist, req.Channel) {
		http.Error(w, "reacting is disabled for this channel (not in send_allowlist)", http.StatusForbidden)
		return
	}

	var err error
	if req.Add {
		err = s.client.AddReaction(r.Context(), req.Channel, req.TS, req.Name)
	} else {
		err = s.client.RemoveReaction(r.Context(), req.Channel, req.TS, req.Name)
	}
	if errors.Is(err, slackapi.ErrAuth) {
		http.Error(w, "auth", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusOK)
}
```

In `internal/server/server.go`, register the route beside the other thread mutations (near `mux.HandleFunc("/api/thread/reply", ...)`):

```go
	mux.HandleFunc("/api/thread/react", s.handleReact)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/server/`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add internal/server/proxy.go internal/server/server.go internal/server/server_test.go
git commit --signoff -m "feat(server): POST /api/thread/react to toggle reactions (allowlist-guarded)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: frontend reducer + api client

**Files:**
- Create: `ui/src/lib/reactionToggle.ts`, `ui/src/lib/reactionToggle.test.ts`
- Modify: `ui/src/lib/api.ts`

**Interfaces:**
- Produces:
  - `applyReactionToggle(messages: Message[], ts: string, name: string, userId: string, add: boolean): Message[]`
  - `toggleReaction(channel: string, threadTs: string, ts: string, name: string, add: boolean): Promise<void>`

- [ ] **Step 1: Write the failing reducer tests**

Create `ui/src/lib/reactionToggle.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { applyReactionToggle } from './reactionToggle'
import type { Message } from './api'

function msg(ts: string, reactions: Message['Reactions']): Message {
  return { TS: ts, UserID: 'U0', Text: '', Blocks: null, Reactions: reactions, Edited: false, Files: null, Attachments: null }
}

describe('applyReactionToggle', () => {
  it('add: bumps count and appends the user id', () => {
    const out = applyReactionToggle([msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }])], '1', 'tada', 'U1', true)
    expect(out[0].Reactions![0]).toEqual({ Name: 'tada', Count: 2, UserIDs: ['U2', 'U1'] })
  })

  it('remove: decrements count and drops the user id', () => {
    const out = applyReactionToggle([msg('1', [{ Name: 'tada', Count: 2, UserIDs: ['U2', 'U1'] }])], '1', 'tada', 'U1', false)
    expect(out[0].Reactions![0]).toEqual({ Name: 'tada', Count: 1, UserIDs: ['U2'] })
  })

  it('remove: removes the pill when count reaches 0', () => {
    const out = applyReactionToggle([msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U1'] }])], '1', 'tada', 'U1', false)
    expect(out[0].Reactions).toEqual([])
  })

  it('add: no-op when the user already reacted', () => {
    const before = [msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U1'] }])]
    const out = applyReactionToggle(before, '1', 'tada', 'U1', true)
    expect(out[0].Reactions![0]).toEqual({ Name: 'tada', Count: 1, UserIDs: ['U1'] })
  })

  it('remove: no-op when the user had not reacted', () => {
    const out = applyReactionToggle([msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }])], '1', 'tada', 'U1', false)
    expect(out[0].Reactions![0]).toEqual({ Name: 'tada', Count: 1, UserIDs: ['U2'] })
  })

  it('leaves other messages and other reactions untouched', () => {
    const before = [
      msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }, { Name: 'eyes', Count: 1, UserIDs: ['U3'] }]),
      msg('2', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }]),
    ]
    const out = applyReactionToggle(before, '1', 'tada', 'U1', true)
    expect(out[0].Reactions![0].Count).toBe(2)
    expect(out[0].Reactions![1]).toEqual({ Name: 'eyes', Count: 1, UserIDs: ['U3'] })
    expect(out[1].Reactions![0]).toEqual({ Name: 'tada', Count: 1, UserIDs: ['U2'] })
  })

  it('is a no-op for an unknown ts or reaction name', () => {
    const before = [msg('1', [{ Name: 'tada', Count: 1, UserIDs: ['U2'] }])]
    expect(applyReactionToggle(before, '9', 'tada', 'U1', true)).toEqual(before)
    expect(applyReactionToggle(before, '1', 'nope', 'U1', true)).toEqual(before)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/lib/reactionToggle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reducer**

Create `ui/src/lib/reactionToggle.ts`:

```ts
import type { Message, Reaction } from './api'

/**
 * Returns a new messages array with the current user toggled in/out of the
 * reaction `name` on the message `ts`. Pure — used for optimistic UI. Only
 * existing reactions are toggled (there is no add-new-emoji flow). Adding when
 * already present, or removing when absent, is a no-op. Removing the last user
 * drops the reaction pill. Unknown ts/name leaves the input unchanged.
 */
export function applyReactionToggle(
  messages: Message[],
  ts: string,
  name: string,
  userId: string,
  add: boolean,
): Message[] {
  return messages.map((m) => {
    if (m.TS !== ts || !m.Reactions) {
      return m
    }
    let changed = false
    const next: Reaction[] = []
    for (const r of m.Reactions) {
      if (r.Name !== name) {
        next.push(r)
        continue
      }
      const ids = r.UserIDs ?? []
      const has = ids.includes(userId)
      if (add && !has) {
        next.push({ ...r, Count: r.Count + 1, UserIDs: [...ids, userId] })
        changed = true
      } else if (!add && has) {
        const remaining = ids.filter((id) => id !== userId)
        changed = true
        if (r.Count - 1 <= 0 || remaining.length === 0) {
          // drop the pill entirely
        } else {
          next.push({ ...r, Count: r.Count - 1, UserIDs: remaining })
        }
      } else {
        next.push(r) // no-op case
      }
    }
    return changed ? { ...m, Reactions: next } : m
  })
}
```

- [ ] **Step 4: Add the api client function**

In `ui/src/lib/api.ts`, add after `postReply` (mirror `markUnread`'s error handling; import/`ApiAuthError` already present):

```ts
export async function toggleReaction(
  channel: string,
  threadTs: string,
  ts: string,
  name: string,
  add: boolean,
): Promise<void> {
  const res = await fetch('/api/thread/react', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts: threadTs, ts, name, add }),
  })
  if (res.status === 401) {
    throw new ApiAuthError()
  }
  if (!res.ok) {
    throw new Error(`react failed: ${res.status}`)
  }
}
```

(The server ignores `thread_ts`; it is sent for symmetry with the other mutations.)

- [ ] **Step 5: Run tests + type-check**

Run: `cd ui && npx vitest run src/lib/reactionToggle.test.ts && npx tsc -b`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/reactionToggle.ts ui/src/lib/reactionToggle.test.ts ui/src/lib/api.ts
git commit --signoff -m "feat(ui): reaction-toggle reducer and api client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ReactionPill click + Message/ThreadView wiring

**Files:**
- Modify: `ui/src/components/ReactionPill.tsx`, `ui/src/components/ReactionPill.test.tsx`, `ui/src/components/Message.tsx`, `ui/src/components/ThreadView.tsx`

**Interfaces:**
- Consumes: `applyReactionToggle`, `toggleReaction` (Task 3); `applyLocal`, `refresh` from the thread hook; `data.currentUserId`.
- `ReactionPill` gains optional prop `onToggle?: (name: string, add: boolean) => void`.
- `Message` gains optional prop `onToggleReaction?: (ts: string, name: string, add: boolean) => void`.

- [ ] **Step 1: Write the failing ReactionPill tests**

Add to `ui/src/components/ReactionPill.test.tsx`:

```ts
it('calls onToggle(name, false) when the current user already reacted (mine)', () => {
  const onToggle = vi.fn()
  const { container } = renderWithProvider(
    <ReactionPill reaction={base} users={users} emoji={{}} mine={true} onToggle={onToggle} />,
  )
  fireEvent.click(container.querySelector('.mantine-Badge-root')!)
  expect(onToggle).toHaveBeenCalledWith('tada', false)
})

it('calls onToggle(name, true) when the current user has not reacted', () => {
  const onToggle = vi.fn()
  const { container } = renderWithProvider(
    <ReactionPill reaction={base} users={users} emoji={{}} mine={false} onToggle={onToggle} />,
  )
  fireEvent.click(container.querySelector('.mantine-Badge-root')!)
  expect(onToggle).toHaveBeenCalledWith('tada', true)
})

it('is display-only (no click handler) when onToggle is omitted', () => {
  const { container } = renderWithProvider(<ReactionPill reaction={base} users={users} emoji={{}} mine={false} />)
  // clicking must not throw and there is nothing to assert beyond render;
  // guard: the badge is not a button role when non-interactive
  fireEvent.click(container.querySelector('.mantine-Badge-root')!)
  expect(container.textContent).toContain('2')
})
```

(`vi` and `fireEvent` need importing — add to the existing import lines.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/ReactionPill.test.tsx`
Expected: FAIL — `onToggle` prop not handled.

- [ ] **Step 3: Make ReactionPill clickable**

In `ui/src/components/ReactionPill.tsx`, add `onToggle` to the props and wire the click. Compute `add = !mine`. Make the Badge interactive only when `onToggle` is provided:

```tsx
export function ReactionPill({
  reaction,
  users,
  emoji,
  mine,
  onToggle,
}: {
  reaction: Reaction
  users: Record<string, User>
  emoji: Record<string, string>
  mine: boolean
  onToggle?: (name: string, add: boolean) => void
}) {
```

On the `<Badge>`, when `onToggle` is set, add `style={{ cursor: 'pointer' }}` and `onClick={() => onToggle(reaction.Name, !mine)}`. When not set, render exactly as today (no onClick, no pointer cursor). Keep the Tooltip wrapper and everything else unchanged.

- [ ] **Step 4: Thread the callback through Message**

In `ui/src/components/Message.tsx`, add an optional prop `onToggleReaction?: (ts: string, name: string, add: boolean) => void` to `MessageProps`, and pass it into each `ReactionPill` as `onToggle={onToggleReaction ? (name, add) => onToggleReaction(message.TS, name, add) : undefined}`. Only pass a real `onToggle` when both `onToggleReaction` AND `currentUserId` are present (without `currentUserId`, `mine` is unreliable, so stay display-only).

- [ ] **Step 5: Implement the handler in ThreadView**

In `ui/src/components/ThreadView.tsx`, add a handler mirroring `handleMarkUnread` (optimistic via `applyLocal`, rollback via `refresh()`):

```tsx
async function handleToggleReaction(ts: string, name: string, add: boolean) {
  if (!data) return
  const userId = data.currentUserId
  applyLocal((d) => ({ ...d, messages: applyReactionToggle(d.messages, ts, name, userId, add) }))
  try {
    await toggleReaction(tab.channel, tab.threadTs, ts, name, add)
  } catch {
    refresh() // silent rollback (covers a disallowed-channel 403)
  }
}
```

Import `applyReactionToggle` and `toggleReaction`. Pass `onToggleReaction={handleToggleReaction}` to `<Message>`.

- [ ] **Step 6: Run tests + build**

Run: `cd ui && npx vitest run && npm run build`
Expected: all pass; build clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/ReactionPill.tsx ui/src/components/ReactionPill.test.tsx ui/src/components/Message.tsx ui/src/components/ThreadView.tsx
git commit --signoff -m "feat(ui): toggle reactions by clicking a pill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: RE doc + full verification

**Files:**
- Modify: `docs/reverse-engineering/slack-web-api.md`

- [ ] **Step 1: Document the endpoints**

In the "## Reactions" section of `docs/reverse-engineering/slack-web-api.md`, add a subsection documenting `reactions.add` and `reactions.remove`: both are `POST https://slack.com/api/{method}` with form fields `channel`, `timestamp` (the **message ts**, not thread ts), and `name` (emoji name, no colons). Note the idempotency behavior slack-mini relies on: `reactions.add` returns `already_reacted` and `reactions.remove` returns `no_reaction` when the desired state already holds, and slack-mini treats both as success. Note that these writes are gated behind the `send_allowlist` (same as `chat.postMessage`).

- [ ] **Step 2: Commit the doc**

```bash
git add docs/reverse-engineering/slack-web-api.md
git commit --signoff -m "docs(re): document reactions.add/remove endpoints

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Full verification**

Run: `make test` (Go + frontend), then `go build ./...` and `cd ui && npm run build`.
Expected: all green, both builds clean.

- [ ] **Step 4: Live verification (safety-critical)**

Build and serve on a temp port (do NOT collide with a running instance; use a temp config with `port:` overridden, copying the real token/cookie, as done for prior live checks). Then, in the browser:
- In the **self-channel `DMFAS8V0X`** thread ONLY (the sole allowlisted channel): click a reaction to add yourself (pill increments, turns blue), click again to remove (decrements/disappears). Confirm it persists via Slack. **Never toggle a reaction in any shared thread.**
- Confirm a non-allowlisted channel does NOT toggle: clicking a pill there flips optimistically then reverts (server 403 → `refresh()`), and no reaction is actually written.
Stop the server and remove the temp binary/config afterward.

- [ ] **Step 5: Report** — no commit (all work already committed).

---

## Self-Review

**Spec coverage:**
- slackapi AddReaction/RemoveReaction + idempotency → Task 1. ✓
- Server `/api/thread/react` + allowlist guard (403 before call) → Task 2. ✓
- Optimistic reducer `applyReactionToggle` + `toggleReaction` client → Task 3. ✓
- ReactionPill click + Message/ThreadView optimistic wiring + rollback → Task 4. ✓
- Display-only when no `currentUserId`/`onToggle` → Task 4 Step 4. ✓
- RE doc → Task 5. ✓
- Live test confined to DMFAS8V0X + 403 check → Task 5 Step 4. ✓

**Type consistency:** `AddReaction`/`RemoveReaction(ctx, channel, ts, name)` identical in Task 1 (def) and Task 2 (fakeClient/handler). `applyReactionToggle(messages, ts, name, userId, add)` identical in Task 3 (def/tests) and Task 4 (ThreadView call). `toggleReaction(channel, threadTs, ts, name, add)` identical in Task 3 (def) and Task 4 (call). `onToggle(name, add)` / `onToggleReaction(ts, name, add)` consistent between ReactionPill, Message, ThreadView.

**Placeholder scan:** `newTestServer`/`doPost` in Task 2 are explicitly flagged as "use the existing server_test.go helpers" with instructions to read `TestHandleReply*` — not literal placeholders to leave in. All other code is concrete.

**Idempotency detection nuance:** Task 1 detects `already_reacted`/`no_reaction` via `strings.Contains(err.Error(), ...)` because `call()` surfaces non-auth Slack errors as a formatted string — spelled out in Global Constraints and Task 1.
