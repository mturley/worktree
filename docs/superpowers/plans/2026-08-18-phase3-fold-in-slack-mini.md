# Phase 3 — Fold slack-mini into worktree (live Slack tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the slack-mini live Slack-thread viewer (view + reply + reactions) into worktree as a per-worktree "Slack" tab, with Slack threads modeled as worktree resources, then archive the slack-mini repo.

**Architecture:** Move slack-mini's Go packages (`slackapi`, its server handlers, its per-thread poller) into worktree, merging the HTTP handlers into worktree's existing `internal/webui` server (one server, port 8475) and renaming slack-mini's `internal/watcher` to `internal/slackpoller` (to avoid confusion with the `github.com/mturley/watcher` library AND with worktree's existing pr/jira poll loop in `internal/webui/poller.go`). Port slack-mini's Mantine/React frontend into worktree's `ui/`, surfaced as a "Slack" tab in the worktree detail view that shows the live threads for that worktree's `slack`-type resources. Slack credentials (token + cookie + workspace domain) live in the shared `~/.config/watcher/auth.yaml` via the watcher config package (requires a small watcher library release adding a `Cookie` field).

**Tech Stack:** Go 1.26 + `net/http` ServeMux; `github.com/mturley/watcher` (config for creds); React 19 + Vite 6 + `@mantine/core`/`@mantine/hooks` 7 + `@dnd-kit/*` + `node-emoji`; vitest + @testing-library/react (new to worktree); SSE via `EventSource`.

**Spec:** `docs/superpowers/specs/2026-08-11-worktree-ui-and-watcher-adoption-roadmap.md` (Phase 3 section). Recon map: memory note `phase3-foldin-recon`.

## Global Constraints

- **Scope: the live Slack tab only (view + reply + reactions + files/unfurls).** NO watcher Slack *poller*/timeline events (that is Phase 4). NO Slack in the global/scoped timeline this phase.
- **Per-worktree scoping.** Slack threads are worktree **resources** (`Type:"slack"`, `ID:"<channel_id>:<thread_ts>"`, `URL`=Slack permalink). The Slack tab in a worktree's detail view shows the live threads for THAT worktree's slack resources. There is NO flat global thread list, and NO sessionStorage-backed arbitrary-thread tab bar (slack-mini's flat model is replaced by resource-scoping).
- **Slack credentials → `~/.config/watcher/auth.yaml`** via `github.com/mturley/watcher/config` (`wconfig`): the `Services.Slack` block holds `token`, `cookie`, `workspace_domain`. worktree's own `~/.config/worktree/config.yaml` gets NO Slack fields. This requires watcher release **v0.2.7** (Task 1) adding `Cookie` + `WorkspaceDomain` to `SlackConfig`/`SlackCreds`.
- **Slack auth = token (`xoxc-`) + cookie (`xoxd-`, sent as `Cookie: d=<cookie>`).** Both required; it's a browser user session, not a bot/OAuth app. `slackapi.New(token, cookie)`.
- **DROP the send-allowlist.** slack-mini guarded reply/react by `cfg.SendAllowlist`; do NOT port that guard — replies/reactions are unrestricted (empty allowlist was slack-mini's default anyway). No allowlist config field anywhere.
- **Rename `internal/watcher` → `internal/slackpoller`** on move (package `slackpoller`, type `Poller` → `slackpoller.Poller`). Never introduce a local package literally named `watcher` (collides conceptually with the `mturley/watcher` library import), and don't call it just `poller` (worktree already has a pr/jira poll loop in `internal/webui/poller.go`).
- **One HTTP server, one port.** Slack routes merge into `internal/webui`'s `registerAPI`. slack-mini's standalone `internal/server.Server`, its `internal/config` package (creds go to watcher auth.yaml; allowlist dropped — nothing left to keep), its own `--api-only`, its `DefaultPort=8473`, its `internal/cli`, `main.go`, and `ui/embed.go` are NOT carried over (worktree already has all these). Ports stay 8475 (prod) / 5175 (dev).
- **Frontend: React 19 + Vite 6** (worktree's versions win). slack-mini components are React 18; verify they typecheck/build under 19. Add deps `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `node-emoji`.
- **Bring vitest test infrastructure into worktree** (worktree has none today). Port slack-mini's Slack-component/lib tests, AND add sensible tests for the pre-existing worktree UI (Task 11).
- **Preserve slack-mini's SSRF hardening** on the image proxies verbatim (https-only, exact-host match, no-redirects).
- **The ThreadResponse wire format is asymmetric:** camelCase top-level, PascalCase nested (Go default on the embedded `slackapi.Message`). The frontend api client mirrors this. Preserve it exactly — do not "fix" one side.
- **Do NOT fold in clutter or vaporware:** skip slack-mini's `.playwright-mcp/`, loose `*.png`, `mprocs.log`, `tmp/`, `bin/`, `.superpowers/`. There is NO "core vs full-fidelity toggle" — it was never implemented; ignore any spec reference.
- `go build ./...` + `go test ./...` + `make build` stay green at each task boundary. Frontend: `cd ui && npm run build` (tsc + vite) and `npm test` (once Task 8 lands) stay green.
- **`gofmt -l` clean; explicit lowercase JSON tags** on any new Go response structs; empty lists serialize `[]` not null.

---

## File Structure

**watcher library (Task 1, separate repo `~/git/watcher`):**
- `config/config.go` — extend `SlackConfig` + `SlackCreds` + `Slack()` with `Cookie` + `WorkspaceDomain`.

**worktree Go (new/moved packages):**
- `internal/slackapi/` — moved verbatim from slack-mini (`client.go`, `types.go`, `normalize.go` + tests + testdata). The `Client` interface + `HTTPClient`.
- `internal/slackpoller/` — moved from slack-mini `internal/watcher` (RENAMED package `slackpoller`): per-thread poll + SSE fan-out (`Watcher` type → `Poller`; see Task 3). Also carries the Slack reverse-engineering doc (see below).
- `docs/reverse-engineering/slack-web-api.md` — moved from slack-mini: the authoritative reference for Slack's undocumented Web API (auth, endpoints, payload shapes, quirks). Carried over WITH its "read and maintain" CLAUDE.md rule.
- `internal/slackcreds/` (or a function in an existing pkg) — loads Slack token/cookie/domain from watcher auth.yaml, builds a `slackapi.Client`.
- `internal/webui/slack.go` — the Slack HTTP handlers merged in (thread/reply/react/config/events/avatar/emoji/file), the `buildThreadResponse` enrichment, image proxy.
- `internal/webui/server.go` — add `SlackClient slackapi.Client` + `SlackPoller *slackpoller.Poller` + `SlackDomain string` fields to `Server`; register Slack routes in `registerAPI`.
- `cmd/ui.go` — construct the slackapi client + poller from watcher creds, pass into `webui.Server`.
- `internal/setup/setup.go` + `cmd/setup.go` — add a `ConfigureSlack`/`TestSlack` step; `internal/setup/slack.go` for the acquisition flow; `internal/setup/extract.go` + `extract.mjs` moved from slack-mini.
- `internal/slackurl/` (small) — parse a Slack permalink → `channel, threadTS` (for `cmd/add.go` + resource creation). Ported from slack-mini `ui/src/lib/parseThreadUrl.ts` logic, Go side.
- `cmd/add.go` — add a Slack-URL dispatch branch.

**worktree frontend (`ui/`):**
- `ui/package.json` — add `@dnd-kit/*`, `node-emoji`, and dev: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`.
- `ui/vitest.config.ts` (or vite config `test` block) — jsdom env.
- `ui/src/components/slack/` — the ~13 Slack components (TabBar, ThreadView, Message, RichText, Composer, ActionBar, ReactionPill, Attachments, BlockKit, FileAttachments, AddTabModal, EditTabModal, TabDetailsModal) + tests.
- `ui/src/api/slackApi.ts` — Slack endpoints + wire types (from slack-mini `ui/src/lib/api.ts`).
- `ui/src/hooks/` — `useThread`, `useTabMetas`, `useNow` (from slack-mini).
- `ui/src/lib/` — `parseThreadUrl`, `deriveThreadMeta`, `reactionToggle`, `unreadPatch`, `emoji`, `renderEmoji`, `mrkdwn`, `fallbackTitle`, `openThread` (from slack-mini; reconcile `relativeTime.ts` collision).
- `ui/src/pages/WorktreeDetailPage.tsx` — wrap in Mantine `Tabs` (Overview | Slack); new `ui/src/components/SlackTab.tsx` drives the per-worktree Slack view from the worktree's slack resources.
- `ui/src/components/ResourceCard.tsx` — add `SlackCardBody` for `type==="slack"`.

**Docs/build (Task 12):** `Makefile` (npm test target), `docs/web-ui-architecture.md`, `.claude/CLAUDE.md`, archive slack-mini.

Task ordering: watcher release first (creds shape), then Go backend bottom-up (slackapi → poller → creds → webui routes → setup → resource/add), then frontend infra → components → tab → existing-UI tests, then build/docs/archive last.

---

### Task 1: watcher v0.2.7 — add Cookie + WorkspaceDomain to SlackConfig

**Files (in `~/git/watcher`, NOT the worktree):**
- Modify: `config/config.go`
- Test: `config/config_test.go`

**Interfaces:**
- Produces: `wconfig.SlackConfig{ Token, Cookie, WorkspaceDomain string }`; `wconfig.SlackCreds{ Token, Cookie, WorkspaceDomain string }`; `(*Config).Slack() (SlackCreds, error)` returns creds when token AND cookie are set.

- [ ] **Step 1: Work in the watcher repo**

Run: `cd /Users/mturley/git/watcher && git rev-parse --show-toplevel` — confirm it is `/Users/mturley/git/watcher` on `main`. Do all Task-1 work here. NOTE: this repo may carry unrelated uncommitted work from other sessions — do NOT touch or commit it; stage only `config/config.go` + `config/config_test.go`.

- [ ] **Step 2: Write the failing test**

Add to `config/config_test.go`:
```go
func TestSlackReturnsTokenCookieAndDomain(t *testing.T) {
	c := &Config{Services: Services{Slack: &SlackConfig{
		Token: "xoxc-1", Cookie: "xoxd-2", WorkspaceDomain: "acme.slack.com",
	}}}
	creds, err := c.Slack()
	if err != nil {
		t.Fatal(err)
	}
	if creds.Token != "xoxc-1" || creds.Cookie != "xoxd-2" || creds.WorkspaceDomain != "acme.slack.com" {
		t.Fatalf("got %+v", creds)
	}
}

func TestSlackNotConfiguredWithoutCookie(t *testing.T) {
	c := &Config{Services: Services{Slack: &SlackConfig{Token: "xoxc-1"}}} // no cookie
	if _, err := c.Slack(); err == nil {
		t.Fatal("expected error when cookie missing")
	}
}
```

- [ ] **Step 3: Run to verify failure**

Run: `go test ./config/ -run TestSlack -v`
Expected: FAIL to compile (`Cookie`/`WorkspaceDomain` fields don't exist).

- [ ] **Step 4: Extend the structs + accessor**

In `config/config.go`, change `SlackConfig`:
```go
// SlackConfig contains Slack API credentials. Slack uses a browser user
// session: a token (xoxc-) plus the d= cookie (xoxd-). WorkspaceDomain is
// resolved at setup time (via team.info) and used to build permalinks.
type SlackConfig struct {
	Token           string `yaml:"token"`
	Cookie          string `yaml:"cookie"`
	WorkspaceDomain string `yaml:"workspace_domain,omitempty"`
}
```
Change `SlackCreds`:
```go
type SlackCreds struct {
	Token           string
	Cookie          string
	WorkspaceDomain string
}
```
Change `Slack()`:
```go
func (c *Config) Slack() (SlackCreds, error) {
	if c.Services.Slack == nil || c.Services.Slack.Token == "" || c.Services.Slack.Cookie == "" {
		return SlackCreds{}, fmt.Errorf("slack not configured")
	}
	return SlackCreds{
		Token:           c.Services.Slack.Token,
		Cookie:          c.Services.Slack.Cookie,
		WorkspaceDomain: c.Services.Slack.WorkspaceDomain,
	}, nil
}
```

- [ ] **Step 5: Run to verify pass + full watcher suite**

Run: `go test ./... -count=1 && go vet ./... && gofmt -l config/config.go config/config_test.go`
Expected: all pass; gofmt prints nothing. (No schema change; this is pure config-struct.)

- [ ] **Step 6: Commit + tag + push**

```bash
git add config/config.go config/config_test.go
git commit --signoff -m "feat(config): add Cookie + WorkspaceDomain to SlackConfig for browser-session Slack auth

Slack uses a browser user session (xoxc- token + d=/xoxd- cookie), so a
token alone is insufficient. Add Cookie and WorkspaceDomain to SlackConfig
and SlackCreds; Slack() now requires both token and cookie. Enables worktree
(and later handler) to store Slack creds in the shared watcher auth.yaml.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git tag -a v0.2.7 -m "Add Cookie + WorkspaceDomain to SlackConfig"
```
Verify the COMMITTED tree in isolation before pushing (a prior release had a working-tree-masks-broken-commit bug):
```bash
git worktree add --detach /Users/mturley/tmp/watcher-v027-verify v0.2.7
cd /Users/mturley/tmp/watcher-v027-verify && go build ./... && go test ./... -count=1
cd /Users/mturley/git/watcher && git worktree remove --force /Users/mturley/tmp/watcher-v027-verify
```
Then push: `git push origin main && git push origin v0.2.7`.
(If push fails on the 1Password SSH agent being locked, report — the controller/human pushes.)

- [ ] **Step 7: Report the tag** — return the commit sha + `v0.2.7` and whether push succeeded.

---

### Task 2: Move slackapi package into worktree

**Files:**
- Create (copy from slack-mini): `internal/slackapi/client.go`, `internal/slackapi/types.go`, `internal/slackapi/normalize.go`, and all `internal/slackapi/*_test.go` + `internal/slackapi/testdata/**`.
- Modify: `go.mod` (pin watcher v0.2.7 from Task 1)

**Interfaces:**
- Produces: package `github.com/mturley/worktree/internal/slackapi` with the `Client` interface (`AuthTest, WhoAmI, Replies, Users, Channel, Emoji, MarkRead, MarkUnread, PostReply, AddReaction, RemoveReaction`), `HTTPClient`, `New(token, cookie string) *HTTPClient`, `NewWithBaseURL(token, cookie, baseURL string) *HTTPClient`, `TeamInfo(ctx) (string, error)`, `ErrAuth`, and domain types (`Thread, Message, Reaction, User, File, Attachment, Block, Element, Style, BlockKit, TextObject, BlockElement`).

- [ ] **Step 1: Pin watcher v0.2.7**

Run: `go get github.com/mturley/watcher@v0.2.7 && go mod tidy && grep watcher go.mod` (expect v0.2.7). Then `go build ./...` (still green — nothing uses the new fields yet).

- [ ] **Step 2: Copy the package with `git mv`-style fidelity**

Copy the files from `~/git/slack-mini/internal/slackapi/` into `internal/slackapi/` (use `cp -R`, since it's a cross-repo move, not a git mv). Include `client.go`, `types.go`, `normalize.go`, every `*_test.go`, and the `testdata/` dir. Then rewrite the package's internal import paths: slack-mini's slackapi has NO cross-package imports of its own module (it's a leaf package), so no import-path rewrites should be needed — verify with `grep -rn "mturley/slack-mini" internal/slackapi/` (expect nothing; if any appear, rewrite to `mturley/worktree`).

- [ ] **Step 3: Build + test the moved package**

Run: `go build ./internal/slackapi/ && go test ./internal/slackapi/ -count=1`
Expected: PASS (slackapi is self-contained; its tests use `NewWithBaseURL` against httptest). Fix any stray import path if the build complains.

- [ ] **Step 4: Full build**

Run: `go build ./... && go vet ./internal/slackapi/ && gofmt -l internal/slackapi/`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add go.mod go.sum internal/slackapi/
git commit --signoff -m "feat(slackapi): vendor the Slack API client from slack-mini; pin watcher v0.2.7

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Move slack-mini's watcher → internal/slackpoller (renamed) + the Slack reverse-engineering doc

**Files:**
- Create (copy + rename from slack-mini `internal/watcher/`): `internal/slackpoller/slackpoller.go` (+ `*_test.go`)
- Create (copy from slack-mini): `docs/reverse-engineering/slack-web-api.md`
- Create (copy from slack-mini): `docs/superpowers/specs/slack-mini-history/*` (the 7 Slack design specs + their plans + a short README)

**Interfaces:**
- Consumes: `internal/slackapi` (Task 2).
- Produces: package `github.com/mturley/worktree/internal/slackpoller` with: `type Poller struct{...}`, `func New(c slackapi.Client, interval time.Duration, now func() time.Time) *Poller`, `type ThreadUpdate struct{ Channel, ThreadTS string; Thread slackapi.Thread }`, methods `Poll(ctx, ch, ts) (ThreadUpdate, bool, error)`, `Subscribe(ch, ts) (<-chan ThreadUpdate, func())`, `Close()`. So callers write `slackpoller.New(...)` / `*slackpoller.Poller`.

- [ ] **Step 1: Copy + rename the package**

Copy `~/git/slack-mini/internal/watcher/watcher.go` → `internal/slackpoller/slackpoller.go` and its test(s) → `internal/slackpoller/*_test.go`. In the copied files:
- Change `package watcher` → `package slackpoller`.
- RENAME the exported type `Watcher` → `Poller`. Update its constructor `New`, all method receivers (`*Watcher` → `*Poller`), and any internal references. Unexported helpers (`loopState`, `signature`, etc.) keep their names.
- Update the slackapi import to `github.com/mturley/worktree/internal/slackapi`.
- Update any test that referenced `watcher.Watcher`/`watcher.New` → `slackpoller.Poller`/`slackpoller.New`.

- [ ] **Step 2: Move the reverse-engineering doc + the Slack design history**

Copy `~/git/slack-mini/docs/reverse-engineering/slack-web-api.md` → `docs/reverse-engineering/slack-web-api.md` (verbatim — it's the authoritative reference for Slack's undocumented Web API: auth, endpoints, payload shapes, quirks, verified by experiment). Its accompanying "read and maintain" CLAUDE.md rule is added to worktree's CLAUDE.md in Task 12. Do NOT edit the doc's content — just move it.

ALSO copy slack-mini's per-phase Slack design history so it travels with the folded-in code (the slack-mini repo is archived in Task 12; preserve the "how each Slack feature was designed" provenance here). Copy these into a `docs/superpowers/specs/slack-mini-history/` subfolder (keep them grouped + clearly historical, so they don't clutter worktree's own live specs):
- All `~/git/slack-mini/docs/superpowers/specs/*slack-mini*.md` (the 7 design docs: 2026-08-07 original, v2-replies, v3a-images-files, v3b-unfurls, v3d-blockkit, reaction-toggle, and any others present).
- All `~/git/slack-mini/docs/superpowers/plans/*slack-mini*.md` (the matching implementation plans).
Copy verbatim (they're historical records — do not edit). Add a one-line `docs/superpowers/specs/slack-mini-history/README.md`: "Historical design specs + plans for the Slack thread viewer, folded into worktree from the (now-archived) slack-mini repo in Phase 3 (2026-08). See docs/reverse-engineering/slack-web-api.md for the live Slack API reference."

- [ ] **Step 3: Build + test**

Run: `go build ./internal/slackpoller/ && go test ./internal/slackpoller/ -count=1`
Expected: PASS (the poller's tests use a fake `slackapi.Client`). Fix references until green.

- [ ] **Step 4: Confirm no lingering `watcher` package name / full build**

Run: `grep -rn "package watcher\|watcher.Watcher\|internal/watcher" internal/slackpoller/` (expect nothing) and `go build ./... && go vet ./internal/slackpoller/ && gofmt -l internal/slackpoller/`.
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add internal/slackpoller/ docs/reverse-engineering/ docs/superpowers/specs/slack-mini-history/
git commit --signoff -m "feat(slackpoller): vendor slack-mini's per-thread poller + Slack docs/history

Renamed from slack-mini's internal/watcher to slackpoller to avoid confusion
with the github.com/mturley/watcher library and worktree's own pr/jira poll
loop. Per-(channel,thread) poll loop with SSE fan-out; in-memory, no DB.
Also carries over docs/reverse-engineering/slack-web-api.md (the authoritative
Slack Web API reference) and slack-mini's per-phase design specs+plans under
docs/superpowers/specs/slack-mini-history/.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Slack credentials loader (from watcher auth.yaml)

**Files:**
- Create: `internal/slackcreds/slackcreds.go`
- Test: `internal/slackcreds/slackcreds_test.go`

**Interfaces:**
- Consumes: `wconfig` (`github.com/mturley/watcher/config`), `internal/slackapi`.
- Produces:
  - `func Load() (token, cookie, domain string, err error)` — reads `wconfig.Load(wconfig.DefaultPath()).Slack()`; err if not configured.
  - `func Client() (slackapi.Client, domain string, err error)` — convenience: Load + `slackapi.New(token, cookie)`.

- [ ] **Step 1: Write the failing test**

Create `internal/slackcreds/slackcreds_test.go`. Since `wconfig.DefaultPath()` reads a real home path, test the pure mapping via a helper that takes a `*wconfig.Config`:
```go
package slackcreds

import (
	"testing"
	wconfig "github.com/mturley/watcher/config"
)

func TestFromConfig(t *testing.T) {
	cfg := &wconfig.Config{Services: wconfig.Services{Slack: &wconfig.SlackConfig{
		Token: "xoxc-t", Cookie: "xoxd-c", WorkspaceDomain: "acme.slack.com",
	}}}
	tok, ck, dom, err := fromConfig(cfg)
	if err != nil || tok != "xoxc-t" || ck != "xoxd-c" || dom != "acme.slack.com" {
		t.Fatalf("got %q %q %q err=%v", tok, ck, dom, err)
	}
}

func TestFromConfigNotConfigured(t *testing.T) {
	if _, _, _, err := fromConfig(&wconfig.Config{}); err == nil {
		t.Fatal("expected not-configured error")
	}
}
```

- [ ] **Step 2: Run to verify failure** — `go test ./internal/slackcreds/ -v` → FAIL (undefined).

- [ ] **Step 3: Implement**

```go
package slackcreds

import (
	"fmt"

	wconfig "github.com/mturley/watcher/config"
	"github.com/mturley/worktree/internal/slackapi"
)

func fromConfig(cfg *wconfig.Config) (token, cookie, domain string, err error) {
	creds, err := cfg.Slack()
	if err != nil {
		return "", "", "", err
	}
	return creds.Token, creds.Cookie, creds.WorkspaceDomain, nil
}

// Load reads Slack credentials from the shared watcher auth.yaml.
func Load() (token, cookie, domain string, err error) {
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		return "", "", "", fmt.Errorf("loading watcher config: %w", err)
	}
	return fromConfig(cfg)
}

// Client builds a Slack API client from the stored credentials.
func Client() (slackapi.Client, string, error) {
	token, cookie, domain, err := Load()
	if err != nil {
		return nil, "", err
	}
	return slackapi.New(token, cookie), domain, nil
}
```

- [ ] **Step 4: Run to verify pass + build** — `go test ./internal/slackcreds/ -v && go build ./...` → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add internal/slackcreds/
git commit --signoff -m "feat(slackcreds): load Slack token/cookie/domain from shared watcher auth.yaml

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Merge Slack HTTP handlers into internal/webui

**Files:**
- Create: `internal/webui/slack.go` (handlers), `internal/webui/slack_proxy.go` (image proxies), `internal/webui/slack_sse.go` (thread SSE)
- Modify: `internal/webui/server.go` (Server fields + registerAPI)
- Modify: `cmd/ui.go` (construct slack client + poller, pass in)
- Test: `internal/webui/slack_test.go`

**Interfaces:**
- Consumes: `internal/slackapi` (Task 2), `internal/slackpoller` (Task 3), `internal/slackcreds` (Task 4).
- Produces on `Server`: fields `SlackClient slackapi.Client`, `SlackPoller *slackpoller.Poller`, `SlackDomain string`. New routes:
  - `GET /api/thread?channel=&thread_ts=` → thread JSON (`buildThreadResponse`)
  - `POST /api/thread/mark-read` / `POST /api/thread/mark-unread` (body `{channel,thread_ts,ts}`)
  - `POST /api/thread/reply` (body `{channel,thread_ts,text}`) — NO allowlist
  - `POST /api/thread/react` (body `{channel,ts,name,add}`) — NO allowlist
  - `GET /api/slack-config` → `{workspaceDomain}`
  - `GET /api/thread-events?channel=&thread_ts=` → SSE (per-thread live updates via `SlackPoller.Subscribe`)
  - `GET /api/slack-avatar|slack-emoji|slack-file?url=` → host-pinned image proxies

- [ ] **Step 1: Port the server handlers, dropping the allowlist + renaming routes**

Copy the handler bodies from slack-mini `internal/server/{server.go,proxy.go,sse.go}` into `internal/webui/slack.go` / `slack_proxy.go` / `slack_sse.go`, adapting:
- They become methods on worktree's `webui.Server` (which now has `SlackClient`, `SlackPoller`, `SlackDomain`, `Logger`, caches). Port the emoji/channel/currentUser caches (`emojiMu`/`emojiCache`, etc.) as fields on `Server` — add them to the struct in server.go.
- Replace slack-mini's `s.cfg` usage: `s.cfg.SendAllowlist` guard in `handleReply`/`handleReact` is DELETED entirely (no allowlist). `s.cfg.WorkspaceDomain` → `s.SlackDomain`. `s.cfg.EffectivePort()` → not needed (drop `/api/config`'s port field; keep only `workspaceDomain`).
- Replace `s.client` → `s.SlackClient`; `s.watcher` → `s.SlackPoller`.
- RENAME routes to avoid collisions and namespace them clearly: keep `/api/thread`, `/api/thread/mark-read`, `/api/thread/mark-unread`, `/api/thread/reply`, `/api/thread/react` (none collide with worktree's existing routes — verified), but rename the ambiguous ones: slack-mini's `/api/config` → `/api/slack-config`; `/api/events` → `/api/thread-events`; `/api/avatar|emoji|file` → `/api/slack-avatar|slack-emoji|slack-file`. (Rationale: `/api/config`/`/api/events` are too generic for a multi-feature server.)
- Preserve `buildThreadResponse` (the shared enrichment used by both the GET and SSE paths) verbatim, as a `Server` method.
- Preserve the image-proxy SSRF hardening verbatim (https-only, exact host `avatars.slack-edge.com`/`emoji.slack-edge.com`/`files.slack.com`, `http.ErrUseLastResponse` no-redirects; the `files.slack.com` proxy forwards the `d=` cookie).
- Guard every Slack handler: if `s.SlackClient == nil` (Slack not configured), return `503` with `{"error":"slack not configured; run worktree setup"}` rather than nil-panicking.

- [ ] **Step 2: Add fields + register routes in server.go**

Add to `Server` struct: `SlackClient slackapi.Client`, `SlackPoller *slackpoller.Poller`, `SlackDomain string`, plus the caches (`emojiMu sync.Mutex; emojiCache map[string]string; channelMu sync.Mutex; channelCache map[string]string; currentUserMu sync.Mutex; currentUserID string; currentUserKnown bool`). In `registerAPI`, append:
```go
mux.HandleFunc("GET /api/thread", s.handleThread)
mux.HandleFunc("POST /api/thread/mark-read", s.handleMarkRead)
mux.HandleFunc("POST /api/thread/mark-unread", s.handleMarkUnread)
mux.HandleFunc("POST /api/thread/reply", s.handleReply)
mux.HandleFunc("POST /api/thread/react", s.handleReact)
mux.HandleFunc("GET /api/slack-config", s.handleSlackConfig)
mux.HandleFunc("GET /api/thread-events", s.handleThreadEvents)
mux.HandleFunc("GET /api/slack-avatar", s.handleSlackAvatar)
mux.HandleFunc("GET /api/slack-emoji", s.handleSlackEmoji)
mux.HandleFunc("GET /api/slack-file", s.handleSlackFile)
```

- [ ] **Step 3: Wire construction in cmd/ui.go**

After `conn, err := wdb.Open()` and building `logger`, construct the Slack client best-effort (Slack being unconfigured must NOT block the UI):
```go
var slackClient slackapi.Client
var slackPoller *slackpoller.Poller
var slackDomain string
if c, dom, err := slackcreds.Client(); err == nil {
	slackClient = c
	slackDomain = dom
	slackPoller = slackpoller.New(c, 8*time.Second, time.Now)
	defer slackPoller.Close()
} else {
	logger.Printf("Slack not configured (%v); Slack tab will be unavailable", err)
}
srv := &webui.Server{DB: conn, WebFS: webFS, Port: uiPort, DevMode: uiAPIOnly, Logger: logger,
	SlackClient: slackClient, SlackPoller: slackPoller, SlackDomain: slackDomain}
```
Add imports: `internal/slackapi`, `internal/slackpoller`, `internal/slackcreds`.

- [ ] **Step 4: Write a handler test (httptest + fake client)**

Port slack-mini's server test helper (the `fakeClient` implementing `slackapi.Client`) into `internal/webui/slack_test.go`. Assert at minimum:
- `GET /api/thread?channel=C1&thread_ts=1.0` returns 200 + a ThreadResponse with the fake's messages.
- `POST /api/thread/reply` calls the fake's `PostReply` and returns the message (NO allowlist rejection — a reply to any channel succeeds).
- With `SlackClient == nil`, `GET /api/thread` returns 503.
```go
func TestSlackThreadEndpoint(t *testing.T) {
	fake := newFakeSlack() // returns a Thread with one message
	srv := &Server{SlackClient: fake, SlackDomain: "acme.slack.com"}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, _ := http.Get(ts.URL + "/api/thread?channel=C1&thread_ts=1.0")
	if resp.StatusCode != 200 { t.Fatalf("got %d", resp.StatusCode) }
	// decode + assert messages present
}

func TestSlackReplyNoAllowlist(t *testing.T) {
	fake := newFakeSlack()
	srv := &Server{SlackClient: fake, SlackDomain: "acme.slack.com"}
	ts := httptest.NewServer(srv.Handler()); defer ts.Close()
	body := strings.NewReader(`{"channel":"C1","thread_ts":"1.0","text":"hi"}`)
	resp, _ := http.Post(ts.URL+"/api/thread/reply", "application/json", body)
	if resp.StatusCode != 200 { t.Fatalf("reply should succeed for any channel, got %d", resp.StatusCode) }
	if fake.replyCalls != 1 { t.Fatalf("PostReply not called") }
}

func TestSlackThreadUnconfigured(t *testing.T) {
	srv := &Server{SlackClient: nil}
	ts := httptest.NewServer(srv.Handler()); defer ts.Close()
	resp, _ := http.Get(ts.URL + "/api/thread?channel=C1&thread_ts=1.0")
	if resp.StatusCode != 503 { t.Fatalf("expected 503 when Slack unconfigured, got %d", resp.StatusCode) }
}
```

- [ ] **Step 5: Run tests + full build**

Run: `go test ./internal/webui/ -count=1 && go build ./... && go vet ./internal/webui/ && gofmt -l internal/webui/`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add internal/webui/ cmd/ui.go
git commit --signoff -m "feat(webui): merge Slack thread/reply/react/proxy handlers into the UI server

Ports slack-mini's HTTP handlers onto webui.Server (one server, port 8475),
namespaced routes (/api/thread*, /api/slack-*), driven by a slackapi client +
per-thread poller built from watcher auth.yaml creds. Send-allowlist dropped;
Slack handlers 503 when unconfigured. SSRF hardening on image proxies preserved.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Slack token acquisition in `worktree setup`

**Files:**
- Create: `internal/setup/slack.go`, `internal/setup/extract.go`, `internal/setup/extract.mjs`
- Modify: `internal/setup/setup.go` (Plan fields + Execute step + Preview)
- Test: `internal/setup/slack_test.go`

**Interfaces:**
- Consumes: `internal/slackapi` (`New`, `TeamInfo`, `AuthTest`), `wconfig` (Load/Save).
- Produces: a `worktree setup` step that acquires Slack token+cookie (auto via extract.mjs, or manual prompts), validates + resolves workspace domain via `TeamInfo`, and writes them to `~/.config/watcher/auth.yaml` under `services.slack`.

- [ ] **Step 1: Port the extraction machinery**

Copy `~/git/slack-mini/internal/cli/extract.go` + `extract.mjs` into `internal/setup/extract.go` + `internal/setup/extract.mjs`. Adapt: `package cli` → `package setup`; keep the `//go:embed extract.mjs` directive; keep the cache-dir install of Playwright (`~/.cache/worktree/` instead of `~/.cache/slack-mini/` — rename the cache subdir). Export or keep the entry `runAutoExtract() (token, cookie string, err error)` usable from the setup step.

- [ ] **Step 2: Port the acquisition flow (dropping slack-mini's config write)**

Create `internal/setup/slack.go` with `promptAndSaveSlack(...)`, adapted from slack-mini `internal/cli/setup.go`'s credential flow, but:
- Instead of slack-mini's `config.Save`, write to watcher auth.yaml: `cfg, _ := wconfig.Load(wconfig.DefaultPath()); if cfg.Services.Slack == nil { cfg.Services.Slack = &wconfig.SlackConfig{} }; cfg.Services.Slack.Token = token; cfg.Services.Slack.Cookie = cookie; cfg.Services.Slack.WorkspaceDomain = domain; cfg.Save(wconfig.DefaultPath())`.
- Resolve `domain` via `slackapi.New(token,cookie).TeamInfo(ctx)` (validates creds too).
- Keep BOTH acquisition paths: auto-extract (only when interactive + node/npx available), manual devtools-instructions + prompts fallback. Reuse worktree's existing prompt helpers from `internal/setup` if present (check `promptString`-style helpers); otherwise port slack-mini's.

- [ ] **Step 3: Add the step to the setup Plan**

In `internal/setup/setup.go`: add `ConfigureSlack bool` (and optionally `TestSlack bool`) to the `Plan` struct alongside `ConfigureJira`. In `BuildPlan`, set `ConfigureSlack` = true when Slack isn't already configured in watcher auth.yaml (best-effort `wconfig.Load(...).Slack()` returns error). In `Preview()`, add a line ("Configure Slack (token + cookie) → ~/.config/watcher/auth.yaml"). In `Execute()`, add the `if p.ConfigureSlack { promptAndSaveSlack(...) }` block after the Jira step. Make it best-effort (a Slack setup failure warns, doesn't abort the whole setup — like the existing `registerWatcherConsumer`).

- [ ] **Step 4: Test the pure config-write mapping**

Slack acquisition is interactive/network (extract, prompts, TeamInfo) — not unit-testable end-to-end. Test the pure write step: a `writeSlackCreds(cfg *wconfig.Config, token, cookie, domain string)` helper that mutates the config, asserting the fields land under `Services.Slack`:
```go
func TestWriteSlackCreds(t *testing.T) {
	cfg := &wconfig.Config{}
	writeSlackCreds(cfg, "xoxc-t", "xoxd-c", "acme.slack.com")
	if cfg.Services.Slack == nil || cfg.Services.Slack.Token != "xoxc-t" ||
		cfg.Services.Slack.Cookie != "xoxd-c" || cfg.Services.Slack.WorkspaceDomain != "acme.slack.com" {
		t.Fatalf("got %+v", cfg.Services.Slack)
	}
}
```
Factor `promptAndSaveSlack` to call `writeSlackCreds` so the mutation is covered.

- [ ] **Step 5: Run tests + build**

Run: `go test ./internal/setup/ -count=1 && go build ./... && go vet ./internal/setup/ && gofmt -l internal/setup/`
Expected: green. (Do NOT run the interactive setup in CI/subagent; the write-helper test + build is the gate. Document that manual smoke of the extract flow is a human step.)

- [ ] **Step 6: Commit**

```bash
git add internal/setup/ 
git commit --signoff -m "feat(setup): acquire Slack token+cookie in worktree setup, store in watcher auth.yaml

Folds slack-mini's credential-acquisition (Playwright auto-extract + manual
fallback) into a worktree setup step; resolves workspace domain via team.info;
writes services.slack to ~/.config/watcher/auth.yaml.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Slack thread as a worktree resource (card + add-URL)

**Files:**
- Create: `internal/slackurl/slackurl.go` + `internal/slackurl/slackurl_test.go`
- Modify: `cmd/add.go` (Slack-URL dispatch)
- Modify: `ui/src/components/ResourceCard.tsx` (SlackCardBody)
- Modify: `ui/src/api/types.ts` (ResourceDTO already has type/id/url — no change likely; verify)

**Interfaces:**
- Produces: `slackurl.Parse(url string) (channel, threadTS string, ok bool)`; `slackurl.ResourceID(channel, threadTS string) string` = `channel + ":" + threadTS`. `worktree add <slack-permalink>` attaches a `slack` resource to the current/ös worktree. A `SlackCardBody` renders slack resources in the detail resource list.

- [ ] **Step 1: Write the failing test for the URL parser**

Create `internal/slackurl/slackurl_test.go`:
```go
package slackurl

import "testing"

func TestParse(t *testing.T) {
	ch, ts, ok := Parse("https://acme.slack.com/archives/C0123ABCD/p1699999999000100")
	if !ok || ch != "C0123ABCD" || ts != "1699999999.000100" {
		t.Fatalf("got %q %q %v", ch, ts, ok)
	}
	if _, _, ok := Parse("https://github.com/x/y/pull/1"); ok {
		t.Fatal("non-slack URL should not parse")
	}
}

func TestResourceID(t *testing.T) {
	if ResourceID("C1", "1699999999.000100") != "C1:1699999999.000100" {
		t.Fatal()
	}
}
```
(Note the `pTIMESTAMP` → `TIMESTAMP` conversion: `p1699999999000100` → `1699999999.000100` — insert the decimal 6 digits from the end.)

- [ ] **Step 2: Run to verify failure** — `go test ./internal/slackurl/ -v` → FAIL.

- [ ] **Step 3: Implement the parser** (port the regex from slack-mini `ui/src/lib/parseThreadUrl.ts`)

```go
package slackurl

import "regexp"

var threadRe = regexp.MustCompile(`/archives/([A-Z0-9]+)/p(\d+)`)

// Parse extracts channel id + thread_ts from a Slack permalink.
// e.g. .../archives/C0123ABCD/p1699999999000100 -> ("C0123ABCD","1699999999.000100").
func Parse(url string) (channel, threadTS string, ok bool) {
	m := threadRe.FindStringSubmatch(url)
	if m == nil {
		return "", "", false
	}
	raw := m[2] // e.g. 1699999999000100
	if len(raw) <= 6 {
		return "", "", false
	}
	threadTS = raw[:len(raw)-6] + "." + raw[len(raw)-6:]
	return m[1], threadTS, true
}

// ResourceID is the worktree resource ID for a Slack thread.
func ResourceID(channel, threadTS string) string { return channel + ":" + threadTS }
```

- [ ] **Step 4: Run to verify pass** — `go test ./internal/slackurl/ -v` → PASS.

- [ ] **Step 5: Add the Slack-URL branch to cmd/add.go**

In `runAdd`, before the branch-name fallback, add:
```go
if ch, ts, ok := slackurl.Parse(arg); ok {
	return handleSlackURL(arg, ch, ts)
}
```
Implement `handleSlackURL(url, channel, threadTS string) error` (in cmd/add.go or a sibling): resolve the current worktree path (reuse the same resolution `resources` CLI uses — cwd), open the DB (`wdb.Open()`), and `resources.Add(conn, wtPath, resources.Resource{Type: "slack", ID: slackurl.ResourceID(channel, threadTS), URL: url})`. Print a confirmation. (This attaches the thread as a related-or-primary slack resource; default `Related:false` = focus, consistent with pr/jira add.) Import `internal/slackurl`.

- [ ] **Step 6: Add SlackCardBody in ResourceCard.tsx**

In `ui/src/components/ResourceCard.tsx`, add a `type === "slack"` branch rendering a `SlackCardBody` (a compact card: a Slack badge + the thread id linked to `r.url`, and — if available — nothing more this task; rich thread preview is the Slack TAB's job, Task 10). Keep it consistent with `PRCardBody`/`JiraCardBody` styling. `resourceSummary.ts` already labels slack, so the list summary already counts them.

- [ ] **Step 7: Build + test (Go) + frontend build**

Run: `go build ./... && go test ./internal/slackurl/ ./cmd/ -count=1` and `cd ui && npm run build` (tsc + vite).
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add internal/slackurl/ cmd/add.go ui/src/components/ResourceCard.tsx
git commit --signoff -m "feat: Slack threads as worktree resources (add <slack-url>, SlackCardBody)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Frontend test infrastructure (vitest)

**Files:**
- Modify: `ui/package.json` (devDeps + `test` script)
- Create: `ui/vitest.config.ts` (or extend vite config `test`), `ui/src/test-setup.ts`
- Modify: `Makefile` (frontend test target)
- Create: `ui/src/lib/relativeTime.test.ts` (a trivial first test proving the harness runs)

**Interfaces:**
- Produces: `cd ui && npm test` runs vitest (jsdom) green; `make test` includes the frontend tests.

- [ ] **Step 1: Add deps + script**

Add to `ui/package.json` devDependencies: `vitest ^2.1.8`, `@testing-library/react ^16.3.0`, `@testing-library/jest-dom ^6`, `jsdom ^25`, `@testing-library/user-event ^14`. Add script `"test": "vitest run"`. Run `npm install`.

- [ ] **Step 2: Configure vitest (jsdom) + setup**

Create `ui/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], globals: true },
})
```
Create `ui/src/test-setup.ts`: `import "@testing-library/jest-dom"`.
(If tsconfig complains about vitest globals, add `"types": ["vitest/globals", "@testing-library/jest-dom"]` to `ui/tsconfig.json` compilerOptions.)

- [ ] **Step 3: Write a first real test**

Create `ui/src/lib/relativeTime.test.ts` exercising the existing `relativeTime` helper:
```ts
import { describe, it, expect } from "vitest"
import { relativeTime } from "./relativeTime"

describe("relativeTime", () => {
  it("formats a recent timestamp as seconds ago", () => {
    const tenSecAgo = new Date(Date.now() - 10_000).toISOString()
    expect(relativeTime(tenSecAgo)).toMatch(/s ago|second/)
  })
})
```
(Adjust the assertion to `relativeTime`'s actual output format — read `ui/src/lib/relativeTime.ts` first and match its real strings.)

- [ ] **Step 4: Run + wire make**

Run: `cd ui && npm test`
Expected: 1 test passes. Then add to the root `Makefile`'s `test` target: after `go test ./...`, add `cd ui && npm test` (or a `test-web` target that `test` depends on). Keep `make test` green.

- [ ] **Step 5: Commit**

```bash
git add ui/package.json ui/package-lock.json ui/vitest.config.ts ui/src/test-setup.ts ui/tsconfig.json ui/src/lib/relativeTime.test.ts Makefile
git commit --signoff -m "test(ui): add vitest + testing-library frontend test infrastructure

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Port the Slack UI components, hooks, lib (React 19)

**Files:**
- Create: `ui/src/components/slack/*` (TabBar, ThreadView, Message, RichText, Composer, ActionBar, ReactionPill, Attachments, BlockKit, FileAttachments, AddTabModal, EditTabModal, TabDetailsModal) + their ported `*.test.tsx`
- Create: `ui/src/api/slackApi.ts`
- Create: `ui/src/hooks/{useThread,useTabMetas,useNow}.ts` + tests
- Create: `ui/src/lib/{parseThreadUrl,deriveThreadMeta,openThread,reactionToggle,unreadPatch,emoji,renderEmoji,mrkdwn,fallbackTitle}.ts(x)` + tests
- Modify: `ui/package.json` (add `@dnd-kit/*`, `node-emoji`)

**Interfaces:**
- Consumes: the Slack API routes from Task 5 (via `slackApi.ts`).
- Produces: a self-contained set of Slack UI modules that Task 10 mounts. `slackApi.ts` calls the Task-5 routes (note the renamed endpoints: `/api/thread`, `/api/thread/mark-read|mark-unread|reply|react`, `/api/slack-config`, `/api/thread-events`, `/api/slack-avatar|slack-emoji|slack-file`).

- [ ] **Step 1: Add frontend deps**

Add to `ui/package.json` dependencies: `@dnd-kit/core ^6.3.1`, `@dnd-kit/sortable ^10`, `@dnd-kit/utilities ^3.2.2`, `node-emoji ^2.2.0`. `npm install`.

- [ ] **Step 2: Port lib/ + api (rename endpoints, reconcile relativeTime)**

Copy slack-mini `ui/src/lib/{parseThreadUrl,deriveThreadMeta,openThread,reactionToggle,unreadPatch,emoji,renderEmoji,mrkdwn,fallbackTitle}.ts(x)` into worktree `ui/src/lib/`. Copy slack-mini `ui/src/lib/api.ts` → worktree `ui/src/api/slackApi.ts` and update:
- Endpoint paths to the Task-5 renamed routes (`/api/config`→`/api/slack-config`, `/api/events`→`/api/thread-events`, `/api/avatar|emoji|file`→`/api/slack-*`).
- `relativeTime`: worktree already has `ui/src/lib/relativeTime.ts`. Diff the two; if slack-mini's is a superset, replace worktree's (and keep the existing callers working); if they differ meaningfully, keep worktree's and update slack-mini imports to use it. Do NOT create a second `relativeTime`.

- [ ] **Step 3: Port hooks**

Copy `ui/src/hooks/{useThread,useTabMetas,useNow}.ts`. `useThread` opens `EventSource(slackApi.eventsUrl(...))` — ensure it points at `/api/thread-events`.

- [ ] **Step 4: Port components into ui/src/components/slack/**

Copy the ~13 components into `ui/src/components/slack/`. Fix relative imports (they'll now reference `../../api/slackApi`, `../../lib/...`, `../../hooks/...`). These are React 18 components; under React 19 they should compile unchanged (plain hooks, no legacy APIs) — but run tsc to confirm.

- [ ] **Step 5: Port the component/lib tests**

Copy slack-mini's `*.test.tsx`/`*.test.ts` for the moved files into the matching worktree locations. Update import paths. These run under the Task-8 vitest harness.

- [ ] **Step 6: Typecheck, build, test**

Run: `cd ui && npm run build && npm test`
Expected: tsc passes under React 19, vite builds, ported vitest tests pass. Fix any React-19 type friction (e.g. `ReactNode` changes, `useRef` initial-arg requirements) minimally. If a test relies on slack-mini-specific wiring that changed (endpoint names), update it.

- [ ] **Step 7: Commit**

```bash
git add ui/package.json ui/package-lock.json ui/src/api/slackApi.ts ui/src/lib ui/src/hooks ui/src/components/slack
git commit --signoff -m "feat(ui): port slack-mini's Slack thread components/hooks/lib into worktree (React 19)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Slack tab in the worktree detail view (per-worktree, resource-scoped)

**Files:**
- Create: `ui/src/components/SlackTab.tsx` + `ui/src/components/SlackTab.test.tsx`
- Create: `ui/src/hooks/useWorktreeSlackThreads.ts`
- Modify: `ui/src/pages/WorktreeDetailPage.tsx` (wrap in Mantine Tabs)

**Interfaces:**
- Consumes: `api.worktreeResources(path)` (existing) filtered to `type==="slack"`; the ported `ThreadView` + `useThread` (Task 9).
- Produces: a "Slack" tab in the detail view. It lists the worktree's slack resources (each = a thread) and shows the selected thread live via `ThreadView`. NO sessionStorage flat tab bar — the thread list IS the worktree's slack resources.

- [ ] **Step 1: Hook — the worktree's slack threads**

Create `ui/src/hooks/useWorktreeSlackThreads.ts`:
```ts
import { useWorktreeDetail } from "./useWorktreeDetail"

export interface SlackThreadRef { channel: string; threadTs: string; url: string; id: string }

export function useWorktreeSlackThreads(path: string): SlackThreadRef[] {
  const { resources } = useWorktreeDetail(path)
  const slack = (resources.data ?? []).filter((r) => r.type === "slack")
  return slack.map((r) => {
    const [channel, threadTs] = r.id.split(":")
    return { channel, threadTs, url: r.url, id: r.id }
  })
}
```

- [ ] **Step 2: SlackTab component**

Create `ui/src/components/SlackTab.tsx`: given the worktree path, use `useWorktreeSlackThreads(path)`; render a left rail listing threads (reuse `deriveThreadMeta`/`fallbackTitle` for labels; a simple selectable list — the ported `TabBar` is sessionStorage/dnd-oriented and NOT needed here, so use a lightweight Mantine `NavLink` list instead), and on the right the selected thread via the ported `ThreadView` fed by `useThread({channel, threadTs})`. If there are no slack resources, show an empty state ("No Slack threads. Add one with `worktree add <slack-thread-url>`."). If Slack is unconfigured (a thread fetch returns 503), show a "Run `worktree setup` to enable Slack" notice.

- [ ] **Step 3: Wrap the detail page in Tabs**

Modify `ui/src/pages/WorktreeDetailPage.tsx` to render a Mantine `Tabs` with two panels:
- "Overview" — the existing Grid (ResourceList + Timeline), unchanged.
- "Slack" — `<SlackTab path={path} />`.
Keep the header (back link + branch title) above the Tabs. Default active tab = "Overview".

- [ ] **Step 4: Test SlackTab (resource→thread mapping + empty state)**

Create `ui/src/components/SlackTab.test.tsx` using testing-library + a mocked `slackApi`/`useWorktreeDetail`:
- Given a worktree with one slack resource `{type:"slack", id:"C1:1.0", url:"..."}`, SlackTab renders one thread entry.
- Given zero slack resources, renders the empty state text.
(Mock `useWorktreeDetail` to return the resources; mock `slackApi.getThread` to avoid network.)

- [ ] **Step 5: Build + test + real render smoke**

Run: `cd ui && npm run build && npm test`. Then a real smoke: `go build -o bin/worktree . && ./bin/worktree ui --no-open`, open a worktree detail page, click the Slack tab. If you have real Slack creds configured + a slack resource added, confirm a thread renders; otherwise confirm the empty/unconfigured state renders cleanly with no console errors. Use Playwright (read `~/.claude/skills/.context/playwright-mcp.md`). Screenshot wide + narrow (380px) to confirm the tab is responsive. Document what you saw.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/SlackTab.tsx ui/src/components/SlackTab.test.tsx ui/src/hooks/useWorktreeSlackThreads.ts ui/src/pages/WorktreeDetailPage.tsx
git commit --signoff -m "feat(ui): per-worktree Slack tab in the detail view (resource-scoped live threads)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Tests for the pre-existing worktree UI

**Files:**
- Create: `ui/src/lib/resourceSummary.test.ts`, `ui/src/components/ArchivedToggle.test.tsx`, `ui/src/components/WorktreeList.test.tsx`, `ui/src/components/EventRow.test.tsx`

**Interfaces:** none (tests only).

- [ ] **Step 1: Test the pure resourceSummary helper**

`ui/src/lib/resourceSummary.test.ts` — cover the per-type breakdown + related rollup + empty cases (the logic shipped in Phase 2 with no test):
```ts
import { describe, it, expect } from "vitest"
import { resourceSummary } from "./resourceSummary"

describe("resourceSummary", () => {
  it("summarizes focus by type + related rollup", () => {
    expect(resourceSummary({ pr: 2, jira: 3 }, 2)).toBe("2 PRs, 3 Jira issues · 2 related resources")
  })
  it("singular labels", () => {
    expect(resourceSummary({ pr: 1 }, 0)).toBe("1 PR")
    expect(resourceSummary({ jira: 1 }, 1)).toBe("1 Jira issue · 1 related resource")
  })
  it("empty focus shows only related, or nothing", () => {
    expect(resourceSummary({}, 3)).toBe("3 related resources")
    expect(resourceSummary({}, 0)).toBe("")
  })
})
```
(Read `resourceSummary.ts` first and match its exact output/signature — adjust arg shape if it takes an object vs map.)

- [ ] **Step 2: Test ArchivedToggle (exact tooltip)**

`ui/src/components/ArchivedToggle.test.tsx` — render inside `MantineProvider`, assert the switch label "Show archived" and that toggling calls `onChange`. Assert the tooltip text `Show past events for resources no longer being watched by a worktree` is present (query by the tooltip label / title).

- [ ] **Step 3: Test WorktreeList rendering**

`ui/src/components/WorktreeList.test.tsx` — given two `WorktreeSummary` items (one with `on_disk:false`), assert both branches render, the "missing" badge appears for the offline one, and each links to `/worktree/<encoded path>`. Wrap in `MantineProvider` + a wouter `Router` if the links need routing context.

- [ ] **Step 4: Test EventRow rendering**

`ui/src/components/EventRow.test.tsx` — given a `TimelineEvent`, assert the type label badge, title, and (when `showWorktrees`) the worktree badges render; assert a resource_title link points at resource_url.

- [ ] **Step 5: Run + commit**

Run: `cd ui && npm test` (all green, new + ported).
```bash
git add ui/src/lib/resourceSummary.test.ts ui/src/components/ArchivedToggle.test.tsx ui/src/components/WorktreeList.test.tsx ui/src/components/EventRow.test.tsx
git commit --signoff -m "test(ui): cover pre-existing worktree UI (resourceSummary, ArchivedToggle, WorktreeList, EventRow)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Build/deps/docs + archive slack-mini

**Files:**
- Modify: `.claude/CLAUDE.md`, `docs/web-ui-architecture.md`, `README.md`
- (slack-mini repo) archive

**Interfaces:** none (docs + repo admin).

- [ ] **Step 1: Full end-to-end build + test**

Run: `make build && make test` (Go + `cd ui && npm test`). Expected: the single binary embeds the merged UI; all Go + frontend tests green. `ls ui/dist` shows built assets.

- [ ] **Step 2: Manual end-to-end smoke**

`./bin/worktree ui --no-open` against the real DB: home + detail load; Overview tab unchanged; Slack tab renders (thread if creds+resource present, else clean empty/unconfigured state). If you can configure Slack (`worktree setup`, or a pre-seeded auth.yaml) + `worktree add <a-real-slack-thread-url>`, verify a live thread renders with reply + reaction UI. Document what was exercised.

- [ ] **Step 3: Docs**

- `docs/web-ui-architecture.md`: add a "Slack tab" section — the slackapi client, the merged `/api/thread*` + `/api/slack-*` routes, the `internal/slackpoller` (renamed from slack-mini's watcher; NOT the watcher library, NOT worktree's pr/jira poll loop), Slack creds in watcher auth.yaml (v0.2.7 SlackConfig.Cookie), Slack threads as `slack`-type resources, the per-worktree resource-scoped tab. Note Phase 4 will add Slack *timeline* events via the watcher library. Point at `docs/reverse-engineering/slack-web-api.md` for Slack API internals.
- `.claude/CLAUDE.md`: (1) add `slackapi`, `slackpoller`, `slackcreds`, `slackurl` to the internal/ package list; note the Slack tab + `worktree setup` Slack step + that Slack creds live in watcher auth.yaml; note the `internal/slackpoller` naming (slack-mini's concept, renamed) vs the watcher library vs worktree's own pr/jira poller. (2) ADD the Slack reverse-engineering "read and maintain" rule, carried over from slack-mini's CLAUDE.md (verbatim intent):
```
## Reverse-engineering documentation — READ AND MAINTAIN

`docs/reverse-engineering/slack-web-api.md` documents how Slack's (largely
undocumented) Web API behaves — auth, endpoints, payload shapes, quirks — as
verified by direct experimentation. BEFORE working on anything touching the
Slack API (the `slackapi` package, the slackpoller, message rendering, auth),
read that file first. AFTER you learn anything new about how Slack works (a new
field, changed response shape, new endpoint, auth quirk, rate-limit behavior,
block type), update that doc in the same change and add a regression fixture
rather than silently working around it. Treat the doc as part of the deliverable.
```
  (3) ADD a "Slack conventions" section carrying over slack-mini's durable guardrails (adapted for worktree — these are hard-won "don't reinvent" rules future Slack UI work must follow):
```
## Slack conventions (folded in from slack-mini)

- **`slackapi` contains all Slack payload quirks.** It returns domain structs
  (Message, User, Thread, Reaction, File, Attachment, Block/Element, BlockKit),
  never raw Slack JSON. The rest of the codebase never touches raw Slack JSON.
  `normalize.go`'s `normalizeMessage` is the single per-message mapper — new
  message fields go there so thread fetches and posted replies both get them.
- **Rendering pipeline — do NOT reinvent.** Render a message's typed `blocks`
  via `RichText.tsx` (rich_text) — the primary path; never reparse `text`. When
  only an mrkdwn *string* is available (block-less `text` fallback, attachment
  text, Block Kit section/context text), use the SHARED `ui/src/lib/mrkdwn.tsx`
  (`<Mrkdwn>`) — never write a second mrkdwn parser. Block Kit inside attachments
  renders via `BlockKit.tsx` (delegates rich_text back to RichText). Emoji
  resolution is shared via `lib/emoji.ts` + `lib/renderEmoji.tsx`.
- **Never auto-mark threads read.** Only the explicit "Mark thread read" action
  calls `subscriptions.thread.mark` — viewing a thread must not mark it read.
- **Writes are optimistic + rolled back on failure** via `useThread.applyLocal`
  + `refresh()` (replies, mark-unread, reaction toggles). There is no send
  allowlist (dropped in the fold-in) — writes are unrestricted.
- **Slack test fixtures (`internal/slackapi/testdata/`) MUST be synthetic/
  sanitized** — real JSON structure, but NO real Slack content (names, message
  text, links) and NO secrets. Never commit captured real payloads.
- **Slack creds are the user's own session credentials** (xoxc- token + xoxd-
  cookie), stored in `~/.config/watcher/auth.yaml` (0600). Treat like a password;
  never commit. Tokens expire every 1-2 weeks → re-run `worktree setup`.
- **ThreadResponse wire quirk:** top-level keys are camelCase, but the embedded
  `slackapi.Message` + nested structs serialize PascalCase (Go defaults). The
  TS types in `ui/src/api/slackApi.ts` mirror this (e.g. `message.TS`,
  `reaction.UserIDs`); nil slices/pointers marshal to `null` → TS guards them.
```
  Do NOT carry over slack-mini-specifics that changed in the fold-in: the `~/.config/slack-mini/` path, port 8473, `send_allowlist`, or the sessionStorage flat-tab model (replaced by per-worktree resource-scoping).
- `README.md`: add Slack to the Web UI section (Slack tab, `worktree add <slack-url>`, `worktree setup` acquires Slack creds). Include the security note: Slack token+cookie are your own session creds, stored in watcher auth.yaml, never committed.

- [ ] **Step 4: Archive slack-mini**

The slack-mini repo is now folded in. Archive it: (a) add a top-of-README notice in `~/git/slack-mini/README.md` — "ARCHIVED: folded into github.com/mturley/worktree (Phase 3, 2026-08). See worktree's Slack tab." commit + push; (b) archive the GitHub repo via `gh-safe`: run `gh-safe repo archive mturley/slack-mini` (without `--approve` first to check; then `gh-safe --approve repo archive mturley/slack-mini`). NOTE per the user's rules, archiving is a destructive-ish outward action — CONFIRM with the human before running the gh archive command; the README notice + push can proceed, but pause for explicit go-ahead on the actual GitHub archive.

- [ ] **Step 5: Commit (worktree docs)**

```bash
git add .claude/CLAUDE.md docs/web-ui-architecture.md README.md
git commit --signoff -m "docs: document the folded-in Slack tab; note slack-mini archived

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 completion criteria

- watcher v0.2.7 released (SlackConfig gains Cookie + WorkspaceDomain); worktree pins it.
- `internal/slackapi` + `internal/slackpoller` (renamed) + `internal/slackcreds` + `internal/slackurl` live in worktree; no local package named `watcher` or bare `poller`.
- `docs/reverse-engineering/slack-web-api.md` carried over, and its "read and maintain" rule added to worktree's CLAUDE.md.
- The webui server serves Slack routes (`/api/thread*`, `/api/slack-*`) from one binary/port; Slack handlers 503 when unconfigured; no send-allowlist.
- `worktree setup` acquires Slack token+cookie and writes them (+ workspace domain) to `~/.config/watcher/auth.yaml`.
- Slack threads are worktree resources (`worktree add <slack-url>` works; SlackCardBody renders them; list summary counts them).
- The worktree detail view has a "Slack" tab showing live threads (view + reply + reactions + files/unfurls) for that worktree's slack resources, responsive to narrow widths.
- Frontend has vitest infra; slack-mini's Slack tests ported; the pre-existing worktree UI has new tests; `make test` runs Go + frontend green.
- slack-mini repo archived (after human go-ahead).

## Out of scope (later phases)
- Slack *timeline* events / a watcher Slack poller + resource type (Phase 4).
- handler ↔ worktree integration (Phase 5); handler Slack support (Phase 6).
- Reviving slack-mini's flat sessionStorage tab bar or a global (non-worktree) thread list.
