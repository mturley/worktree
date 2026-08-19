# slack-mini Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single Go binary that serves a React thread-viewer frontend and proxies the Slack Web API, letting the user open Slack threads as renamable browser tabs.

**Architecture:** Go module at repo root exposes a CLI (`setup`, `serve`, `open`) and an HTTP+SSE server. A `slackapi` package wraps the Slack Web API (session `xoxc`/`xoxd` auth) and returns normalized domain structs. A `watcher` package polls subscribed threads and emits change events (no HTTP/config deps, so it can later be lifted into a separate Jira/GitHub watcher library). The frontend (Vite + React + Mantine, dark mode) lives in `ui/`, is embedded into the binary via `embed.FS` for prod, and talks only to the local API.

**Tech Stack:** Go 1.22+, `net/http` (stdlib), `gopkg.in/yaml.v3`; React 18 + TypeScript + Vite + Mantine; `mprocs` + `air` for dev; Vitest for frontend unit tests.

## Global Constraints

- Go module path: `github.com/mturley/slack-mini`. Go 1.22 or newer.
- Slack auth: `POST https://slack.com/api/{method}`, headers `Authorization: Bearer <xoxc-…>` and `Cookie: d=<xoxd-…>`; form-encoded body for `conversations.replies`, `users.info`, `emoji.list`, `subscriptions.thread.mark`.
- Config file: `~/.config/slack-mini/slack-mini.yaml`. Never commit tokens; `.gitignore` already excludes `*.env`/`tokens.env`.
- Ports: Go server `8473` (prod + dev, configurable via `port:` in YAML); Vite dev server `5174`. Do NOT use `8420` or `5173` (reserved by other projects).
- Frontend dir `ui/`; built assets in `ui/dist/` embedded via `embed.FS`. Binary output `bin/slack-mini`.
- Mantine dark mode is the default theme.
- No database; tab metadata (`{id, channel, threadTs, name, description}`) and open-tab list live in `sessionStorage`.
- `slackapi` returns domain structs (`Message`, `User`, `Thread`), never raw Slack JSON. `watcher` imports only `slackapi` + a clock — no `net/http`, `server`, or `config` imports.
- Commit style: small, frequent, conventional-commit prefixes (`feat:`, `test:`, `chore:`), `--signoff`, and end each message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Slack timestamp helpers: parse `"1700000000.000001"` as float seconds; compare timestamps lexically only after zero-padding is guaranteed — prefer numeric compare via `ParseFloat`.

---

# Phase v1 — Read-only tabbed thread viewer

## File Structure (v1)

- `go.mod`, `go.sum` — module.
- `main.go` — CLI entrypoint; dispatches to `cli`.
- `internal/config/config.go` — load/save YAML config.
- `internal/config/config_test.go`
- `internal/slackapi/types.go` — domain structs (`Message`, `User`, `Thread`, `Reaction`, `Element`).
- `internal/slackapi/client.go` — Slack Web API client + interface `Client`.
- `internal/slackapi/normalize.go` — raw Slack JSON → domain structs.
- `internal/slackapi/normalize_test.go`
- `internal/slackapi/testdata/replies.json` — sanitized synthetic payload fixture.
- `internal/watcher/watcher.go` — poll loops + `ThreadUpdate` events.
- `internal/watcher/watcher_test.go`
- `internal/server/server.go` — HTTP routes + static embed.
- `internal/server/sse.go` — SSE hub.
- `internal/server/proxy.go` — avatar/emoji image proxy.
- `internal/server/server_test.go`
- `internal/cli/cli.go` — arg parsing, dispatch.
- `internal/cli/setup.go`, `serve.go`, `open.go`.
- `internal/cli/open_test.go`
- `ui/` — Vite React app (`package.json`, `vite.config.ts`, `src/…`).
- `Makefile` — build/dev/test/clean/install.
- `mprocs.yaml` — dev process definitions (if preferred over inline mprocs args).

---

### Task 1: Go module + config package

**Files:**
- Create: `go.mod`, `internal/config/config.go`, `internal/config/config_test.go`

**Interfaces:**
- Produces:
  - `type Config struct { Token string `yaml:"token"`; Cookie string `yaml:"cookie"`; WorkspaceDomain string `yaml:"workspace_domain"`; Port int `yaml:"port"` }`
  - `func Path() (string, error)` — returns `~/.config/slack-mini/slack-mini.yaml`.
  - `func Load() (*Config, error)` — reads + parses; returns a typed error `ErrNotConfigured` if the file is missing.
  - `func Save(c *Config) error` — creates the dir (0700) and writes the file (0600).
  - `func (c *Config) EffectivePort() int` — returns `c.Port` or `8473` if zero.
  - `var ErrNotConfigured = errors.New("slack-mini is not configured; run 'slack-mini setup'")`

- [ ] **Step 1: Init the module**

Run: `cd /Users/mturley/git/slack-mini && go mod init github.com/mturley/slack-mini && go get gopkg.in/yaml.v3`
Expected: `go.mod` created with the yaml dependency.

- [ ] **Step 2: Write the failing test**

```go
// internal/config/config_test.go
package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveThenLoadRoundTrips(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir) // Path() must honor XDG_CONFIG_HOME

	in := &Config{Token: "xoxc-abc", Cookie: "xoxd-def", WorkspaceDomain: "redhat-internal", Port: 0}
	if err := Save(in); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.Token != in.Token || got.Cookie != in.Cookie || got.WorkspaceDomain != in.WorkspaceDomain {
		t.Fatalf("round trip mismatch: %+v", got)
	}
	if got.EffectivePort() != 8473 {
		t.Fatalf("EffectivePort = %d, want 8473", got.EffectivePort())
	}
	// File permissions must be 0600.
	p, _ := Path()
	fi, _ := os.Stat(p)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("perm = %v, want 0600", fi.Mode().Perm())
	}
	_ = filepath.Dir(p)
}

func TestLoadMissingReturnsErrNotConfigured(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if _, err := Load(); err != ErrNotConfigured {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test ./internal/config/ -run TestSaveThenLoad -v`
Expected: FAIL — package/functions not defined.

- [ ] **Step 4: Implement `config.go`**

```go
// internal/config/config.go
package config

import (
	"errors"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

const DefaultPort = 8473

var ErrNotConfigured = errors.New("slack-mini is not configured; run 'slack-mini setup'")

type Config struct {
	Token           string `yaml:"token"`
	Cookie          string `yaml:"cookie"`
	WorkspaceDomain string `yaml:"workspace_domain"`
	Port            int    `yaml:"port"`
}

func (c *Config) EffectivePort() int {
	if c.Port == 0 {
		return DefaultPort
	}
	return c.Port
}

func Path() (string, error) {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "slack-mini", "slack-mini.yaml"), nil
}

func Load() (*Config, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotConfigured
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := yaml.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func Save(c *Config) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	data, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o600)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./internal/config/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/config/
git commit --signoff -m "feat: config package with YAML load/save

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: slackapi domain types + normalization

**Files:**
- Create: `internal/slackapi/types.go`, `internal/slackapi/normalize.go`, `internal/slackapi/normalize_test.go`, `internal/slackapi/testdata/replies.json`

**Interfaces:**
- Produces:
  - Domain structs:
    ```go
    type Thread struct {
        Channel   string
        ThreadTS  string
        LastRead  string      // parent message last_read
        LatestReply string
        Messages  []Message
    }
    type Message struct {
        TS       string
        UserID   string
        Text     string       // raw mrkdwn fallback
        Elements []Element    // flattened rich_text elements (nil if no blocks)
        Reactions []Reaction
        Edited   bool
    }
    type Element struct {
        Type    string  // "text" | "user" | "link" | "emoji" | "usergroup" | "broadcast"
        Text    string  // for text/link label
        URL     string  // for link
        UserID  string  // for user mention
        Name    string  // for emoji name / usergroup id
        Unicode string  // for standard emoji codepoint (may be empty)
        Style   Style   // bold/italic/code for text
    }
    type Style struct{ Bold, Italic, Code bool }
    type Reaction struct { Name string; Count int; UserIDs []string }
    type User struct { ID, RealName, DisplayName, Avatar72 string }
    ```
  - `func NormalizeThread(channel, threadTS string, raw RepliesResponse) Thread`
  - `type RepliesResponse` and nested raw structs matching Slack JSON (`OK`, `Messages`, `ResponseMetadata`).
  - `func UnreadDividerIndex(t Thread) int` — index of first message with `TS > LastRead` numerically, or `-1` if none.

- [ ] **Step 1: Add a SANITIZED fixture**

The design was verified against a real payload, but that payload contains internal Red Hat
Slack content (real names, work chat, PR links) that must NOT be committed. Create a
**sanitized** fixture that preserves the exact JSON *structure* the code parses while
replacing all human content with synthetic values. Keep: `ok:true`, 4 messages, parent
message with `last_read`/`latest_reply`/`thread_ts`/`reply_count`, `rich_text` blocks
containing a `user` mention element + a custom `emoji` element (`name:"green_ball"`, no
`unicode`) + a standard emoji element (with `unicode`) + a `text` element, and one message
with a `reactions` array (`name:"agree+1"`, `count:2`). Use fake IDs (`U000000001`,
`C000000001`) and timestamps matching the assertions in Step 2 (parent ts
`1700000000.000001`, `last_read` `1700000000.000003`, mention `user_id` `U0EXAMPLE9`). Do
NOT copy `~/tmp/slackmini-replies.json` into the repo.

Run: `mkdir -p internal/slackapi/testdata` then write `internal/slackapi/testdata/replies.json`
by hand from the structure above (reference the raw shape documented in the spec's Appendix A
and the raw structs in Task 2 Step 4). Verify it parses: `python3 -m json.tool internal/slackapi/testdata/replies.json >/dev/null && echo ok`.

- [ ] **Step 2: Write the failing test**

```go
// internal/slackapi/normalize_test.go
package slackapi

import (
	"encoding/json"
	"os"
	"testing"
)

func loadFixture(t *testing.T) RepliesResponse {
	t.Helper()
	data, err := os.ReadFile("testdata/replies.json")
	if err != nil { t.Fatal(err) }
	var r RepliesResponse
	if err := json.Unmarshal(data, &r); err != nil { t.Fatal(err) }
	return r
}

func TestNormalizeThreadParent(t *testing.T) {
	raw := loadFixture(t)
	th := NormalizeThread("C0EXAMPLE1", "1700000000.000001", raw)
	if len(th.Messages) != 4 { t.Fatalf("messages = %d, want 4", len(th.Messages)) }
	p := th.Messages[0]
	if p.TS != "1700000000.000001" { t.Fatalf("parent ts = %s", p.TS) }
	if th.LastRead != "1700000000.000003" { t.Fatalf("last_read = %s", th.LastRead) }
	// Parent has a rich_text block with a user mention + emoji.
	var sawUser, sawEmoji bool
	for _, e := range p.Elements {
		if e.Type == "user" && e.UserID == "U0EXAMPLE9" { sawUser = true }
		if e.Type == "emoji" && e.Name == "green_ball" { sawEmoji = true }
	}
	if !sawUser || !sawEmoji { t.Fatalf("expected user+emoji elements, got %+v", p.Elements) }
	if len(p.Reactions) != 1 || p.Reactions[0].Name != "agree+1" || p.Reactions[0].Count != 2 {
		t.Fatalf("reactions = %+v", p.Reactions)
	}
}

func TestUnreadDividerIndex(t *testing.T) {
	th := Thread{
		LastRead: "100.000002",
		Messages: []Message{{TS: "100.000001"}, {TS: "100.000002"}, {TS: "100.000003"}},
	}
	if got := UnreadDividerIndex(th); got != 2 {
		t.Fatalf("divider index = %d, want 2", got)
	}
	th.LastRead = "100.000003"
	if got := UnreadDividerIndex(th); got != -1 {
		t.Fatalf("divider index = %d, want -1 (all read)", got)
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `go test ./internal/slackapi/ -run TestNormalize -v`
Expected: FAIL — types/functions not defined.

- [ ] **Step 4: Implement `types.go` (raw + domain) and `normalize.go`**

Define raw structs that match the fixture:
```go
// internal/slackapi/types.go — raw Slack shapes
type RepliesResponse struct {
	OK               bool          `json:"ok"`
	Error            string        `json:"error"`
	Messages         []rawMessage  `json:"messages"`
	HasMore          bool          `json:"has_more"`
	ResponseMetadata struct{ NextCursor string `json:"next_cursor"` } `json:"response_metadata"`
}
type rawMessage struct {
	TS         string        `json:"ts"`
	User       string        `json:"user"`
	Text       string        `json:"text"`
	ThreadTS   string        `json:"thread_ts"`
	LastRead   string        `json:"last_read"`
	LatestReply string       `json:"latest_reply"`
	Edited     *struct{}     `json:"edited"`
	Blocks     []rawBlock    `json:"blocks"`
	Reactions  []rawReaction `json:"reactions"`
}
type rawBlock struct {
	Type     string        `json:"type"`
	Elements []rawElemGrp  `json:"elements"` // rich_text_section wrappers
}
type rawElemGrp struct {
	Type     string       `json:"type"` // "rich_text_section", "rich_text_list", etc.
	Elements []rawElement `json:"elements"`
}
type rawElement struct {
	Type    string `json:"type"`
	Text    string `json:"text"`
	URL     string `json:"url"`
	UserID  string `json:"user_id"`
	Name    string `json:"name"`      // emoji name / usergroup
	Unicode string `json:"unicode"`
	Style   struct {
		Bold   bool `json:"bold"`
		Italic bool `json:"italic"`
		Code   bool `json:"code"`
	} `json:"style"`
}
type rawReaction struct {
	Name  string   `json:"name"`
	Count int      `json:"count"`
	Users []string `json:"users"`
}
```
Then the domain structs from the Interfaces block, plus:
```go
// internal/slackapi/normalize.go
func NormalizeThread(channel, threadTS string, raw RepliesResponse) Thread {
	th := Thread{Channel: channel, ThreadTS: threadTS}
	for i, m := range raw.Messages {
		if i == 0 {
			th.LastRead = m.LastRead
			th.LatestReply = m.LatestReply
		}
		msg := Message{TS: m.TS, UserID: m.User, Text: m.Text, Edited: m.Edited != nil}
		for _, b := range m.Blocks {
			if b.Type != "rich_text" { continue }
			for _, grp := range b.Elements {
				for _, e := range grp.Elements {
					msg.Elements = append(msg.Elements, Element{
						Type: e.Type, Text: e.Text, URL: e.URL, UserID: e.UserID,
						Name: e.Name, Unicode: e.Unicode,
						Style: Style{Bold: e.Style.Bold, Italic: e.Style.Italic, Code: e.Style.Code},
					})
				}
			}
		}
		for _, r := range m.Reactions {
			msg.Reactions = append(msg.Reactions, Reaction{Name: r.Name, Count: r.Count, UserIDs: r.Users})
		}
		th.Messages = append(th.Messages, msg)
	}
	return th
}

func UnreadDividerIndex(t Thread) int {
	for i, m := range t.Messages {
		if tsGreater(m.TS, t.LastRead) {
			return i
		}
	}
	return -1
}

func tsGreater(a, b string) bool {
	fa, _ := strconv.ParseFloat(a, 64)
	fb, _ := strconv.ParseFloat(b, 64)
	return fa > fb
}
```
(Add `import "strconv"`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./internal/slackapi/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/slackapi/
git commit --signoff -m "feat: slackapi domain types and thread normalization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: slackapi HTTP client

**Files:**
- Create: `internal/slackapi/client.go`
- Modify: `internal/slackapi/normalize_test.go` (add a client test using httptest)

**Interfaces:**
- Consumes: domain types from Task 2; `config.Config` for token/cookie.
- Produces:
  - ```go
    type Client interface {
        Replies(ctx context.Context, channel, threadTS string) (Thread, error)
        Users(ctx context.Context, ids []string) (map[string]User, error)
        Emoji(ctx context.Context) (map[string]string, error) // name -> URL, aliases dereffed
        MarkRead(ctx context.Context, channel, threadTS, ts string) error
    }
    ```
  - `func New(token, cookie string) *HTTPClient` implementing `Client`.
  - `func NewWithBaseURL(token, cookie, baseURL string) *HTTPClient` — for tests (points at httptest server).
  - `var ErrAuth = errors.New("slack auth failed")` — returned when Slack replies `invalid_auth`/`token_expired`/`not_authed`.

- [ ] **Step 1: Write the failing test (httptest, no real network)**

```go
func TestRepliesUsesFormEncodingAndAuthHeaders(t *testing.T) {
	var gotAuth, gotCookie, gotBody, gotCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		gotCT = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body); gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		fixture, _ := os.ReadFile("testdata/replies.json")
		w.Write(fixture)
	}))
	defer srv.Close()

	c := NewWithBaseURL("xoxc-t", "xoxd-c", srv.URL)
	th, err := c.Replies(context.Background(), "C0EXAMPLE1", "1700000000.000001")
	if err != nil { t.Fatal(err) }
	if len(th.Messages) != 4 { t.Fatalf("messages=%d", len(th.Messages)) }
	if gotAuth != "Bearer xoxc-t" { t.Fatalf("auth=%q", gotAuth) }
	if gotCookie != "d=xoxd-c" { t.Fatalf("cookie=%q", gotCookie) }
	if !strings.HasPrefix(gotCT, "application/x-www-form-urlencoded") { t.Fatalf("ct=%q", gotCT) }
	if !strings.Contains(gotBody, "channel=C0EXAMPLE1") || !strings.Contains(gotBody, "ts=1700000000.000001") {
		t.Fatalf("body=%q", gotBody)
	}
}

func TestRepliesAuthErrorMapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error":"invalid_auth"}`))
	}))
	defer srv.Close()
	c := NewWithBaseURL("x", "y", srv.URL)
	_, err := c.Replies(context.Background(), "C", "1.1")
	if !errors.Is(err, ErrAuth) { t.Fatalf("err=%v, want ErrAuth", err) }
}
```
Add imports: `context`, `errors`, `io`, `net/http`, `net/http/httptest`, `os`, `strings`, `testing`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/slackapi/ -run TestReplies -v`
Expected: FAIL — `NewWithBaseURL` undefined.

- [ ] **Step 3: Implement `client.go`**

```go
// internal/slackapi/client.go
package slackapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var ErrAuth = errors.New("slack auth failed")

type HTTPClient struct {
	token, cookie, baseURL string
	hc                     *http.Client
}

func New(token, cookie string) *HTTPClient { return NewWithBaseURL(token, cookie, "https://slack.com/api") }
func NewWithBaseURL(token, cookie, baseURL string) *HTTPClient {
	return &HTTPClient{token: token, cookie: cookie, baseURL: strings.TrimRight(baseURL, "/"),
		hc: &http.Client{Timeout: 20 * time.Second}}
}

func (c *HTTPClient) call(ctx context.Context, method string, params url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/"+method,
		strings.NewReader(params.Encode()))
	if err != nil { return err }
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Cookie", "d="+c.cookie)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
	resp, err := c.hc.Do(req)
	if err != nil { return err }
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil { return err }
	// Peek at ok/error before decoding into out.
	var head struct{ OK bool `json:"ok"`; Error string `json:"error"` }
	if err := json.Unmarshal(body, &head); err != nil { return err }
	if !head.OK {
		switch head.Error {
		case "invalid_auth", "token_expired", "not_authed":
			return fmt.Errorf("%w: %s", ErrAuth, head.Error)
		default:
			return fmt.Errorf("slack error: %s", head.Error)
		}
	}
	if out != nil {
		return json.Unmarshal(body, out)
	}
	return nil
}

func (c *HTTPClient) Replies(ctx context.Context, channel, threadTS string) (Thread, error) {
	var raw RepliesResponse
	err := c.call(ctx, "conversations.replies", url.Values{
		"channel": {channel}, "ts": {threadTS}, "limit": {"200"},
	}, &raw)
	if err != nil { return Thread{}, err }
	return NormalizeThread(channel, threadTS, raw), nil
}

func (c *HTTPClient) MarkRead(ctx context.Context, channel, threadTS, ts string) error {
	return c.call(ctx, "subscriptions.thread.mark", url.Values{
		"channel": {channel}, "thread_ts": {threadTS}, "ts": {ts}, "read": {"1"},
	}, nil)
}

func (c *HTTPClient) Users(ctx context.Context, ids []string) (map[string]User, error) {
	out := make(map[string]User, len(ids))
	for _, id := range ids {
		var r struct {
			User struct {
				ID, RealName string `json:"id"`
				Profile struct {
					DisplayName string `json:"display_name"`
					Image72     string `json:"image_72"`
					RealNameNormalized string `json:"real_name_normalized"`
				} `json:"profile"`
			} `json:"user"`
		}
		if err := c.call(ctx, "users.info", url.Values{"user": {id}}, &r); err != nil {
			out[id] = User{ID: id, RealName: id, DisplayName: id} // graceful fallback
			continue
		}
		out[id] = User{ID: id, RealName: r.User.RealName, DisplayName: r.User.Profile.DisplayName, Avatar72: r.User.Profile.Image72}
	}
	return out, nil
}

func (c *HTTPClient) Emoji(ctx context.Context) (map[string]string, error) {
	var r struct{ Emoji map[string]string `json:"emoji"` }
	if err := c.call(ctx, "emoji.list", url.Values{}, &r); err != nil { return nil, err }
	// Deref one level of alias:name.
	out := make(map[string]string, len(r.Emoji))
	for k, v := range r.Emoji {
		if strings.HasPrefix(v, "alias:") {
			if real, ok := r.Emoji[strings.TrimPrefix(v, "alias:")]; ok { out[k] = real; continue }
		}
		out[k] = v
	}
	return out, nil
}
```
Note the `RealName` json tag bug risk: `ID, RealName string json:"id"` only tags `id`. Fix by declaring separately: `ID string \`json:"id"\`` and `RealName string \`json:"real_name"\``. Do that in the implementation.

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/slackapi/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/slackapi/
git commit --signoff -m "feat: slackapi HTTP client (replies, users, emoji, mark-read)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: watcher package

**Files:**
- Create: `internal/watcher/watcher.go`, `internal/watcher/watcher_test.go`

**Interfaces:**
- Consumes: `slackapi.Client`, `slackapi.Thread` from Tasks 2–3.
- Produces:
  - ```go
    type ThreadUpdate struct { Channel, ThreadTS string; Thread slackapi.Thread }
    type Watcher struct { /* unexported */ }
    func New(c slackapi.Client, interval time.Duration, now func() time.Time) *Watcher
    func (w *Watcher) Subscribe(channel, threadTS string) <-chan ThreadUpdate // idempotent per (channel,threadTS)
    func (w *Watcher) Unsubscribe(channel, threadTS string)
    func (w *Watcher) Poll(ctx context.Context, channel, threadTS string) (ThreadUpdate, bool, error) // one poll; bool=changed
    func (w *Watcher) Close()
    ```
- Constraint: this package imports only `slackapi`, `context`, `sync`, `time`. NO `net/http`, `config`, or `server`.

- [ ] **Step 1: Write the failing test with a fake client**

```go
// internal/watcher/watcher_test.go
package watcher

import (
	"context"
	"testing"
	"time"

	"github.com/mturley/slack-mini/internal/slackapi"
)

type fakeClient struct{ threads []slackapi.Thread; i int }
func (f *fakeClient) Replies(ctx context.Context, ch, ts string) (slackapi.Thread, error) {
	t := f.threads[f.i]; if f.i < len(f.threads)-1 { f.i++ }; return t, nil
}
func (f *fakeClient) Users(context.Context, []string) (map[string]slackapi.User, error) { return nil, nil }
func (f *fakeClient) Emoji(context.Context) (map[string]string, error) { return nil, nil }
func (f *fakeClient) MarkRead(context.Context, string, string, string) error { return nil }

func TestPollDetectsChange(t *testing.T) {
	fc := &fakeClient{threads: []slackapi.Thread{
		{Messages: []slackapi.Message{{TS: "1.1"}}},
		{Messages: []slackapi.Message{{TS: "1.1"}, {TS: "1.2"}}},
	}}
	w := New(fc, time.Second, time.Now)
	// First poll establishes baseline -> changed=true.
	_, changed, err := w.Poll(context.Background(), "C", "1.1")
	if err != nil || !changed { t.Fatalf("first poll changed=%v err=%v", changed, err) }
	// Second poll has an extra message -> changed=true.
	_, changed, _ = w.Poll(context.Background(), "C", "1.1")
	if !changed { t.Fatal("second poll should detect new message") }
	// Third poll returns same as second (fake clamps) -> changed=false.
	_, changed, _ = w.Poll(context.Background(), "C", "1.1")
	if changed { t.Fatal("third poll should be no change") }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/watcher/ -v`
Expected: FAIL — package not defined.

- [ ] **Step 3: Implement `watcher.go`**

```go
// internal/watcher/watcher.go
package watcher

import (
	"context"
	"sync"
	"time"

	"github.com/mturley/slack-mini/internal/slackapi"
)

type ThreadUpdate struct {
	Channel, ThreadTS string
	Thread            slackapi.Thread
}

type sub struct {
	ch      chan ThreadUpdate
	cancel  context.CancelFunc
	lastSig string
}

type Watcher struct {
	client   slackapi.Client
	interval time.Duration
	now      func() time.Time
	mu       sync.Mutex
	subs     map[string]*sub
	lastSig  map[string]string // for Poll()-only callers
}

func key(ch, ts string) string { return ch + "\x00" + ts }

func New(c slackapi.Client, interval time.Duration, now func() time.Time) *Watcher {
	return &Watcher{client: c, interval: interval, now: now,
		subs: map[string]*sub{}, lastSig: map[string]string{}}
}

func signature(t slackapi.Thread) string {
	// A cheap change signature: last ts + count + reaction counts.
	sig := ""
	for _, m := range t.Messages {
		sig += m.TS + ":" + itoa(len(m.Reactions)) + "|"
		if m.Edited { sig += "e" }
	}
	return sig
}
func itoa(n int) string { return strconvItoa(n) }

func (w *Watcher) Poll(ctx context.Context, ch, ts string) (ThreadUpdate, bool, error) {
	th, err := w.client.Replies(ctx, ch, ts)
	if err != nil { return ThreadUpdate{}, false, err }
	sig := signature(th)
	w.mu.Lock()
	prev := w.lastSig[key(ch, ts)]
	w.lastSig[key(ch, ts)] = sig
	w.mu.Unlock()
	return ThreadUpdate{Channel: ch, ThreadTS: ts, Thread: th}, sig != prev, nil
}

func (w *Watcher) Subscribe(ch, ts string) <-chan ThreadUpdate {
	w.mu.Lock()
	defer w.mu.Unlock()
	if s, ok := w.subs[key(ch, ts)]; ok { return s.ch }
	ctx, cancel := context.WithCancel(context.Background())
	s := &sub{ch: make(chan ThreadUpdate, 4), cancel: cancel}
	w.subs[key(ch, ts)] = s
	go w.loop(ctx, ch, ts, s)
	return s.ch
}

func (w *Watcher) loop(ctx context.Context, ch, ts string, s *sub) {
	t := time.NewTicker(w.interval)
	defer t.Stop()
	poll := func() {
		u, changed, err := w.Poll(ctx, ch, ts)
		if err == nil && changed {
			select {
			case s.ch <- u:
			default: // drop if consumer is slow; next poll will catch up
			}
		}
	}
	poll() // immediate first poll
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			poll()
		}
	}
}

func (w *Watcher) Unsubscribe(ch, ts string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if s, ok := w.subs[key(ch, ts)]; ok {
		s.cancel()
		close(s.ch)
		delete(w.subs, key(ch, ts))
	}
}

func (w *Watcher) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for k, s := range w.subs { s.cancel(); close(s.ch); delete(w.subs, k) }
}
```
Replace the `itoa`/`strconvItoa` placeholder with a direct `strconv.Itoa` call (`import "strconv"`; `sig += m.TS + ":" + strconv.Itoa(len(m.Reactions)) + "|"`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/watcher/ -v`
Expected: PASS.

- [ ] **Step 5: Verify the no-forbidden-imports constraint**

Run: `go list -deps ./internal/watcher/ | grep -E 'net/http|internal/(server|config)' && echo "FORBIDDEN IMPORT" || echo "clean"`
Expected: `clean`.

- [ ] **Step 6: Commit**

```bash
git add internal/watcher/
git commit --signoff -m "feat: thread watcher with poll-based change detection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: HTTP server — thread endpoint + static embed

**Files:**
- Create: `internal/server/server.go`, `internal/server/server_test.go`
- Create placeholder: `ui/dist/.gitkeep` (so `embed.FS` compiles before the frontend build exists)

**Interfaces:**
- Consumes: `slackapi.Client`, `config.Config`.
- Produces:
  - `func New(cfg *config.Config, client slackapi.Client, w *watcher.Watcher) *Server`
  - `func (s *Server) Handler() http.Handler` — mux with routes.
  - Enriched thread JSON type returned by `GET /api/thread`:
    ```go
    type ThreadResponse struct {
        Channel, ThreadTS, LastRead string
        UnreadIndex int
        Messages []MessageView
        Users map[string]slackapi.User
        Emoji map[string]string // only emoji referenced in this thread
    }
    type MessageView struct { slackapi.Message } // embed; extended later
    ```

- [ ] **Step 1: Write the failing test**

```go
// internal/server/server_test.go — uses a fake client returning the fixture-derived thread
func TestThreadEndpointReturnsEnrichedJSON(t *testing.T) {
	fc := &fakeClient{ /* returns a Thread with 1 user mention + green_ball emoji */ }
	s := New(&config.Config{}, fc, nil)
	req := httptest.NewRequest("GET", "/api/thread?channel=C&thread_ts=1.1", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 { t.Fatalf("code=%d body=%s", rec.Code, rec.Body) }
	var resp ThreadResponse
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.UnreadIndex < 0 && len(resp.Messages) == 0 { t.Fatal("empty response") }
	if _, ok := resp.Emoji["green_ball"]; !ok { t.Fatal("emoji not resolved") }
}

func TestThreadEndpointAuthErrorReturns401(t *testing.T) {
	fc := &fakeClient{err: slackapi.ErrAuth}
	s := New(&config.Config{}, fc, nil)
	req := httptest.NewRequest("GET", "/api/thread?channel=C&thread_ts=1.1", nil)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != 401 { t.Fatalf("code=%d, want 401", rec.Code) }
}
```
(Define a `fakeClient` in the test with configurable `thread`, `users`, `emoji`, `err`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./internal/server/ -v`
Expected: FAIL — `New`/`ThreadResponse` undefined.

- [ ] **Step 3: Implement `server.go`** (thread handler resolves users for all referenced IDs + filters emoji to referenced names; embeds `ui/dist` and serves it for non-`/api` paths; maps `ErrAuth`→401)

Key handler sketch:
```go
//go:embed all:../../ui/dist
var uiFS embed.FS

func (s *Server) handleThread(w http.ResponseWriter, r *http.Request) {
	ch := r.URL.Query().Get("channel"); ts := r.URL.Query().Get("thread_ts")
	if ch == "" || ts == "" { http.Error(w, "channel and thread_ts required", 400); return }
	th, err := s.client.Replies(r.Context(), ch, ts)
	if errors.Is(err, slackapi.ErrAuth) { http.Error(w, "auth", 401); return }
	if err != nil { http.Error(w, err.Error(), 502); return }
	// Collect referenced user IDs (authors + mentions + reactions) and emoji names.
	ids := collectUserIDs(th); names := collectEmojiNames(th)
	users, _ := s.client.Users(r.Context(), ids)
	allEmoji, _ := s.client.Emoji(r.Context())
	emoji := map[string]string{}
	for _, n := range names { if u, ok := allEmoji[n]; ok { emoji[n] = u } }
	resp := ThreadResponse{Channel: ch, ThreadTS: ts, LastRead: th.LastRead,
		UnreadIndex: slackapi.UnreadDividerIndex(th), Users: users, Emoji: emoji}
	for _, m := range th.Messages { resp.Messages = append(resp.Messages, MessageView{m}) }
	writeJSON(w, resp)
}
```
Implement `collectUserIDs`, `collectEmojiNames`, `writeJSON`, the mux (`/api/thread`, static fallback), and `//go:embed`. Cache the emoji map on the `Server` (fetch once). Also register `GET /api/config` → `{"workspaceDomain": cfg.WorkspaceDomain, "port": cfg.EffectivePort()}` (the frontend uses `workspaceDomain` to build the "Open in Slack" deep link). Add a one-line test asserting `/api/config` returns the configured domain.

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./internal/server/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/ ui/dist/.gitkeep
git commit --signoff -m "feat: HTTP server with /api/thread endpoint and static embed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: SSE endpoint + mark-read + image proxy

**Files:**
- Create: `internal/server/sse.go`, `internal/server/proxy.go`
- Modify: `internal/server/server.go` (register routes), `internal/server/server_test.go`

**Interfaces:**
- Consumes: `watcher.Watcher`, `slackapi.Client`.
- Produces routes:
  - `GET /api/events?channel=&thread_ts=` — SSE; subscribes via watcher, streams `ThreadResponse` JSON as `data:` events; unsubscribes on client disconnect.
  - `POST /api/thread/mark-read` body `{channel, thread_ts, ts}` → 204 or 401/502.
  - `GET /api/avatar?url=` and `GET /api/emoji?url=` — validate host is `avatars.slack-edge.com` / `emoji.slack-edge.com`, fetch with cookie, stream back with content-type. Reject other hosts with 400.

- [ ] **Step 1: Write failing tests**

```go
func TestMarkReadCallsClient(t *testing.T) {
	fc := &fakeClient{}
	s := New(&config.Config{}, fc, nil)
	body := strings.NewReader(`{"channel":"C","thread_ts":"1.1","ts":"1.2"}`)
	req := httptest.NewRequest("POST", "/api/thread/mark-read", body)
	rec := httptest.NewRecorder(); s.Handler().ServeHTTP(rec, req)
	if rec.Code != 204 { t.Fatalf("code=%d", rec.Code) }
	if fc.markedTS != "1.2" { t.Fatalf("markRead ts=%q", fc.markedTS) }
}

func TestImageProxyRejectsForeignHost(t *testing.T) {
	s := New(&config.Config{}, &fakeClient{}, nil)
	req := httptest.NewRequest("GET", "/api/avatar?url=https://evil.example/x.png", nil)
	rec := httptest.NewRecorder(); s.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 { t.Fatalf("code=%d, want 400", rec.Code) }
}
```
(Extend `fakeClient` with `markedTS`.)

- [ ] **Step 2: Run to verify fail** — `go test ./internal/server/ -run 'MarkRead|Proxy' -v` → FAIL.

- [ ] **Step 3: Implement `sse.go` + `proxy.go` + route registration.** SSE handler sets `Content-Type: text/event-stream`, flushes per event, and calls `watcher.Unsubscribe` when `r.Context().Done()`. Proxy validates `url.Parse(raw).Host` against an allowlist before fetching.

- [ ] **Step 4: Run to verify pass** — `go test ./internal/server/ -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/
git commit --signoff -m "feat: SSE updates, mark-read, and image proxy endpoints

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: CLI — setup, serve, open

**Files:**
- Create: `main.go`, `internal/cli/cli.go`, `internal/cli/setup.go`, `internal/cli/serve.go`, `internal/cli/open.go`, `internal/cli/open_test.go`

**Interfaces:**
- Produces:
  - `func Run(args []string) int` — dispatch on `args[0]` (`setup`|`serve`|`open`), else usage.
  - `open.go`: `func probeRunningPort(ports []int, get func(string)(int,error)) (int, bool)` — returns first port whose `/api/health` returns 200.
  - `func buildOpenURL(base string, threadURLs []string) string` — appends repeated `?open=` params.
  - `serve.go`: adds `GET /api/health` → 200 to the server (modify Task 5/6 mux registration, or register here).

- [ ] **Step 1: Write failing test for URL building + port probe (pure logic)**

```go
// internal/cli/open_test.go
func TestBuildOpenURL(t *testing.T) {
	got := buildOpenURL("http://localhost:8473", []string{
		"https://redhat-internal.slack.com/archives/C1/p1700000000000001",
		"https://redhat-internal.slack.com/archives/C2/p1700000000000002",
	})
	want := "http://localhost:8473/?open=https%3A%2F%2Fredhat-internal.slack.com%2Farchives%2FC1%2Fp1700000000000001&open=https%3A%2F%2Fredhat-internal.slack.com%2Farchives%2FC2%2Fp1700000000000002"
	if got != want { t.Fatalf("got %s", got) }
}

func TestProbeRunningPortPrefersFirst(t *testing.T) {
	get := func(base string) (int, error) {
		if strings.Contains(base, "8473") { return 200, nil }
		return 0, errors.New("refused")
	}
	port, ok := probeRunningPort([]int{8473, 5174}, get)
	if !ok || port != 8473 { t.Fatalf("port=%d ok=%v", port, ok) }
}
```

- [ ] **Step 2: Run to verify fail** — `go test ./internal/cli/ -v` → FAIL.

- [ ] **Step 3: Implement the CLI.**
  - `main.go`: `func main(){ os.Exit(cli.Run(os.Args[1:])) }`.
  - `setup.go`: try import from `~/.local/share/slack-mcp/tokens.env` (parse `SLACK_MCP_XOXC_TOKEN`/`SLACK_MCP_XOXD_TOKEN`); if present, prompt to import; else prompt for manual paste of token + cookie + workspace domain; `config.Save`. Support `--yes` to auto-accept the import when `NONINTERACTIVE`.
  - `serve.go`: `config.Load()`; on `ErrNotConfigured` print guidance and return 1; build client+watcher+server; register `/api/health`; `http.ListenAndServe` on `EffectivePort()`; on `EADDRINUSE` print a clear message naming the port and `port:` config key; then `open` the browser at the base URL.
  - `open.go`: probe ports `[8473, 5174]` via `/api/health`; if none, print "no server running; run 'slack-mini serve' or 'make dev'"; else `exec.Command("open", buildOpenURL(base, threadURLs)).Run()`.

- [ ] **Step 4: Run to verify pass** — `go test ./internal/cli/ -v` → PASS. Then `go build -o bin/slack-mini . && ./bin/slack-mini` (prints usage).

- [ ] **Step 5: Commit**

```bash
git add main.go internal/cli/
git commit --signoff -m "feat: CLI with setup, serve, and open commands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Frontend scaffold (Vite + React + Mantine) + thread URL parsing

**Files:**
- Create: `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/index.html`, `ui/src/main.tsx`, `ui/src/theme.ts`, `ui/src/lib/parseThreadUrl.ts`, `ui/src/lib/parseThreadUrl.test.ts`

**Interfaces:**
- Produces:
  - `parseThreadUrl(url: string): { channel: string; threadTs: string } | null` — mirrors the extension's regex (insert dot before last 6 digits of `p`-timestamp; honor `?thread_ts=`).
  - Vite config: dev server on port `5174`, proxy `/api` (incl. `/api/events`, with `ws:false` and streaming) to `http://localhost:8473`.
  - Mantine `MantineProvider` with `defaultColorScheme="dark"`.

- [ ] **Step 1: Scaffold**

Run: `cd ui && npm create vite@latest . -- --template react-ts` (accept overwrite into empty dir), then `npm install @mantine/core @mantine/hooks @emotion/react` and `npm install -D vitest @testing-library/react jsdom`.

- [ ] **Step 2: Write the failing test**

```ts
// ui/src/lib/parseThreadUrl.test.ts
import { describe, it, expect } from 'vitest'
import { parseThreadUrl } from './parseThreadUrl'
describe('parseThreadUrl', () => {
  it('parses a reply URL with thread_ts', () => {
    expect(parseThreadUrl('https://redhat-internal.slack.com/archives/C0EXAMPLE2/p1700000000000009?thread_ts=1700000000.000005&cid=C0EXAMPLE2'))
      .toEqual({ channel: 'C0EXAMPLE2', threadTs: '1700000000.000005' })
  })
  it('parses a root message URL (no thread_ts)', () => {
    expect(parseThreadUrl('https://x.slack.com/archives/C0EXAMPLE2/p1700000000000007'))
      .toEqual({ channel: 'C0EXAMPLE2', threadTs: '1700000000.000007' })
  })
  it('returns null for non-slack URLs', () => {
    expect(parseThreadUrl('https://example.com/foo')).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify fail** — `cd ui && npx vitest run src/lib/parseThreadUrl.test.ts` → FAIL.

- [ ] **Step 4: Implement `parseThreadUrl.ts`** (regex `/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?.*thread_ts=([\d.]+))?/`; if `thread_ts` present use it as `threadTs`, else compose `ts` from the two digit groups). Set up `vite.config.ts` proxy + Mantine dark provider in `main.tsx`.

- [ ] **Step 5: Run to verify pass** — `cd ui && npx vitest run` → PASS. `npm run build` → `ui/dist/` populated.

- [ ] **Step 6: Commit**

```bash
git add ui/ && git rm --cached ui/dist/.gitkeep 2>/dev/null; echo "ui/dist/" ok
git commit --signoff -m "feat: frontend scaffold with Mantine dark theme and thread URL parsing

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
(Note: `ui/node_modules` and `ui/dist` are gitignored; keep an empty `ui/dist` locally so the Go embed compiles — recreate `.gitkeep` if needed for CI.)

---

### Task 9: Frontend — tab bar with sessionStorage + open-on-load

**Files:**
- Create: `ui/src/state/tabs.ts`, `ui/src/state/tabs.test.ts`, `ui/src/components/TabBar.tsx`, `ui/src/components/AddTabModal.tsx`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Produces:
  - `type Tab = { id: string; channel: string; threadTs: string; name: string; description: string }`
  - `loadTabs(): Tab[]` / `saveTabs(tabs: Tab[]): void` (sessionStorage key `slack-mini:tabs`).
  - `addTabFromUrl(tabs: Tab[], url: string): Tab[]` — parse + dedupe by `(channel,threadTs)`.
  - `readOpenParams(search: string): string[]` — extract repeated `open=` values from `location.search`.

- [ ] **Step 1: Write failing tests** for `addTabFromUrl` (dedupe) and `readOpenParams` (multiple values, decoding).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** tabs state + `TabBar` (Mantine `Tabs`, "+" button opens `AddTabModal`, double-click tab label → inline rename, description as tooltip) + `App` wiring that on mount reads `readOpenParams(location.search)` and adds each as a tab.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat: tab bar with sessionStorage persistence and open-on-load`.

---

### Task 10: Frontend — thread view, renderer, live updates, actions

**Files:**
- Create: `ui/src/components/ThreadView.tsx`, `ui/src/components/Message.tsx`, `ui/src/components/RichText.tsx`, `ui/src/components/RichText.test.tsx`, `ui/src/lib/api.ts`, `ui/src/hooks/useThread.ts`
- Modify: `ui/src/App.tsx`

**Interfaces:**
- Consumes: `ThreadResponse` JSON from `/api/thread` and `/api/events`.
- Produces:
  - `api.getThread(channel, threadTs): Promise<ThreadResponse>`; `api.markRead(...)`; `api.eventsUrl(channel, threadTs)`.
  - `useThread(tab)` hook: initial fetch + `EventSource` subscription; returns `{thread, users, emoji, status}`.
  - `RichText` component: renders `Element[]` → React nodes (text with bold/italic/code, `user` → resolved `@name`, `link` → anchor, `emoji` → `<img>` from emoji map or unicode char).

- [ ] **Step 1: Write failing test** for `RichText` rendering a mixed element array (text + user mention resolved via a `users` prop + custom emoji via `emoji` prop + unicode emoji).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** `api.ts`, `useThread`, `RichText`, `Message` (avatar via `/api/avatar?url=`, display name, relative timestamp, reactions row), `ThreadView` (header with **Mark thread read** / **Open in Slack** / **Refresh**, unread divider before `unreadIndex`, live-append on SSE, "new messages" pill when scrolled up). Build the "Open in Slack" deep link from `channel`+`threadTs`+workspace domain, fetching the domain once from `GET /api/config` (added in Task 5): `https://{workspaceDomain}.slack.com/archives/{channel}/p{ts-without-dot}?thread_ts={threadTs}&cid={channel}`.
- [ ] **Step 4: Run to verify pass** (`npx vitest run`), then `npm run build`.
- [ ] **Step 5: Commit** `feat: thread view with rich-text renderer, live updates, and actions`.

---

### Task 11: Makefile + end-to-end smoke

**Files:**
- Create: `Makefile`, `mprocs.yaml` (optional), `README.md`

**Interfaces:** none (tooling).

- [ ] **Step 1: Write the Makefile** mirroring agent-handler (targets `build`, `build-web`, `build-cli`, `install`, `test`, `clean`, `dev`) with **ports 8473/5174**, binary `slack-mini`, frontend dir `ui/`, `air` fallback + install hints, `mprocs` required check, and a final `lsof -ti :8473 | xargs kill` cleanup. `make test` runs both `go test ./...` and `cd ui && npx vitest run`.
- [ ] **Step 2: Build** — `make build` → `bin/slack-mini` with embedded UI.
- [ ] **Step 3: Manual smoke** — `./bin/slack-mini setup` (import from tokens.env), `./bin/slack-mini serve`, paste the Zaffre show-n-tell thread URL, verify: messages render with names/avatars/emoji/reactions, unread divider correct, **Mark thread read** returns success, **Open in Slack** opens the real thread, a new reply appears live within ~10s. Then in a second terminal `./bin/slack-mini open <threadURL>` opens a new tab in the running server.
- [ ] **Step 4: Commit** `chore: Makefile, mprocs dev config, and README`.

---

# Phase v2 — Reply sending

> **RE-EVALUATE BEFORE IMPLEMENTING.** Do not execute this phase as written. First re-read what v1 taught us (real `blocks` edge cases, how `useThread`/SSE actually behave, how the message renderer is structured, any auth/refresh pain) and **rewrite this phase's tasks** to match reality. The outline below is a starting intent, not a validated plan.

Intended scope:
- Add `chat.postMessage` to `slackapi.Client` (JSON body; params `channel`, `thread_ts`, `text`). Verify the exact payload/permissions with a live probe against a test thread before building.
- Reply input box in `ThreadView` (Mantine `Textarea` + send button; optimistic append then reconcile on next SSE poll).
- `POST /api/thread/reply` endpoint.
- Decide mrkdwn composition (plain text v2; rich composer later).
- Tests: client postMessage (httptest), endpoint (fake client), input component.

---

# Phase v3 — Full fidelity + settings toggle

> **RE-EVALUATE BEFORE IMPLEMENTING.** Full-fidelity rendering is the most speculative part of this project and depends heavily on what real payloads look like across many thread types. Before executing, **capture a diverse corpus of real payloads** (threads with files, images, unfurls, Block Kit sections, code blocks, quotes, lists) and **rewrite this phase** around what you actually find. The outline below is intent only.

Intended scope:
- Extend the `blocks`/element normalization to cover `rich_text_list`, `rich_text_quote`, `rich_text_preformatted`, and non-`rich_text` blocks (`section`, `context`, `actions`, `image`).
- Render link unfurls/attachments and file/image attachments (via the image proxy).
- Settings menu with a **core ↔ full fidelity** toggle (persisted in `sessionStorage`); when a message fails full-fidelity rendering, fall back to core automatically and surface it.
- Tests: renderer against the captured corpus; toggle behavior; graceful fallback.

---

## Notes for the executor

- Follow the Global Constraints for every task.
- After each task: run the task's tests (green), then the full suite (`make test`) before committing.
- The fixture `internal/slackapi/testdata/replies.json` MUST be synthetic/sanitized (see Task 2 Step 1) — never commit real internal Slack message content, and never add token/cookie values anywhere.
- If a Slack payload field differs from the fixture during implementation, update the raw structs and add a regression fixture rather than working around it in the renderer.
