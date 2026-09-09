# Slack Composer Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Slack thread reply composer in `worktree ui` mention users, user groups and `@here`/`@channel`/`@everyone`, plus `:emoji:` and `#channel` autocomplete, posting real mrkdwn mention tokens.

**Architecture:** Three layers. (1) `github.com/mturley/watcher/slack` gains a shared `edgeCall` helper and three search methods against Slack's edge cache. (2) `internal/webui` gains one `/api/slack-autocomplete` endpoint that returns ready-to-insert mrkdwn tokens, behind a TTL + single-flight cache. (3) The composer is rebuilt on Lexical with atomic mention pills, fed by a hybrid lookup that answers instantly from already-loaded thread data and merges server results when they land.

**Tech Stack:** Go 1.22+ (`net/http` `ServeMux` patterns), SQLite-backed worktree DB (untouched here), React 18 + Mantine + Vite + vitest/jsdom, Lexical (`lexical`, `@lexical/react`) as a new UI dependency, `node-emoji` (already present).

**Spec:** `docs/superpowers/specs/2026-09-04-slack-composer-mentions-design.md`

**Reverse-engineering reference (normative for wire formats):** `docs/reverse-engineering/slack-web-api.md`, section "Composer autocomplete — the edge-cache `*/search` endpoints".

## Global Constraints

- **Cross-repo rule.** Tasks 2–6 are in `~/git/watcher` (a DIFFERENT repo). Nothing there may be worked around with a local patch here. After the library work: commit, tag, `git push origin main && git push origin vX.Y.Z`, then `go get github.com/mturley/watcher@vX.Y.Z && go mod tidy` in this repo.
- **Every commit uses `--signoff`** and ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Edi4EjkPcu1s21SvMu1rFy
  ```
- **Never `git add -A` or `git add .`** — add named files only.
- **Slack fixtures must be synthetic.** Real Slack content (names, message text, links) and real tokens are forbidden in `~/git/watcher/slack/testdata/` and anywhere else. Reproduce structure with invented names.
- **Never post to Slack except** to Mike's self-DM `DMFAS8V0X`, and only where a task explicitly says to.
- **No polling.** Every Slack call this feature makes must be caused by a human keystroke.
- **Request budget:** `count: 25` per search, minimum query length 1, ~150ms client debounce, ~60s server TTL cache. These are requirements, not polish — the RE doc records session-token revocation from call bursts.
- Go tests: `go test ./...` in the relevant repo. UI tests: `cd ui && npm test`. Full build: `make build`.
- Don't disable lint rules. If a lint error resists, stop and ask.

---

## File Structure

**In `~/git/watcher` (library):**
- Modify `slack/client.go` — extract `edgeCall`; add `SearchUsers`, `SearchUserGroups`, `SearchChannels`; add the three to the `Client` interface; add `Name` to `User`.
- Modify `slack/types.go` — add `Name` to `User`; add the `Channel` type.
- Modify `slack/client_test.go` — tests for all of the above.
- Create `slack/testdata/users_search.json`, `usergroups_search.json`, `channels_search.json` — synthetic fixtures.

**In this repo (backend):**
- Create `internal/webui/autocomplete.go` — DTO, token builders, label helpers, the handler.
- Create `internal/webui/autocomplete_cache.go` — TTL + single-flight cache.
- Create `internal/webui/autocomplete_test.go`, `internal/webui/autocomplete_cache_test.go`.
- Modify `internal/webui/server.go:117` area — route registration.
- Modify `internal/webui/slack_test.go` — extend `fakeSlack` to satisfy the grown `Client` interface.

**In this repo (frontend):**
- Modify `ui/src/api/slackApi.ts` — `AutocompleteItem` type + `autocomplete()` fetch.
- Create `ui/src/components/slack/composer/tokens.ts` (+ test) — the ONE client-side token builder.
- Create `ui/src/components/slack/composer/detectTrigger.ts` (+ test).
- Create `ui/src/components/slack/composer/MentionNode.tsx` (+ test).
- Create `ui/src/components/slack/composer/candidates.ts` (+ test) — local candidates + merge.
- Create `ui/src/components/slack/composer/useAutocomplete.ts` (+ test).
- Create `ui/src/components/slack/composer/AutocompleteMenu.tsx` (+ test).
- Rewrite `ui/src/components/slack/Composer.tsx` (+ extend `Composer.test.tsx`).
- Modify `ui/src/components/slack/ThreadView.tsx:363` — pass thread context to `Composer`.
- Modify `ui/package.json` — add `lexical`, `@lexical/react`.

**Docs:**
- Modify `docs/web-ui-architecture.md` — new route + DTO in the Slack section.
- Modify `docs/reverse-engineering/slack-web-api.md` — only if implementation discovers something new.

---

### Task 1: Verify that a plain-`text` mention actually notifies

**This task gates the entire plan.** `PostReply` sends `text`; Slack's own client sends `blocks`. If `<@U…>` inside `text` renders as a pill but pings nobody, every later task is built on sand. Nothing else starts until this is answered.

**Files:**
- Create: `~/tmp/verify-mention-encoding/main.go` (OUTSIDE the repo — throwaway, never committed)

**Interfaces:**
- Consumes: the currently pinned `github.com/mturley/watcher/slack` and this repo's `internal/slackcreds`.
- Produces: a yes/no answer recorded in the plan and reported to Mike.

- [ ] **Step 1: Write the throwaway verification program**

```go
// ~/tmp/verify-mention-encoding/main.go
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/mturley/worktree/internal/slackcreds"
)

// Posts ONE message to Mike's self-DM (the only authorised destination) to
// answer a single question: does a mention encoded in plain `text` both
// render as a mention and notify? Throwaway — delete after reading.
func main() {
	c, err := slackcreds.Load()
	if err != nil {
		log.Fatalf("load slack creds: %v", err)
	}
	const selfDM = "DMFAS8V0X"
	const selfUser = "UM21S8ZRR"
	msg, err := c.PostReply(context.Background(), selfDM, "",
		fmt.Sprintf("mention encoding check: <@%s> <!here>", selfUser))
	if err != nil {
		log.Fatalf("post: %v", err)
	}
	fmt.Printf("posted ts=%s text=%q\n", msg.TS, msg.Text)
}
```

Check `internal/slackcreds`'s actual constructor name first (`grep -n "^func " internal/slackcreds/slackcreds.go`) and adjust the call; the package builds a `slack.Client` from `~/.config/watcher/auth.yaml`. If posting with an empty `thread_ts` is rejected, post a root message first and reply to its `ts`.

- [ ] **Step 2: Run it**

Run: `cd ~/tmp/verify-mention-encoding && go mod init verify && go mod edit -replace github.com/mturley/worktree=/Users/mturley/.worktrees/worktree/wt-slack-viewer && go mod tidy && go run .`
Expected: prints a `ts`, no error.

- [ ] **Step 3: Confirm what Slack did with it**

Open the self-DM in the real Slack client and check three things:
1. Does `<@UM21S8ZRR>` render as a blue mention pill (not literal text)?
2. Did it produce a mention notification / red badge?
3. Did `<!here>` render as `@here`?

Ask Mike to confirm the notification — only he can see his own notifications.

- [ ] **Step 4: Record the answer**

If **yes**: add one line under "Risks" in the spec — "Verified 2026-09-XX: `text`-encoded mentions render and notify" — and continue to Task 2.

If **no**: STOP and report to Mike. The fallback (constructing a `rich_text` block with `user`/`usergroup`/`broadcast` elements in `PostReply`) is a watcher-library change that expands this plan, and Mike decides whether to take it.

- [ ] **Step 5: Clean up and commit the spec note**

```bash
rm -rf ~/tmp/verify-mention-encoding
git add docs/superpowers/specs/2026-09-04-slack-composer-mentions-design.md
git commit --signoff -m "docs: record that text-encoded Slack mentions notify"
```

---

### Task 2: Extract `edgeCall` in the watcher library

**Files:**
- Modify: `~/git/watcher/slack/client.go` (`UserGroupsInfo`, currently ~line 374)
- Test: `~/git/watcher/slack/client_test.go`

**Interfaces:**
- Produces: `func (c *HTTPClient) edgeCall(ctx context.Context, path string, payload map[string]any, out any) error` — POSTs `payload` (with `token`/`enterprise_token` injected) as JSON to `{edgeBaseURL}/cache/{teamID}/{path}?_x_app_name=client`, maps `ok:false` errors, and unmarshals the raw body into `out`. Tasks 3–5 all build on it.

- [ ] **Step 1: Write the failing test**

```go
// in ~/git/watcher/slack/client_test.go
func TestEdgeCallMapsAuthErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "auth.test") {
			w.Write([]byte(`{"ok":true,"team_id":"E1","user_id":"U1"}`))
			return
		}
		w.Write([]byte(`{"ok":false,"error":"invalid_auth"}`))
	}))
	defer srv.Close()

	c := NewWithBaseURL("tok", "cookie", srv.URL)
	var out struct{}
	err := c.edgeCall(context.Background(), "users/search", map[string]any{"query": "x"}, &out)
	if !errors.Is(err, ErrAuth) {
		t.Fatalf("want ErrAuth, got %v", err)
	}
}

func TestEdgeCallPostsTokenInBodyAtCachePath(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "auth.test") {
			w.Write([]byte(`{"ok":true,"team_id":"E1","user_id":"U1"}`))
			return
		}
		gotPath = r.URL.Path
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.Write([]byte(`{"ok":true,"results":[]}`))
	}))
	defer srv.Close()

	c := NewWithBaseURL("tok", "cookie", srv.URL)
	var out struct {
		Results []struct{} `json:"results"`
	}
	if err := c.edgeCall(context.Background(), "users/search", map[string]any{"query": "x"}, &out); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/cache/E1/users/search" {
		t.Errorf("path = %q, want /cache/E1/users/search", gotPath)
	}
	if gotBody["token"] != "tok" || gotBody["enterprise_token"] != "tok" {
		t.Errorf("token not injected into body: %v", gotBody)
	}
	if gotBody["query"] != "x" {
		t.Errorf("caller payload lost: %v", gotBody)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ~/git/watcher && go test ./slack/ -run TestEdgeCall -v`
Expected: FAIL — `c.edgeCall undefined`.

- [ ] **Step 3: Implement `edgeCall` and reimplement `UserGroupsInfo` on it**

```go
// edgeCall POSTs payload as JSON to Slack's per-org edge cache and unmarshals
// the response into out. The edge cache is a DIFFERENT host from the Web API,
// speaks JSON rather than form encoding, and takes the session token in the
// BODY rather than a header — see docs/reverse-engineering/slack-web-api.md
// in the worktree repo. Every edge endpoint shares this shape, so it lives
// here once rather than being copied per method.
func (c *HTTPClient) edgeCall(ctx context.Context, path string, payload map[string]any, out any) error {
	teamID, err := c.teamIDOnce(ctx)
	if err != nil {
		return err
	}
	if payload == nil {
		payload = map[string]any{}
	}
	payload["token"] = c.token
	payload["enterprise_token"] = c.token

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/cache/%s/%s?_x_app_name=client", c.edgeBaseURL, teamID, path)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cookie", "d="+c.cookie)

	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	var env struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if !env.OK {
		switch env.Error {
		case "invalid_auth", "token_expired", "not_authed":
			return fmt.Errorf("%w: %s", ErrAuth, env.Error)
		default:
			return fmt.Errorf("slack edge error: %s", env.Error)
		}
	}
	return json.Unmarshal(raw, out)
}
```

Then replace the body of `UserGroupsInfo` with:

```go
func (c *HTTPClient) UserGroupsInfo(ctx context.Context, ids []string) (map[string]UserGroup, error) {
	out := make(map[string]UserGroup, len(ids))
	if len(ids) == 0 {
		return out, nil // nothing to resolve; do not make a pointless request
	}
	var r struct {
		Results []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Handle string `json:"handle"`
		} `json:"results"`
	}
	if err := c.edgeCall(ctx, "usergroups/info", map[string]any{"ids": ids}, &r); err != nil {
		return nil, err
	}
	for _, g := range r.Results {
		out[g.ID] = UserGroup{ID: g.ID, Name: g.Name, Handle: g.Handle}
	}
	return out, nil
}
```

- [ ] **Step 4: Run the whole slack package**

Run: `cd ~/git/watcher && go test ./slack/ -v`
Expected: PASS, including the pre-existing `UserGroupsInfo` tests — the refactor must not change its behaviour.

- [ ] **Step 5: Commit**

```bash
cd ~/git/watcher
git add slack/client.go slack/client_test.go
git commit --signoff -m "refactor(slack): extract shared edgeCall helper for edge-cache endpoints"
```

---

### Task 3: `SearchUsers`

**Files:**
- Modify: `~/git/watcher/slack/types.go` (add `Name` to `User`)
- Modify: `~/git/watcher/slack/client.go`
- Create: `~/git/watcher/slack/testdata/users_search.json`
- Test: `~/git/watcher/slack/client_test.go`

**Interfaces:**
- Consumes: `edgeCall` (Task 2).
- Produces: `func (c *HTTPClient) SearchUsers(ctx context.Context, query, currentChannel string, limit int) ([]User, error)`, and `User` gains `Name string` (the Slack handle, e.g. `mturley`).

- [ ] **Step 1: Write the synthetic fixture**

```json
// ~/git/watcher/slack/testdata/users_search.json
{"ok":true,"results":[
 {"id":"U100","name":"aroberts","deleted":false,"is_bot":false,"real_name":"Ada Roberts",
  "profile":{"display_name":"ada","real_name":"Ada Roberts",
             "image_72":"https://example.invalid/ada_72.png"}},
 {"id":"U200","name":"brobson","deleted":false,"is_bot":false,"real_name":"Ben Robson",
  "profile":{"display_name":"","real_name":"Ben Robson",
             "image_72":"https://example.invalid/ben_72.png"}},
 {"id":"U300","name":"crobin","deleted":true,"is_bot":false,"real_name":"Cara Robin",
  "profile":{"display_name":"cara","real_name":"Cara Robin","image_72":""}}
]}
```

(Invented names only — the Global Constraints forbid real Slack content.)

- [ ] **Step 2: Write the failing test**

```go
func TestSearchUsers(t *testing.T) {
	fixture, err := os.ReadFile("testdata/users_search.json")
	if err != nil {
		t.Fatal(err)
	}
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "auth.test") {
			w.Write([]byte(`{"ok":true,"team_id":"E1","user_id":"U1"}`))
			return
		}
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.Write(fixture)
	}))
	defer srv.Close()

	c := NewWithBaseURL("tok", "cookie", srv.URL)
	users, err := c.SearchUsers(context.Background(), "rob", "C1", 25)
	if err != nil {
		t.Fatal(err)
	}

	// Deleted users are filtered in the library so no consumer has to remember.
	if len(users) != 2 {
		t.Fatalf("got %d users, want 2 (deleted filtered): %+v", len(users), users)
	}
	if users[0].ID != "U100" || users[0].Name != "aroberts" || users[0].DisplayName != "ada" {
		t.Errorf("first user mapped wrong: %+v", users[0])
	}
	if users[0].Avatar72 != "https://example.invalid/ada_72.png" {
		t.Errorf("avatar not mapped: %+v", users[0])
	}

	// The ranking/fuzz parameters Slack's own client sends must be present.
	for _, k := range []string{"fuzz", "include_profile_only_users", "enable_workspace_ranking"} {
		if _, ok := gotBody[k]; !ok {
			t.Errorf("payload missing %q: %v", k, gotBody)
		}
	}
	if gotBody["query"] != "rob" || gotBody["current_channel"] != "C1" || gotBody["count"] != float64(25) {
		t.Errorf("payload wrong: %v", gotBody)
	}
}

func TestSearchUsersEmptyQueryMakesNoCall(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request to %s", r.URL.Path)
	}))
	defer srv.Close()

	c := NewWithBaseURL("tok", "cookie", srv.URL)
	users, err := c.SearchUsers(context.Background(), "   ", "C1", 25)
	if err != nil || len(users) != 0 {
		t.Fatalf("got %v, %v; want no users and no error", users, err)
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ~/git/watcher && go test ./slack/ -run TestSearchUsers -v`
Expected: FAIL — `c.SearchUsers undefined`.

- [ ] **Step 4: Implement**

In `types.go`, add the handle to `User` (additive; `Users()` should fill it too so both paths agree):

```go
type User struct {
	ID          string
	Name        string // Slack handle, e.g. "aroberts"
	RealName    string
	DisplayName string
	Avatar72    string
}
```

In `Users()` (the `users.info` path), decode `name` into the same field:

```go
		var r struct {
			User struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				RealName string `json:"real_name"`
				Profile  struct {
					DisplayName        string `json:"display_name"`
					Image72            string `json:"image_72"`
					RealNameNormalized string `json:"real_name_normalized"`
				} `json:"profile"`
			} `json:"user"`
		}
```

…and set `Name: r.User.Name` in the returned `User` (leave the existing graceful-fallback branch as it is).

In `client.go`, add:

```go
// SearchUsers finds users by fuzzy substring across the org, the way Slack's
// own composer does. currentChannel is a RANKING HINT, not a filter — results
// are org-wide. Deleted users are filtered here so no consumer can offer a
// mention of a departed account.
func (c *HTTPClient) SearchUsers(ctx context.Context, query, currentChannel string, limit int) ([]User, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil // a bare trigger must not cost a Slack call
	}
	if limit <= 0 {
		limit = 25
	}
	var r struct {
		Results []struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			RealName string `json:"real_name"`
			Deleted  bool   `json:"deleted"`
			Profile  struct {
				DisplayName string `json:"display_name"`
				Image72     string `json:"image_72"`
			} `json:"profile"`
		} `json:"results"`
	}
	payload := map[string]any{
		"query":                      query,
		"count":                      limit,
		"fuzz":                       1,
		"include_profile_only_users": true,
		"enable_workspace_ranking":   true,
		"top_users":                  []string{},
		"current_channel":            currentChannel,
	}
	if err := c.edgeCall(ctx, "users/search", payload, &r); err != nil {
		return nil, err
	}
	out := make([]User, 0, len(r.Results))
	for _, u := range r.Results {
		if u.Deleted {
			continue
		}
		out = append(out, User{
			ID:          u.ID,
			Name:        u.Name,
			RealName:    u.RealName,
			DisplayName: u.Profile.DisplayName,
			Avatar72:    u.Profile.Image72,
		})
	}
	return out, nil
}
```

Bots and app users are deliberately NOT filtered — they are mentionable in Slack.

- [ ] **Step 5: Run tests**

Run: `cd ~/git/watcher && go test ./... `
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/git/watcher
git add slack/types.go slack/client.go slack/client_test.go slack/testdata/users_search.json
git commit --signoff -m "feat(slack): add SearchUsers over the edge-cache users/search endpoint"
```

---

### Task 4: `SearchUserGroups`

**Files:**
- Modify: `~/git/watcher/slack/client.go`
- Create: `~/git/watcher/slack/testdata/usergroups_search.json`
- Test: `~/git/watcher/slack/client_test.go`

**Interfaces:**
- Consumes: `edgeCall` (Task 2).
- Produces: `func (c *HTTPClient) SearchUserGroups(ctx context.Context, query string, limit int) ([]UserGroup, error)`.

- [ ] **Step 1: Write the synthetic fixture**

```json
// ~/git/watcher/slack/testdata/usergroups_search.json
{"ok":true,"results":[
 {"id":"S100","handle":"platform-team","name":"Platform Team",
  "description":"Owns the build system","date_delete":0},
 {"id":"S200","handle":"old-guild","name":"Retired Guild",
  "description":"Disbanded","date_delete":1780000000}
]}
```

- [ ] **Step 2: Write the failing test**

```go
func TestSearchUserGroupsFiltersDeleted(t *testing.T) {
	fixture, err := os.ReadFile("testdata/usergroups_search.json")
	if err != nil {
		t.Fatal(err)
	}
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "auth.test") {
			w.Write([]byte(`{"ok":true,"team_id":"E1","user_id":"U1"}`))
			return
		}
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.Write(fixture)
	}))
	defer srv.Close()

	c := NewWithBaseURL("tok", "cookie", srv.URL)
	groups, err := c.SearchUserGroups(context.Background(), "team", 25)
	if err != nil {
		t.Fatal(err)
	}
	// usergroups/search returns DELETED groups (date_delete != 0). Offering
	// one as a mention would be a dead ping.
	if len(groups) != 1 || groups[0].ID != "S100" {
		t.Fatalf("got %+v, want only S100", groups)
	}
	if groups[0].Handle != "platform-team" || groups[0].Name != "Platform Team" {
		t.Errorf("mapped wrong: %+v", groups[0])
	}
	if gotBody["org_wide"] != true {
		t.Errorf("org_wide not sent: %v", gotBody)
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ~/git/watcher && go test ./slack/ -run TestSearchUserGroups -v`
Expected: FAIL — `c.SearchUserGroups undefined`.

- [ ] **Step 4: Implement**

```go
// SearchUserGroups finds user groups by fuzzy match on name AND description.
// Slack returns deleted groups from this endpoint; they are filtered here.
func (c *HTTPClient) SearchUserGroups(ctx context.Context, query string, limit int) ([]UserGroup, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 25
	}
	var r struct {
		Results []struct {
			ID         string `json:"id"`
			Handle     string `json:"handle"`
			Name       string `json:"name"`
			DateDelete int64  `json:"date_delete"`
		} `json:"results"`
	}
	payload := map[string]any{"query": query, "count": limit, "org_wide": true}
	if err := c.edgeCall(ctx, "usergroups/search", payload, &r); err != nil {
		return nil, err
	}
	out := make([]UserGroup, 0, len(r.Results))
	for _, g := range r.Results {
		if g.DateDelete != 0 {
			continue
		}
		out = append(out, UserGroup{ID: g.ID, Name: g.Name, Handle: g.Handle})
	}
	return out, nil
}
```

- [ ] **Step 5: Run tests**

Run: `cd ~/git/watcher && go test ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/git/watcher
git add slack/client.go slack/client_test.go slack/testdata/usergroups_search.json
git commit --signoff -m "feat(slack): add SearchUserGroups, filtering deleted groups"
```

---

### Task 5: `SearchChannels` + `Channel` type + `Client` interface

**Files:**
- Modify: `~/git/watcher/slack/types.go`
- Modify: `~/git/watcher/slack/client.go`
- Create: `~/git/watcher/slack/testdata/channels_search.json`
- Test: `~/git/watcher/slack/client_test.go`

**Interfaces:**
- Consumes: `edgeCall` (Task 2).
- Produces: `type Channel struct { ID, Name string; IsPrivate, IsArchived bool }`, `func (c *HTTPClient) SearchChannels(ctx context.Context, query string, limit int) ([]Channel, error)`, and the `Client` interface grows all three search methods.

- [ ] **Step 1: Write the synthetic fixture**

```json
// ~/git/watcher/slack/testdata/channels_search.json
{"ok":true,"results":[
 {"id":"C100","name":"build-tools","is_private":false,"is_archived":false},
 {"id":"C200","name":"build-tools-private","is_private":true,"is_archived":false},
 {"id":"C300","name":"build-tools-2019","is_private":false,"is_archived":true}
]}
```

- [ ] **Step 2: Write the failing test**

```go
func TestSearchChannelsFiltersArchivedAndKeepsPrivate(t *testing.T) {
	fixture, err := os.ReadFile("testdata/channels_search.json")
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "auth.test") {
			w.Write([]byte(`{"ok":true,"team_id":"E1","user_id":"U1"}`))
			return
		}
		w.Write(fixture)
	}))
	defer srv.Close()

	c := NewWithBaseURL("tok", "cookie", srv.URL)
	chans, err := c.SearchChannels(context.Background(), "build", 25)
	if err != nil {
		t.Fatal(err)
	}
	if len(chans) != 2 {
		t.Fatalf("got %+v, want 2 (archived filtered, private kept)", chans)
	}
	if chans[0].ID != "C100" || chans[0].Name != "build-tools" || chans[0].IsPrivate {
		t.Errorf("first channel mapped wrong: %+v", chans[0])
	}
	if !chans[1].IsPrivate {
		t.Errorf("private channel should be kept and flagged: %+v", chans[1])
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ~/git/watcher && go test ./slack/ -run TestSearchChannels -v`
Expected: FAIL — `undefined: Channel` / `c.SearchChannels undefined`.

- [ ] **Step 4: Implement**

In `types.go`:

```go
// Channel is the minimal view of a conversation needed to offer a
// "#channel" mention. channels/search returns a full conversation object;
// four fields is all any consumer here needs, so the rest is dropped.
type Channel struct {
	ID         string
	Name       string
	IsPrivate  bool
	IsArchived bool
}
```

In `client.go`:

```go
// SearchChannels finds channels by fuzzy name match. Private channels the
// user belongs to ARE included (flagged via IsPrivate); archived channels are
// filtered, since mentioning one is a dead link.
func (c *HTTPClient) SearchChannels(ctx context.Context, query string, limit int) ([]Channel, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 25
	}
	var r struct {
		Results []struct {
			ID         string `json:"id"`
			Name       string `json:"name"`
			IsPrivate  bool   `json:"is_private"`
			IsArchived bool   `json:"is_archived"`
		} `json:"results"`
	}
	// top_channels is only a client-side ranking hint and is deliberately
	// omitted; check_membership/include_record_channels mirror what Slack's
	// own client sends.
	payload := map[string]any{
		"query": query, "count": limit, "fuzz": 1,
		"check_membership":        true,
		"include_record_channels": true,
	}
	if err := c.edgeCall(ctx, "channels/search", payload, &r); err != nil {
		return nil, err
	}
	out := make([]Channel, 0, len(r.Results))
	for _, ch := range r.Results {
		if ch.IsArchived {
			continue
		}
		out = append(out, Channel{ID: ch.ID, Name: ch.Name, IsPrivate: ch.IsPrivate, IsArchived: false})
	}
	return out, nil
}
```

Add to the `Client` interface (after `UserGroupsInfo`):

```go
	SearchUsers(ctx context.Context, query, currentChannel string, limit int) ([]User, error)
	SearchUserGroups(ctx context.Context, query string, limit int) ([]UserGroup, error)
	SearchChannels(ctx context.Context, query string, limit int) ([]Channel, error)
```

**Note for the implementer:** growing `Client` is a breaking change for every other implementer of the interface — including `agent-handler`, the library's other consumer, whenever it next re-pins. That is acceptable (it re-pins deliberately), but mention it in the release notes for the tag in Task 6.

- [ ] **Step 5: Run tests**

Run: `cd ~/git/watcher && go test ./...`
Expected: PASS. If any in-repo fake implements `Client`, extend it with the three new methods returning `nil, nil`.

- [ ] **Step 6: Commit**

```bash
cd ~/git/watcher
git add slack/types.go slack/client.go slack/client_test.go slack/testdata/channels_search.json
git commit --signoff -m "feat(slack): add SearchChannels and expose the search methods on Client"
```

---

### Task 6: Release the library and re-pin worktree

**Files:**
- Modify: `go.mod`, `go.sum` (this repo)
- Modify: `internal/webui/slack_test.go` (extend `fakeSlack`)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: a worktree build that compiles against the new library, and a `fakeSlack` with settable search results that Tasks 7–9's tests drive.

- [ ] **Step 1: Tag and push the library**

```bash
cd ~/git/watcher
go test ./...
git tag v0.2.8   # or the next unused patch version — check `git tag | sort -V | tail -3`
git push origin main
git push origin v0.2.8
```

- [ ] **Step 2: Re-pin in this repo**

```bash
cd /Users/mturley/.worktrees/worktree/wt-slack-viewer
go get github.com/mturley/watcher@v0.2.8
go mod tidy
```

- [ ] **Step 3: Run tests to see the interface break**

Run: `go build ./...`
Expected: FAIL — `*fakeSlack does not implement slack.Client (missing method SearchUsers)`.

- [ ] **Step 4: Extend `fakeSlack`**

```go
// in internal/webui/slack_test.go, added to the fakeSlack struct:
	searchUsers      []slack.User
	searchUserGroups []slack.UserGroup
	searchChannels   []slack.Channel
	searchErr        error
	searchQueries    []string // records each query, for asserting call counts

func (f *fakeSlack) SearchUsers(ctx context.Context, query, currentChannel string, limit int) ([]slack.User, error) {
	f.searchQueries = append(f.searchQueries, "users:"+query)
	return f.searchUsers, f.searchErr
}

func (f *fakeSlack) SearchUserGroups(ctx context.Context, query string, limit int) ([]slack.UserGroup, error) {
	f.searchQueries = append(f.searchQueries, "groups:"+query)
	return f.searchUserGroups, f.searchErr
}

func (f *fakeSlack) SearchChannels(ctx context.Context, query string, limit int) ([]slack.Channel, error) {
	f.searchQueries = append(f.searchQueries, "channels:"+query)
	return f.searchChannels, f.searchErr
}
```

Note: the `@` handler queries users and groups **concurrently**, so `searchQueries` is written from two goroutines. Guard it with a `sync.Mutex` on the fake, or the race detector will flag it in Task 7.

- [ ] **Step 5: Verify**

Run: `go build ./... && go test ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/webui/slack_test.go
git commit --signoff -m "chore: re-pin watcher v0.2.8 for Slack search methods"
```

---

### Task 7: Token builders and the autocomplete DTO

**Files:**
- Create: `internal/webui/autocomplete.go`
- Test: `internal/webui/autocomplete_test.go`

**Interfaces:**
- Produces: `AutocompleteItem` (the wire DTO), `userToken/groupToken/specialToken/channelToken/emojiToken`, `userLabel`, and `specialItems(query string) []AutocompleteItem`. Task 8's handler and Task 14's frontend both depend on these exact field names.

- [ ] **Step 1: Write the failing test**

```go
package webui

import (
	"reflect"
	"testing"

	"github.com/mturley/watcher/slack"
)

func TestTokenBuilders(t *testing.T) {
	tests := []struct {
		name string
		got  string
		want string
	}{
		{"user", userToken("U123"), "<@U123>"},
		{"group", groupToken("S123"), "<!subteam^S123>"},
		{"special here", specialToken("here"), "<!here>"},
		{"special channel", specialToken("channel"), "<!channel>"},
		{"channel", channelToken("C123", "odh-dashboard"), "<#C123|odh-dashboard>"},
		{"emoji", emojiToken("tada"), ":tada:"},
	}
	for _, tt := range tests {
		if tt.got != tt.want {
			t.Errorf("%s: got %q, want %q", tt.name, tt.got, tt.want)
		}
	}
}

func TestUserLabelPrefersDisplayNameThenRealNameThenHandle(t *testing.T) {
	tests := []struct {
		user slack.User
		want string
	}{
		{slack.User{ID: "U1", DisplayName: "ada", RealName: "Ada Roberts", Name: "aroberts"}, "ada"},
		{slack.User{ID: "U1", DisplayName: "", RealName: "Ada Roberts", Name: "aroberts"}, "Ada Roberts"},
		{slack.User{ID: "U1", DisplayName: "", RealName: "", Name: "aroberts"}, "aroberts"},
		{slack.User{ID: "U1"}, "U1"}, // never blank: an unlabelled row is unpickable
	}
	for _, tt := range tests {
		if got := userLabel(tt.user); got != tt.want {
			t.Errorf("userLabel(%+v) = %q, want %q", tt.user, got, tt.want)
		}
	}
}

func TestSpecialItemsFilterByQuery(t *testing.T) {
	all := specialItems("")
	if len(all) != 3 {
		t.Fatalf("got %d specials, want 3 (@here, @channel, @everyone)", len(all))
	}
	got := specialItems("her")
	want := []AutocompleteItem{{
		Kind:   "special",
		ID:     "here",
		Label:  "@here",
		Detail: "Notify everyone online in this channel",
		Token:  "<!here>",
	}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("specialItems(\"her\") = %+v, want %+v", got, want)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/webui/ -run 'TestTokenBuilders|TestUserLabel|TestSpecialItems' -v`
Expected: FAIL — undefined identifiers.

- [ ] **Step 3: Implement**

```go
package webui

import (
	"strings"

	"github.com/mturley/watcher/slack"
)

// AutocompleteItem is one candidate returned by GET /api/slack-autocomplete.
//
// Token is the load-bearing field: it is the EXACT mrkdwn the composer should
// insert. Mention encoding therefore lives in one Go place with table tests,
// and the pill the user sees cannot disagree with the text that gets posted.
type AutocompleteItem struct {
	// Kind is one of "user", "group", "special", "channel", "emoji".
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Label    string `json:"label"`
	Detail   string `json:"detail,omitempty"`
	Avatar   string `json:"avatar,omitempty"`
	ImageURL string `json:"imageUrl,omitempty"`
	Token    string `json:"token"`
}

func userToken(id string) string    { return "<@" + id + ">" }
func groupToken(id string) string   { return "<!subteam^" + id + ">" }
func specialToken(name string) string { return "<!" + name + ">" }
func emojiToken(name string) string { return ":" + name + ":" }

func channelToken(id, name string) string { return "<#" + id + "|" + name + ">" }

// userLabel picks what Slack itself shows, in Slack's own precedence order.
// It never returns "" — a row with no label is a row the user cannot identify.
func userLabel(u slack.User) string {
	switch {
	case u.DisplayName != "":
		return u.DisplayName
	case u.RealName != "":
		return u.RealName
	case u.Name != "":
		return u.Name
	default:
		return u.ID
	}
}

// specials are injected locally, exactly as Slack's own client does — no
// endpoint returns them.
var specials = []struct{ id, detail string }{
	{"here", "Notify everyone online in this channel"},
	{"channel", "Notify everyone in this channel"},
	{"everyone", "Notify everyone in the workspace"},
}

func specialItems(query string) []AutocompleteItem {
	q := strings.ToLower(query)
	out := []AutocompleteItem{}
	for _, s := range specials {
		if q != "" && !strings.Contains(s.id, q) {
			continue
		}
		out = append(out, AutocompleteItem{
			Kind:   "special",
			ID:     s.id,
			Label:  "@" + s.id,
			Detail: s.detail,
			Token:  specialToken(s.id),
		})
	}
	return out
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/webui/ -run 'TestTokenBuilders|TestUserLabel|TestSpecialItems' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/autocomplete.go internal/webui/autocomplete_test.go
git commit --signoff -m "feat(webui): add autocomplete DTO and mrkdwn token builders"
```

---

### Task 8: TTL + single-flight cache

**Files:**
- Create: `internal/webui/autocomplete_cache.go`
- Test: `internal/webui/autocomplete_cache_test.go`

**Interfaces:**
- Consumes: `AutocompleteItem` (Task 7).
- Produces: `newAutocompleteCache(ttl time.Duration) *autocompleteCache` and `(*autocompleteCache).Do(key string, fn func() ([]AutocompleteItem, error)) ([]AutocompleteItem, error)`. Task 9's handler wraps every Slack-backed lookup in it.

- [ ] **Step 1: Write the failing test**

```go
package webui

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCacheServesWithinTTLAndReexpires(t *testing.T) {
	var calls int32
	c := newAutocompleteCache(time.Minute)
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }

	fn := func() ([]AutocompleteItem, error) {
		atomic.AddInt32(&calls, 1)
		return []AutocompleteItem{{Kind: "user", ID: "U1"}}, nil
	}

	if _, err := c.Do("k", fn); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Do("k", fn); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("fn called %d times within TTL, want 1", got)
	}

	now = now.Add(2 * time.Minute)
	if _, err := c.Do("k", fn); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("fn called %d times after TTL, want 2", got)
	}
}

func TestCacheSingleFlightsConcurrentIdenticalQueries(t *testing.T) {
	var calls int32
	release := make(chan struct{})
	c := newAutocompleteCache(time.Minute)

	fn := func() ([]AutocompleteItem, error) {
		atomic.AddInt32(&calls, 1)
		<-release // hold the call open so both goroutines are in flight
		return []AutocompleteItem{{Kind: "user", ID: "U1"}}, nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Do("k", fn); err != nil {
				t.Errorf("Do: %v", err)
			}
		}()
	}
	time.Sleep(20 * time.Millisecond) // let both reach the cache
	close(release)
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("fn called %d times concurrently, want 1", got)
	}
}

func TestCacheDoesNotCacheErrors(t *testing.T) {
	var calls int32
	c := newAutocompleteCache(time.Minute)
	fn := func() ([]AutocompleteItem, error) {
		atomic.AddInt32(&calls, 1)
		return nil, errTest
	}
	c.Do("k", fn)
	c.Do("k", fn)
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Fatalf("fn called %d times, want 2 — a failed lookup must not be cached", got)
	}
}

var errTest = errorString("boom")

type errorString string

func (e errorString) Error() string { return string(e) }
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/webui/ -run TestCache -v`
Expected: FAIL — `newAutocompleteCache undefined`.

- [ ] **Step 3: Implement**

```go
package webui

import (
	"sync"
	"time"
)

// autocompleteCache is a small TTL cache with single-flight, sitting in front
// of every Slack-backed autocomplete lookup.
//
// This is a REQUIREMENT, not an optimisation: autocomplete is driven by
// keystrokes, and docs/reverse-engineering/slack-web-api.md records that
// bursts of calls got the user's session token revoked. Repeated prefixes and
// two panes open on the same thread must not multiply Slack traffic.
//
// Errors are deliberately not cached — a transient failure should not blank
// the menu for a minute.
type autocompleteCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	now     func() time.Time // swappable in tests
	entries map[string]autocompleteEntry
	calls   map[string]*autocompleteCall
}

type autocompleteEntry struct {
	items   []AutocompleteItem
	expires time.Time
}

type autocompleteCall struct {
	done  chan struct{}
	items []AutocompleteItem
	err   error
}

func newAutocompleteCache(ttl time.Duration) *autocompleteCache {
	return &autocompleteCache{
		ttl:     ttl,
		now:     time.Now,
		entries: map[string]autocompleteEntry{},
		calls:   map[string]*autocompleteCall{},
	}
}

// Do returns the cached items for key, or runs fn once — even if several
// callers ask concurrently — and caches a successful result for the TTL.
func (c *autocompleteCache) Do(key string, fn func() ([]AutocompleteItem, error)) ([]AutocompleteItem, error) {
	c.mu.Lock()
	if e, ok := c.entries[key]; ok && c.now().Before(e.expires) {
		c.mu.Unlock()
		return e.items, nil
	}
	if call, ok := c.calls[key]; ok {
		c.mu.Unlock()
		<-call.done
		return call.items, call.err
	}
	call := &autocompleteCall{done: make(chan struct{})}
	c.calls[key] = call
	c.mu.Unlock()

	call.items, call.err = fn()

	c.mu.Lock()
	delete(c.calls, key)
	if call.err == nil {
		c.entries[key] = autocompleteEntry{items: call.items, expires: c.now().Add(c.ttl)}
	}
	c.mu.Unlock()

	close(call.done)
	return call.items, call.err
}
```

- [ ] **Step 4: Run tests, including the race detector**

Run: `go test ./internal/webui/ -run TestCache -race -v`
Expected: PASS, no race reports.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/autocomplete_cache.go internal/webui/autocomplete_cache_test.go
git commit --signoff -m "feat(webui): add TTL + single-flight cache for autocomplete lookups"
```

---

### Task 9: The `/api/slack-autocomplete` handler

**Files:**
- Modify: `internal/webui/autocomplete.go`
- Modify: `internal/webui/server.go` (route registration, near line 117)
- Test: `internal/webui/autocomplete_test.go`

**Interfaces:**
- Consumes: `AutocompleteItem`, token builders, `userLabel`, `specialItems` (Task 7); `autocompleteCache` (Task 8); `SearchUsers`/`SearchUserGroups`/`SearchChannels` (Tasks 3–5); the server's existing `emoji(ctx)` cache (`internal/webui/slack.go:159`) and `slackUnavailable`.
- Produces: `GET /api/slack-autocomplete?trigger=&q=&channel=` returning `{"results":[…]}`.

- [ ] **Step 1: Write the failing tests**

```go
func TestAutocompleteRejectsUnknownTrigger(t *testing.T) {
	s := newTestServer(t, &fakeSlack{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%21&q=x", nil)
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", rec.Code)
	}
}

func TestAutocompleteMentionsMergesUsersGroupsAndSpecials(t *testing.T) {
	fs := &fakeSlack{
		searchUsers:      []slack.User{{ID: "U1", Name: "aroberts", DisplayName: "ada", Avatar72: "https://a/72.png"}},
		searchUserGroups: []slack.UserGroup{{ID: "S1", Handle: "platform", Name: "Platform Team"}},
	}
	s := newTestServer(t, fs)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%40&q=her&channel=C1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d: %s", rec.Code, rec.Body)
	}
	var got struct{ Results []AutocompleteItem }
	json.NewDecoder(rec.Body).Decode(&got)

	kinds := map[string]AutocompleteItem{}
	for _, it := range got.Results {
		kinds[it.Kind] = it
	}
	if kinds["user"].Token != "<@U1>" || kinds["user"].Label != "ada" || kinds["user"].Detail != "aroberts" {
		t.Errorf("user item wrong: %+v", kinds["user"])
	}
	if kinds["group"].Token != "<!subteam^S1>" || kinds["group"].Label != "@platform" {
		t.Errorf("group item wrong: %+v", kinds["group"])
	}
	if kinds["special"].Token != "<!here>" {
		t.Errorf("special item wrong: %+v", kinds["special"])
	}
	// Ranking: users before groups before specials.
	if got.Results[0].Kind != "user" || got.Results[len(got.Results)-1].Kind != "special" {
		t.Errorf("ranking wrong: %+v", got.Results)
	}
}

func TestAutocompleteBareTriggerMakesNoSlackCall(t *testing.T) {
	fs := &fakeSlack{}
	s := newTestServer(t, fs)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%40&q=", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	if len(fs.searchQueries) != 0 {
		t.Errorf("bare trigger hit Slack: %v", fs.searchQueries)
	}
	var got struct{ Results []AutocompleteItem }
	json.NewDecoder(rec.Body).Decode(&got)
	if len(got.Results) != 3 {
		t.Errorf("want the 3 specials, got %+v", got.Results)
	}
}

func TestAutocompleteEmojiFiltersCachedMapWithoutSlackSearch(t *testing.T) {
	fs := &fakeSlack{emoji: map[string]string{
		"tada":       "https://e/tada.png",
		"tadpole":    "https://e/tadpole.png",
		"thumbsup":   "https://e/thumbsup.png",
	}}
	s := newTestServer(t, fs)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%3A&q=tad", nil))
	var got struct{ Results []AutocompleteItem }
	json.NewDecoder(rec.Body).Decode(&got)
	if len(got.Results) != 2 {
		t.Fatalf("got %+v, want tada and tadpole", got.Results)
	}
	if got.Results[0].Token != ":tada:" || got.Results[0].ImageURL != "https://e/tada.png" {
		t.Errorf("emoji item wrong: %+v", got.Results[0])
	}
}

func TestAutocompleteChannels(t *testing.T) {
	fs := &fakeSlack{searchChannels: []slack.Channel{{ID: "C1", Name: "odh-dashboard"}}}
	s := newTestServer(t, fs)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%23&q=odh", nil))
	var got struct{ Results []AutocompleteItem }
	json.NewDecoder(rec.Body).Decode(&got)
	if len(got.Results) != 1 || got.Results[0].Token != "<#C1|odh-dashboard>" || got.Results[0].Label != "#odh-dashboard" {
		t.Fatalf("channel item wrong: %+v", got.Results)
	}
}

func TestAutocompleteSurfacesSlackErrors(t *testing.T) {
	fs := &fakeSlack{searchErr: errors.New("boom")}
	s := newTestServer(t, fs)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/slack-autocomplete?trigger=%40&q=ada", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d, want 502 — the UI degrades to local results on error", rec.Code)
	}
}
```

Use whatever server-construction helper the existing `internal/webui` tests use (check `slack_test.go` / `server_test.go` for the exact spelling of `newTestServer` and `Handler()`; match it rather than inventing one). If `fakeSlack` has no `emoji` field yet, it does — see `slack_test.go:58`.

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./internal/webui/ -run TestAutocomplete -v`
Expected: FAIL — 404s from the unregistered route.

- [ ] **Step 3: Implement the handler**

Append to `internal/webui/autocomplete.go`:

```go
// handleSlackAutocomplete implements GET /api/slack-autocomplete, the single
// endpoint behind all three composer triggers.
//
// Every result carries a ready-to-insert mrkdwn Token, so the frontend never
// constructs mention syntax from ids.
func (s *Server) handleSlackAutocomplete(w http.ResponseWriter, r *http.Request) {
	if s.SlackClient == nil {
		s.slackUnavailable(w)
		return
	}
	trigger := r.URL.Query().Get("trigger")
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	channel := r.URL.Query().Get("channel")

	var (
		items []AutocompleteItem
		err   error
	)
	switch trigger {
	case "@":
		items, err = s.mentionCandidates(r.Context(), q, channel)
	case "#":
		items, err = s.channelCandidates(r.Context(), q)
	case ":":
		items, err = s.emojiCandidates(r.Context(), q)
	default:
		writeError(w, http.StatusBadRequest, "trigger must be one of @ : #")
		return
	}
	if errors.Is(err, slack.ErrAuth) {
		http.Error(w, "auth", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Results []AutocompleteItem `json:"results"`
	}{items})
}

// mentionCandidates queries users and groups CONCURRENTLY (Slack's own client
// fires both on the same keystroke) and appends the locally-injected specials.
// Ranking: users, then groups, then specials.
func (s *Server) mentionCandidates(ctx context.Context, q, channel string) ([]AutocompleteItem, error) {
	out := []AutocompleteItem{}
	if q == "" {
		// A bare "@" must not cost a Slack call — see the request budget in
		// the plan's Global Constraints.
		return append(out, specialItems(q)...), nil
	}

	remote, err := s.acCache.Do("@|"+q+"|"+channel, func() ([]AutocompleteItem, error) {
		var (
			wg         sync.WaitGroup
			users      []slack.User
			groups     []slack.UserGroup
			usersErr   error
			groupsErr  error
		)
		wg.Add(2)
		go func() {
			defer wg.Done()
			users, usersErr = s.SlackClient.SearchUsers(ctx, q, channel, 25)
		}()
		go func() {
			defer wg.Done()
			groups, groupsErr = s.SlackClient.SearchUserGroups(ctx, q, 25)
		}()
		wg.Wait()

		if usersErr != nil {
			return nil, usersErr
		}
		// A group-directory failure must not cost the user their people
		// results; groups are the smaller half of the menu.
		if groupsErr != nil && s.Logger != nil {
			s.Logger.Printf("autocomplete: usergroup search failed: %v", groupsErr)
		}

		items := make([]AutocompleteItem, 0, len(users)+len(groups))
		for _, u := range users {
			items = append(items, AutocompleteItem{
				Kind:   "user",
				ID:     u.ID,
				Label:  userLabel(u),
				Detail: u.Name,
				Avatar: u.Avatar72,
				Token:  userToken(u.ID),
			})
		}
		for _, g := range groups {
			label := g.Handle
			if label == "" {
				label = g.Name
			}
			items = append(items, AutocompleteItem{
				Kind:   "group",
				ID:     g.ID,
				Label:  "@" + label,
				Detail: g.Name,
				Token:  groupToken(g.ID),
			})
		}
		return items, nil
	})
	if err != nil {
		return nil, err
	}
	out = append(out, remote...)
	return append(out, specialItems(q)...), nil
}

func (s *Server) channelCandidates(ctx context.Context, q string) ([]AutocompleteItem, error) {
	if q == "" {
		return []AutocompleteItem{}, nil
	}
	return s.acCache.Do("#|"+q, func() ([]AutocompleteItem, error) {
		chans, err := s.SlackClient.SearchChannels(ctx, q, 25)
		if err != nil {
			return nil, err
		}
		items := make([]AutocompleteItem, 0, len(chans))
		for _, ch := range chans {
			detail := ""
			if ch.IsPrivate {
				detail = "private channel"
			}
			items = append(items, AutocompleteItem{
				Kind:   "channel",
				ID:     ch.ID,
				Label:  "#" + ch.Name,
				Detail: detail,
				Token:  channelToken(ch.ID, ch.Name),
			})
		}
		return items, nil
	})
}

// emojiCandidates answers from the custom-emoji map the server already caches
// (slack.go's emoji()), making NO Slack call. The Unicode half is matched
// client-side from node-emoji and merged into the same menu.
func (s *Server) emojiCandidates(ctx context.Context, q string) ([]AutocompleteItem, error) {
	if q == "" {
		return []AutocompleteItem{}, nil
	}
	all, err := s.emoji(ctx)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, 25)
	for name := range all {
		if strings.Contains(name, strings.ToLower(q)) {
			names = append(names, name)
		}
	}
	// Map iteration is random; sort so the same query always yields the same
	// menu, with shorter (closer) matches first.
	sort.Slice(names, func(i, j int) bool {
		if len(names[i]) != len(names[j]) {
			return len(names[i]) < len(names[j])
		}
		return names[i] < names[j]
	})
	if len(names) > 25 {
		names = names[:25]
	}
	items := make([]AutocompleteItem, 0, len(names))
	for _, name := range names {
		items = append(items, AutocompleteItem{
			Kind:     "emoji",
			ID:       name,
			Label:    ":" + name + ":",
			ImageURL: all[name],
			Token:    emojiToken(name),
		})
	}
	return items, nil
}
```

Add the imports this needs (`context`, `errors`, `net/http`, `sort`, `strings`, `sync`, and the slack package).

Add the cache field to `Server` (in `server.go`, beside `SlackClient`) and initialise it where the server is constructed:

```go
	// acCache fronts every Slack-backed autocomplete lookup; see
	// autocomplete_cache.go for why it is mandatory.
	acCache *autocompleteCache
```

If `Server` is constructed as a bare struct literal by callers (check `cmd/` and the tests), lazily initialise instead, so no caller has to change:

```go
func (s *Server) autocompleteCacheOrInit() *autocompleteCache {
	s.acCacheOnce.Do(func() { s.acCache = newAutocompleteCache(60 * time.Second) })
	return s.acCache
}
```

…with `acCacheOnce sync.Once` on `Server`, and use `s.autocompleteCacheOrInit()` in place of `s.acCache` above. Pick whichever of the two matches how the rest of `Server`'s caches (`emojiCache`, `channelCache`) are handled, and follow that pattern.

- [ ] **Step 4: Register the route**

In `internal/webui/server.go`, next to the other Slack routes (near line 117):

```go
	mux.HandleFunc("GET /api/slack-autocomplete", s.handleSlackAutocomplete)
```

- [ ] **Step 5: Run tests**

Run: `go test ./internal/webui/ -race -v`
Expected: PASS. If the race detector flags `fakeSlack.searchQueries`, add the mutex noted in Task 6 Step 4.

- [ ] **Step 6: Commit**

```bash
git add internal/webui/autocomplete.go internal/webui/autocomplete_test.go internal/webui/server.go
git commit --signoff -m "feat(webui): add GET /api/slack-autocomplete for composer triggers"
```

---

### Task 10: Frontend API client

**Files:**
- Modify: `ui/src/api/slackApi.ts`
- Test: `ui/src/api/slackApi.test.ts`

**Interfaces:**
- Consumes: the endpoint from Task 9.
- Produces: `AutocompleteKind`, `AutocompleteItem`, and `autocomplete(trigger, q, channel, signal?): Promise<AutocompleteItem[]>`. Tasks 12–15 import these.

- [ ] **Step 1: Write the failing test**

```ts
// in ui/src/api/slackApi.test.ts
describe('autocomplete', () => {
  it('sends the trigger, query and channel, and returns results', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ kind: 'user', id: 'U1', label: 'ada', detail: 'aroberts', token: '<@U1>' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const items = await autocomplete('@', 'ad', 'C1')

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/api/slack-autocomplete')
    expect(url).toContain('trigger=%40')
    expect(url).toContain('q=ad')
    expect(url).toContain('channel=C1')
    expect(items).toEqual([
      { kind: 'user', id: 'U1', label: 'ada', detail: 'aroberts', token: '<@U1>' },
    ])
  })

  it('returns [] rather than throwing when the server errors, so the menu keeps local results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => 'boom' }))
    await expect(autocomplete('@', 'ad', 'C1')).resolves.toEqual([])
  })
})
```

Match the existing file's conventions for stubbing `fetch` (see the other tests in `slackApi.test.ts`) rather than introducing a second style.

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/api/slackApi.test.ts`
Expected: FAIL — `autocomplete is not exported`.

- [ ] **Step 3: Implement**

```ts
// in ui/src/api/slackApi.ts
export type AutocompleteKind = 'user' | 'group' | 'special' | 'channel' | 'emoji'

/**
 * One candidate for the composer's autocomplete menu.
 *
 * `token` is the exact mrkdwn to insert — the server builds it so mention
 * encoding lives in one place. Never reconstruct it from `id` at a call site.
 */
export interface AutocompleteItem {
  kind: AutocompleteKind
  id: string
  label: string
  detail?: string
  avatar?: string
  imageUrl?: string
  token: string
}

/**
 * Queries the server for autocomplete candidates. Returns [] on failure
 * rather than throwing: the menu degrades to locally-known candidates, and an
 * exception here would tear down the composer mid-keystroke.
 */
export async function autocomplete(
  trigger: '@' | ':' | '#',
  q: string,
  channel: string,
  signal?: AbortSignal,
): Promise<AutocompleteItem[]> {
  const params = new URLSearchParams({ trigger, q, channel })
  try {
    const res = await fetch(`/api/slack-autocomplete?${params.toString()}`, { signal })
    if (!res.ok) {
      return []
    }
    const body = (await res.json()) as { results?: AutocompleteItem[] }
    return body.results ?? []
  } catch {
    // Includes AbortError, which is a normal part of debounced typing.
    return []
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/api/slackApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/slackApi.ts ui/src/api/slackApi.test.ts
git commit --signoff -m "feat(ui): add autocomplete API client for the Slack composer"
```

---

### Task 11: `detectTrigger` and client-side token construction

**Files:**
- Create: `ui/src/components/slack/composer/detectTrigger.ts`
- Create: `ui/src/components/slack/composer/detectTrigger.test.ts`
- Create: `ui/src/components/slack/composer/tokens.ts`
- Create: `ui/src/components/slack/composer/tokens.test.ts`

**Interfaces:**
- Produces:
  - `detectTrigger(textBeforeCaret: string): TriggerMatch | null` where `TriggerMatch = { trigger: '@' | ':' | '#'; query: string; start: number }` (`start` is the index of the trigger character itself).
  - `tokenFor(item: LocalCandidateSeed): string` — the ONE client-side mrkdwn builder.

**Note on deliberate duplication:** the spec says the server owns token construction, and it does for everything the server returns. But locally-derived candidates (thread participants, groups, `@here`) never round-trip through the server, so their tokens must be built client-side. That logic lives in `tokens.ts` and nowhere else, with a comment pointing at `internal/webui/autocomplete.go`'s builders, and its test table mirrors the Go one case for case.

- [ ] **Step 1: Write the failing tests**

```ts
// ui/src/components/slack/composer/detectTrigger.test.ts
import { describe, it, expect } from 'vitest'
import { detectTrigger } from './detectTrigger'

describe('detectTrigger', () => {
  it('matches a trigger at the start of the text', () => {
    expect(detectTrigger('@ad')).toEqual({ trigger: '@', query: 'ad', start: 0 })
  })

  it('matches a trigger after whitespace', () => {
    expect(detectTrigger('hello @ad')).toEqual({ trigger: '@', query: 'ad', start: 6 })
  })

  it('matches a bare trigger with an empty query', () => {
    expect(detectTrigger('hello @')).toEqual({ trigger: '@', query: '', start: 6 })
  })

  it('does not match mid-word, so email addresses are left alone', () => {
    expect(detectTrigger('mail ada@example.com')).toBeNull()
  })

  it('closes once the query is broken by whitespace', () => {
    expect(detectTrigger('@ada says')).toBeNull()
  })

  it('handles the : and # triggers', () => {
    expect(detectTrigger('nice :tad')).toEqual({ trigger: ':', query: 'tad', start: 5 })
    expect(detectTrigger('see #odh')).toEqual({ trigger: '#', query: 'odh', start: 4 })
  })

  it('matches after a newline', () => {
    expect(detectTrigger('line one\n@ad')).toEqual({ trigger: '@', query: 'ad', start: 9 })
  })

  it('returns null for text with no trigger', () => {
    expect(detectTrigger('just typing')).toBeNull()
  })
})
```

```ts
// ui/src/components/slack/composer/tokens.test.ts
import { describe, it, expect } from 'vitest'
import { tokenFor } from './tokens'

// This table MIRRORS TestTokenBuilders in internal/webui/autocomplete_test.go.
// If one changes, change both.
describe('tokenFor', () => {
  it('builds the same mrkdwn the server does', () => {
    expect(tokenFor({ kind: 'user', id: 'U123' })).toBe('<@U123>')
    expect(tokenFor({ kind: 'group', id: 'S123' })).toBe('<!subteam^S123>')
    expect(tokenFor({ kind: 'special', id: 'here' })).toBe('<!here>')
    expect(tokenFor({ kind: 'special', id: 'channel' })).toBe('<!channel>')
    expect(tokenFor({ kind: 'channel', id: 'C123', name: 'odh-dashboard' })).toBe('<#C123|odh-dashboard>')
    expect(tokenFor({ kind: 'emoji', id: 'tada' })).toBe(':tada:')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && npx vitest run src/components/slack/composer/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// ui/src/components/slack/composer/detectTrigger.ts

/** A live autocomplete trigger found immediately before the caret. */
export interface TriggerMatch {
  trigger: '@' | ':' | '#'
  /** The text typed after the trigger character, without it. */
  query: string
  /** Index of the trigger character itself, for replacing on selection. */
  start: number
}

// A trigger only counts at the start of the text or after whitespace — this
// is what keeps "ada@example.com" from opening a mention menu. The query runs
// to the caret and may not contain whitespace or another trigger character.
const TRIGGER_RE = /(?:^|\s)([@:#])([^\s@:#]*)$/

/**
 * Decides whether an autocomplete menu should be open, given the text between
 * the start of the block and the caret.
 *
 * Pure by design: jsdom has no real Selection or contenteditable behaviour,
 * so trigger logic buried in a DOM handler would be untestable.
 */
export function detectTrigger(textBeforeCaret: string): TriggerMatch | null {
  const m = TRIGGER_RE.exec(textBeforeCaret)
  if (!m) {
    return null
  }
  const [, trigger, query] = m
  return {
    trigger: trigger as '@' | ':' | '#',
    query,
    start: textBeforeCaret.length - query.length - 1,
  }
}
```

```ts
// ui/src/components/slack/composer/tokens.ts
import type { AutocompleteKind } from '../../../api/slackApi'

export interface LocalCandidateSeed {
  kind: AutocompleteKind
  id: string
  /** Required for channels — "<#C1|name>" carries the name inline. */
  name?: string
}

/**
 * Builds the mrkdwn token for a candidate derived LOCALLY (thread
 * participants, loaded groups, the @here/@channel/@everyone specials), which
 * never round-trips through the server.
 *
 * Everything the server returns already carries its own `token`; use that.
 * This is the only place in the frontend that constructs mention syntax, and
 * it deliberately mirrors the builders in internal/webui/autocomplete.go —
 * its test table mirrors that file's table case for case. Change both.
 */
export function tokenFor(seed: LocalCandidateSeed): string {
  switch (seed.kind) {
    case 'user':
      return `<@${seed.id}>`
    case 'group':
      return `<!subteam^${seed.id}>`
    case 'special':
      return `<!${seed.id}>`
    case 'channel':
      return `<#${seed.id}|${seed.name ?? ''}>`
    case 'emoji':
      return `:${seed.id}:`
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/slack/composer/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/slack/composer/detectTrigger.ts ui/src/components/slack/composer/detectTrigger.test.ts ui/src/components/slack/composer/tokens.ts ui/src/components/slack/composer/tokens.test.ts
git commit --signoff -m "feat(ui): add trigger detection and local mrkdwn token builder"
```

---

### Task 12: Local candidates and merge

**Files:**
- Create: `ui/src/components/slack/composer/candidates.ts`
- Create: `ui/src/components/slack/composer/candidates.test.ts`

**Interfaces:**
- Consumes: `AutocompleteItem` (Task 10), `tokenFor` (Task 11), `User`/`UserGroup` from `slackApi`.
- Produces:
  - `localCandidates(trigger, query, ctx: LocalContext): AutocompleteItem[]` where `LocalContext = { users: Record<string, User>; groups: Record<string, UserGroup> }`.
  - `mergeCandidates(local: AutocompleteItem[], remote: AutocompleteItem[]): AutocompleteItem[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { localCandidates, mergeCandidates } from './candidates'
import type { AutocompleteItem } from '../../../api/slackApi'

const ctx = {
  users: {
    U1: { ID: 'U1', Name: 'aroberts', RealName: 'Ada Roberts', DisplayName: 'ada', Avatar72: 'a.png' },
    U2: { ID: 'U2', Name: 'bmorse', RealName: 'Ben Morse', DisplayName: '', Avatar72: 'b.png' },
  },
  groups: {
    S1: { ID: 'S1', Name: 'Platform Team', Handle: 'platform' },
  },
}

describe('localCandidates', () => {
  it('matches thread participants on display name, real name and handle', () => {
    expect(localCandidates('@', 'ada', ctx).map((c) => c.id)).toEqual(['U1'])
    expect(localCandidates('@', 'morse', ctx).map((c) => c.id)).toEqual(['U2'])
    expect(localCandidates('@', 'arob', ctx).map((c) => c.id)).toEqual(['U1'])
  })

  it('builds tokens for local candidates', () => {
    expect(localCandidates('@', 'ada', ctx)[0].token).toBe('<@U1>')
    expect(localCandidates('@', 'platform', ctx)[0].token).toBe('<!subteam^S1>')
  })

  it('includes the specials, and shows all three for a bare trigger', () => {
    expect(localCandidates('@', 'her', ctx).map((c) => c.id)).toContain('here')
    const bare = localCandidates('@', '', ctx)
    expect(bare.filter((c) => c.kind === 'special')).toHaveLength(3)
  })

  it('has nothing local to offer for : and #', () => {
    expect(localCandidates(':', 'tad', ctx)).toEqual([])
    expect(localCandidates('#', 'odh', ctx)).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(localCandidates('@', 'ADA', ctx).map((c) => c.id)).toEqual(['U1'])
  })
})

describe('mergeCandidates', () => {
  const local: AutocompleteItem[] = [{ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }]
  const remote: AutocompleteItem[] = [
    { kind: 'user', id: 'U1', label: 'ada (remote)', token: '<@U1>' },
    { kind: 'user', id: 'U9', label: 'zoe', token: '<@U9>' },
  ]

  it('keeps local entries first and drops the remote duplicate', () => {
    expect(mergeCandidates(local, remote)).toEqual([local[0], remote[1]])
  })

  it('dedupes on kind AND id, so a user and a channel sharing an id both survive', () => {
    const a: AutocompleteItem[] = [{ kind: 'user', id: 'X', label: 'u', token: '<@X>' }]
    const b: AutocompleteItem[] = [{ kind: 'channel', id: 'X', label: '#c', token: '<#X|c>' }]
    expect(mergeCandidates(a, b)).toHaveLength(2)
  })

  it('returns remote alone when there is nothing local', () => {
    expect(mergeCandidates([], remote)).toEqual(remote)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/components/slack/composer/candidates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// ui/src/components/slack/composer/candidates.ts
import type { AutocompleteItem, User, UserGroup } from '../../../api/slackApi'
import { tokenFor } from './tokens'

export interface LocalContext {
  /** Thread participants, already loaded by the thread view. */
  users: Record<string, User>
  /** Workspace user groups, already loaded by the thread view. */
  groups: Record<string, UserGroup>
}

const SPECIALS: Array<{ id: string; detail: string }> = [
  { id: 'here', detail: 'Notify everyone online in this channel' },
  { id: 'channel', detail: 'Notify everyone in this channel' },
  { id: 'everyone', detail: 'Notify everyone in the workspace' },
]

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.toLowerCase()
  return fields.some((f) => (f ?? '').toLowerCase().includes(q))
}

/**
 * Candidates answerable instantly from data the thread view already holds, so
 * the menu paints on the first keystroke rather than after a round trip.
 * The server's results are merged in when they arrive (see mergeCandidates).
 *
 * Only "@" has local answers: emoji and channels are not part of the thread
 * payload.
 */
export function localCandidates(
  trigger: '@' | ':' | '#',
  query: string,
  ctx: LocalContext,
): AutocompleteItem[] {
  if (trigger !== '@') {
    return []
  }
  const out: AutocompleteItem[] = []

  for (const u of Object.values(ctx.users)) {
    if (query && !matches(query, u.DisplayName, u.RealName, u.Name)) {
      continue
    }
    out.push({
      kind: 'user',
      id: u.ID,
      label: u.DisplayName || u.RealName || u.Name || u.ID,
      detail: u.Name,
      avatar: u.Avatar72,
      token: tokenFor({ kind: 'user', id: u.ID }),
    })
  }

  for (const g of Object.values(ctx.groups)) {
    if (query && !matches(query, g.Handle, g.Name)) {
      continue
    }
    out.push({
      kind: 'group',
      id: g.ID,
      label: `@${g.Handle || g.Name}`,
      detail: g.Name,
      token: tokenFor({ kind: 'group', id: g.ID }),
    })
  }

  for (const s of SPECIALS) {
    if (query && !s.id.includes(query.toLowerCase())) {
      continue
    }
    out.push({
      kind: 'special',
      id: s.id,
      label: `@${s.id}`,
      detail: s.detail,
      token: tokenFor({ kind: 'special', id: s.id }),
    })
  }

  return out
}

/**
 * Merges server results into the locally-derived list, deduping on
 * (kind, id) with local entries winning.
 *
 * Consequence, by design: the menu can reorder ONCE, when remote results
 * land. It never reorders after that, and the caller tracks the highlighted
 * item by (kind, id) rather than by index so a merge cannot move the
 * selection under the user's keyboard.
 */
export function mergeCandidates(
  local: AutocompleteItem[],
  remote: AutocompleteItem[],
): AutocompleteItem[] {
  const seen = new Set(local.map((c) => `${c.kind}:${c.id}`))
  return [...local, ...remote.filter((c) => !seen.has(`${c.kind}:${c.id}`))]
}
```

`User` and `UserGroup` are already exported from `slackApi.ts` (lines 174 and 21); `User` needs a `Name` field added to the TS interface to match the Go struct grown in Task 3:

```ts
export interface User {
  ID: string
  Name: string
  RealName: string
  DisplayName: string
  Avatar72: string
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/slack/composer/candidates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/slack/composer/candidates.ts ui/src/components/slack/composer/candidates.test.ts ui/src/api/slackApi.ts
git commit --signoff -m "feat(ui): add local autocomplete candidates and hybrid merge"
```

---

### Task 13: `useAutocomplete` hook

**Files:**
- Create: `ui/src/components/slack/composer/useAutocomplete.ts`
- Create: `ui/src/components/slack/composer/useAutocomplete.test.ts`

**Interfaces:**
- Consumes: `autocomplete()` (Task 10), `localCandidates`/`mergeCandidates`/`LocalContext` (Task 12), `TriggerMatch` (Task 11).
- Produces: `useAutocomplete(match: TriggerMatch | null, channel: string, ctx: LocalContext): { items: AutocompleteItem[]; degraded: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useAutocomplete } from './useAutocomplete'
import * as api from '../../../api/slackApi'

const ctx = {
  users: { U1: { ID: 'U1', Name: 'aroberts', RealName: 'Ada Roberts', DisplayName: 'ada', Avatar72: '' } },
  groups: {},
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useAutocomplete', () => {
  it('returns local candidates immediately, before any fetch resolves', () => {
    vi.spyOn(api, 'autocomplete').mockResolvedValue([])
    const { result } = renderHook(() =>
      useAutocomplete({ trigger: '@', query: 'ada', start: 0 }, 'C1', ctx),
    )
    expect(result.current.items.map((i) => i.id)).toContain('U1')
    expect(api.autocomplete).not.toHaveBeenCalled() // still inside the debounce
  })

  it('debounces, then merges remote results in', async () => {
    const spy = vi.spyOn(api, 'autocomplete').mockResolvedValue([
      { kind: 'user', id: 'U9', label: 'zoe', token: '<@U9>' },
    ])
    const { result } = renderHook(() =>
      useAutocomplete({ trigger: '@', query: 'ada', start: 0 }, 'C1', ctx),
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(spy).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toContain('U9'))
    expect(result.current.items[0].id).toBe('U1') // local still ranks first
  })

  it('makes no request while the match is null', async () => {
    const spy = vi.spyOn(api, 'autocomplete').mockResolvedValue([])
    renderHook(() => useAutocomplete(null, 'C1', ctx))
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('drops a stale response that resolves after a newer query', async () => {
    let resolveFirst: (v: api.AutocompleteItem[]) => void = () => {}
    const spy = vi
      .spyOn(api, 'autocomplete')
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockResolvedValueOnce([{ kind: 'user', id: 'NEW', label: 'new', token: '<@NEW>' }])

    const { result, rerender } = renderHook(
      ({ q }) => useAutocomplete({ trigger: '@', query: q, start: 0 }, 'C1', ctx),
      { initialProps: { q: 'a' } },
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    rerender({ q: 'ab' })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    // The first request now resolves — too late, and must be ignored.
    await act(async () => {
      resolveFirst([{ kind: 'user', id: 'STALE', label: 'stale', token: '<@STALE>' }])
    })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(result.current.items.map((i) => i.id)).not.toContain('STALE')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/components/slack/composer/useAutocomplete.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// ui/src/components/slack/composer/useAutocomplete.ts
import { useEffect, useMemo, useRef, useState } from 'react'
import { autocomplete, type AutocompleteItem } from '../../../api/slackApi'
import type { TriggerMatch } from './detectTrigger'
import { localCandidates, mergeCandidates, type LocalContext } from './candidates'

const DEBOUNCE_MS = 150

/**
 * The hybrid lookup: local candidates paint immediately, the server's fill in.
 *
 * Every Slack call this makes is caused by a keystroke, and the debounce plus
 * the server's TTL cache are what keep that from becoming a burst — see the
 * token-revocation note in docs/reverse-engineering/slack-web-api.md.
 */
export function useAutocomplete(
  match: TriggerMatch | null,
  channel: string,
  ctx: LocalContext,
): { items: AutocompleteItem[]; degraded: boolean } {
  const [remote, setRemote] = useState<AutocompleteItem[]>([])
  const [degraded, setDegraded] = useState(false)
  // Monotonic request id: only the newest response may be applied.
  const seq = useRef(0)

  const trigger = match?.trigger
  const query = match?.query ?? ''

  const local = useMemo(
    () => (trigger ? localCandidates(trigger, query, ctx) : []),
    [trigger, query, ctx],
  )

  useEffect(() => {
    if (!trigger) {
      setRemote([])
      setDegraded(false)
      return
    }
    const id = ++seq.current
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      const results = await autocomplete(trigger, query, channel, controller.signal)
      if (seq.current !== id) {
        return // a newer query has been issued; this answer is stale
      }
      setRemote(results)
      // autocomplete() returns [] both for "no matches" and for a failed
      // request; treating a non-empty local list with an empty remote one as
      // degraded is the honest reading, and only affects a hint line.
      setDegraded(results.length === 0 && query.length > 0)
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [trigger, query, channel])

  const items = useMemo(() => mergeCandidates(local, remote), [local, remote])
  return { items, degraded }
}
```

**Note for the implementer:** `ctx` is in `local`'s dependency array, so the caller must memoise it (Task 15 does) or the hook recomputes every render. That is a correctness-neutral but wasteful trap.

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/slack/composer/useAutocomplete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/slack/composer/useAutocomplete.ts ui/src/components/slack/composer/useAutocomplete.test.ts
git commit --signoff -m "feat(ui): add debounced hybrid autocomplete hook"
```

---

### Task 14: `MentionNode` and the autocomplete menu

**Files:**
- Modify: `ui/package.json` (add `lexical`, `@lexical/react`)
- Create: `ui/src/components/slack/composer/MentionNode.tsx`
- Create: `ui/src/components/slack/composer/MentionNode.test.tsx`
- Create: `ui/src/components/slack/composer/AutocompleteMenu.tsx`
- Create: `ui/src/components/slack/composer/AutocompleteMenu.test.tsx`

**Interfaces:**
- Consumes: `AutocompleteItem` (Task 10); the existing `Mention` component (`ui/src/components/slack/Mention.tsx`).
- Produces:
  - `MentionNode` (a Lexical `DecoratorNode`) plus `$createMentionNode(item: AutocompleteItem): MentionNode` and `$isMentionNode(node): node is MentionNode`. **`getTextContent()` returns the stored token** — that is what makes serialization in Task 15 a one-liner.
  - `<AutocompleteMenu items highlightedId onSelect degraded />`.

- [ ] **Step 1: Add the dependencies**

```bash
cd ui && npm install lexical @lexical/react
```

- [ ] **Step 2: Write the failing tests**

```tsx
// ui/src/components/slack/composer/MentionNode.test.tsx
import { describe, it, expect } from 'vitest'
import { createEditor, $getRoot, $createParagraphNode, $createTextNode } from 'lexical'
import { MentionNode, $createMentionNode, $isMentionNode } from './MentionNode'

describe('MentionNode', () => {
  it('serializes as its token via getTextContent, so the root text IS the mrkdwn', () => {
    const editor = createEditor({ nodes: [MentionNode], onError: (e) => { throw e } })
    editor.update(
      () => {
        const p = $createParagraphNode()
        p.append($createTextNode('hi '))
        p.append($createMentionNode({ kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' }))
        p.append($createTextNode(' there'))
        $getRoot().clear().append(p)
      },
      { discrete: true },
    )
    const text = editor.getEditorState().read(() => $getRoot().getTextContent())
    expect(text).toBe('hi <@U1> there')
  })

  it('round-trips through exportJSON/importJSON', () => {
    const editor = createEditor({ nodes: [MentionNode], onError: (e) => { throw e } })
    let json: ReturnType<MentionNode['exportJSON']> | undefined
    editor.update(
      () => {
        json = $createMentionNode({ kind: 'group', id: 'S1', label: '@platform', token: '<!subteam^S1>' }).exportJSON()
      },
      { discrete: true },
    )
    editor.update(
      () => {
        const restored = MentionNode.importJSON(json!)
        expect($isMentionNode(restored)).toBe(true)
        expect(restored.getTextContent()).toBe('<!subteam^S1>')
      },
      { discrete: true },
    )
  })
})
```

```tsx
// ui/src/components/slack/composer/AutocompleteMenu.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { AutocompleteMenu } from './AutocompleteMenu'
import type { AutocompleteItem } from '../../../api/slackApi'

afterEach(cleanup)

const items: AutocompleteItem[] = [
  { kind: 'user', id: 'U1', label: 'ada', detail: 'aroberts', token: '<@U1>' },
  { kind: 'special', id: 'here', label: '@here', detail: 'Notify everyone online', token: '<!here>' },
]

function renderMenu(props: Partial<React.ComponentProps<typeof AutocompleteMenu>> = {}) {
  return render(
    <MantineProvider>
      <AutocompleteMenu items={items} highlightedId="user:U1" onSelect={() => {}} degraded={false} {...props} />
    </MantineProvider>,
  )
}

describe('AutocompleteMenu', () => {
  it('renders every candidate with its label and detail', () => {
    const { getByText } = renderMenu()
    expect(getByText('ada')).toBeInTheDocument()
    expect(getByText('aroberts')).toBeInTheDocument()
    expect(getByText('@here')).toBeInTheDocument()
  })

  it('marks the highlighted row for assistive tech', () => {
    const { getAllByRole } = renderMenu()
    const options = getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
  })

  it('calls onSelect with the item when a row is clicked', () => {
    const onSelect = vi.fn()
    const { getByText } = renderMenu({ onSelect })
    fireEvent.click(getByText('@here'))
    expect(onSelect).toHaveBeenCalledWith(items[1])
  })

  it('shows a hint instead of emptying when workspace search is unavailable', () => {
    const { getByText } = renderMenu({ degraded: true })
    expect(getByText(/workspace search unavailable/i)).toBeInTheDocument()
  })

  it('renders nothing when there are no items and nothing to say', () => {
    const { container } = renderMenu({ items: [], degraded: false })
    expect(container).toBeEmptyDOMElement()
  })
})
```

Copy the `window.matchMedia` stub from `Composer.test.tsx:11-24` into any new test file that renders `MantineProvider` — jsdom lacks it and Mantine's colour-scheme effect needs it.

- [ ] **Step 3: Run to verify they fail**

Run: `cd ui && npx vitest run src/components/slack/composer/`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `MentionNode`**

```tsx
// ui/src/components/slack/composer/MentionNode.tsx
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from 'lexical'
import type { JSX } from 'react'
import type { AutocompleteItem, AutocompleteKind } from '../../../api/slackApi'
import { Mention } from '../Mention'

export type SerializedMentionNode = Spread<
  { mentionKind: AutocompleteKind; mentionId: string; label: string; token: string },
  SerializedLexicalNode
>

/**
 * An atomic pill in the composer: one mention, one emoji or one channel
 * reference, held as an object rather than as characters so it cannot be
 * half-deleted into malformed mrkdwn.
 *
 * getTextContent() returns the mrkdwn TOKEN. That is deliberate and
 * load-bearing: it makes `$getRoot().getTextContent()` the serialized message,
 * so there is no separate serializer to drift out of sync with the pills.
 */
export class MentionNode extends DecoratorNode<JSX.Element> {
  __mentionKind: AutocompleteKind
  __mentionId: string
  __label: string
  __token: string

  static getType(): string {
    return 'mention'
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mentionKind, node.__mentionId, node.__label, node.__token, node.__key)
  }

  constructor(kind: AutocompleteKind, id: string, label: string, token: string, key?: NodeKey) {
    super(key)
    this.__mentionKind = kind
    this.__mentionId = id
    this.__label = label
    this.__token = token
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span')
    span.style.display = 'inline-block'
    return span
  }

  updateDOM(): false {
    return false
  }

  getTextContent(): string {
    return this.__token
  }

  isInline(): true {
    return true
  }

  exportJSON(): SerializedMentionNode {
    return {
      type: 'mention',
      version: 1,
      mentionKind: this.__mentionKind,
      mentionId: this.__mentionId,
      label: this.__label,
      token: this.__token,
    }
  }

  static importJSON(json: SerializedMentionNode): MentionNode {
    return new MentionNode(json.mentionKind, json.mentionId, json.label, json.token)
  }

  decorate(): JSX.Element {
    // Reuses the same pill the rendered thread uses, so a pending mention in
    // the composer looks like the mention it is about to become.
    return <Mention>{this.__label}</Mention>
  }
}

export function $createMentionNode(item: AutocompleteItem): MentionNode {
  return new MentionNode(item.kind, item.id, item.label, item.token)
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode
}
```

- [ ] **Step 5: Implement `AutocompleteMenu`**

```tsx
// ui/src/components/slack/composer/AutocompleteMenu.tsx
import { Avatar, Group, Paper, Stack, Text } from '@mantine/core'
import type { AutocompleteItem } from '../../../api/slackApi'

export interface AutocompleteMenuProps {
  items: AutocompleteItem[]
  /** "kind:id" of the highlighted row — tracked by identity, never by index,
   *  so a merge of late-arriving remote results cannot move the selection. */
  highlightedId: string | null
  onSelect: (item: AutocompleteItem) => void
  /** True when the workspace search failed and only local results are shown. */
  degraded: boolean
}

export function itemKey(item: AutocompleteItem): string {
  return `${item.kind}:${item.id}`
}

export function AutocompleteMenu({ items, highlightedId, onSelect, degraded }: AutocompleteMenuProps) {
  if (items.length === 0 && !degraded) {
    return null
  }
  return (
    <Paper withBorder shadow="md" p={4} role="listbox" aria-label="Autocomplete candidates">
      <Stack gap={0}>
        {items.map((item) => {
          const key = itemKey(item)
          const selected = key === highlightedId
          return (
            <Group
              key={key}
              role="option"
              aria-selected={selected}
              gap="xs"
              wrap="nowrap"
              p={4}
              style={{ cursor: 'pointer', background: selected ? 'var(--mantine-color-dark-5)' : undefined }}
              // onMouseDown, not onClick: the editor must not lose the caret
              // to a focus change before the insertion runs.
              onMouseDown={(e) => {
                e.preventDefault()
                onSelect(item)
              }}
            >
              {item.avatar ? <Avatar src={item.avatar} size={20} radius="xl" /> : null}
              {item.imageUrl ? <img src={item.imageUrl} alt="" width={20} height={20} /> : null}
              <Text size="sm">{item.label}</Text>
              {item.detail ? (
                <Text size="xs" c="dimmed">
                  {item.detail}
                </Text>
              ) : null}
            </Group>
          )
        })}
        {degraded ? (
          <Text size="xs" c="dimmed" p={4}>
            Workspace search unavailable — showing people from this thread
          </Text>
        ) : null}
      </Stack>
    </Paper>
  )
}
```

Note the test clicks a row; `onMouseDown` with `preventDefault` is what both satisfies it and preserves the caret. `fireEvent.click` also dispatches mousedown in Testing Library — if it does not in this version, change the test to `fireEvent.mouseDown`.

- [ ] **Step 6: Run tests**

Run: `cd ui && npx vitest run src/components/slack/composer/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/package.json ui/package-lock.json ui/src/components/slack/composer/MentionNode.tsx ui/src/components/slack/composer/MentionNode.test.tsx ui/src/components/slack/composer/AutocompleteMenu.tsx ui/src/components/slack/composer/AutocompleteMenu.test.tsx
git commit --signoff -m "feat(ui): add Lexical MentionNode and autocomplete menu"
```

---

### Task 15: Rebuild the composer on Lexical

**Files:**
- Rewrite: `ui/src/components/slack/Composer.tsx`
- Modify: `ui/src/components/slack/Composer.test.tsx`
- Modify: `ui/src/components/slack/ThreadView.tsx` (line 363)

**Interfaces:**
- Consumes: everything from Tasks 11–14.
- Produces: `<Composer onSend={(text: string) => void} disabled? channel users groups />`. `onSend` still receives a plain mrkdwn string — `ThreadView`'s `handleSend` is unchanged apart from the new props.

- [ ] **Step 1: Write the failing tests**

Keep every existing test in `Composer.test.tsx` (they encode behaviour that must not regress) and update them for the contenteditable: the editor is `getByRole('textbox')` still, but assertions on `ta.value` become assertions on `onSend`'s argument. Add:

```tsx
it('inserts a pill and sends its token, not the typed name', async () => {
  const onSend = vi.fn()
  vi.spyOn(api, 'autocomplete').mockResolvedValue([
    { kind: 'user', id: 'U1', label: 'ada', detail: 'aroberts', token: '<@U1>' },
  ])
  const { getByRole, findByText } = renderWithProvider(
    <Composer onSend={onSend} channel="C1" users={{}} groups={{}} />,
  )
  const editor = getByRole('textbox')
  await userEvent.type(editor, 'hi @ada')
  fireEvent.mouseDown(await findByText('ada'))
  await userEvent.type(editor, '!')
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(onSend).toHaveBeenCalledWith('hi <@U1> !')
})

it('Enter picks a candidate instead of sending while the menu is open', async () => {
  const onSend = vi.fn()
  vi.spyOn(api, 'autocomplete').mockResolvedValue([
    { kind: 'user', id: 'U1', label: 'ada', token: '<@U1>' },
  ])
  const { getByRole, findByText } = renderWithProvider(
    <Composer onSend={onSend} channel="C1" users={{}} groups={{}} />,
  )
  const editor = getByRole('textbox')
  await userEvent.type(editor, '@ada')
  await findByText('ada') // menu is open
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(onSend).not.toHaveBeenCalled()
})

it('Escape closes the menu and lets Enter send again', async () => {
  const onSend = vi.fn()
  vi.spyOn(api, 'autocomplete').mockResolvedValue([])
  const { getByRole } = renderWithProvider(
    <Composer onSend={onSend} channel="C1" users={{}} groups={{}} />,
  )
  const editor = getByRole('textbox')
  await userEvent.type(editor, 'plain text')
  fireEvent.keyDown(editor, { key: 'Escape' })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(onSend).toHaveBeenCalledWith('plain text')
})
```

**Expect friction here.** jsdom's contenteditable support is thin: `userEvent.type` into a Lexical editor may not produce input events Lexical acts on. If it does not, drive the editor through Lexical's own API in the test — grab the editor instance via a test-only `onEditorReady` callback prop and use `editor.update(() => { $getRoot()... })` — rather than deleting the assertion. The behaviour being tested (a pill serializes as its token; Enter picks rather than sends) is the point of the whole feature; the input mechanism is not.

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && npx vitest run src/components/slack/Composer.test.tsx`
Expected: FAIL — `Composer` does not accept `channel`/`users`/`groups`; no menu appears.

- [ ] **Step 3: Implement the composer**

Structure (the implementer fills in the wiring; these are the required parts):

```tsx
// ui/src/components/slack/Composer.tsx — structure
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getRoot, $getSelection, $isRangeSelection, $createTextNode,
  COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND,
  KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_TAB_COMMAND, PASTE_COMMAND,
} from 'lexical'
```

Required behaviours:

1. **PlainTextPlugin, not RichTextPlugin.** Formatting is literal mrkdwn characters, so the model stays text + pills + line breaks.
2. **Serialization is one line**, thanks to `MentionNode.getTextContent()`:
   ```tsx
   const text = editor.getEditorState().read(() => $getRoot().getTextContent())
   ```
3. **Trigger detection** in an `editor.registerUpdateListener`: read the selection's anchor, take the text from the start of the block to the caret, pass it to `detectTrigger`, and store the result in state. Feed that to `useAutocomplete(match, channel, ctx)` with `ctx` memoised (`useMemo(() => ({ users, groups }), [users, groups])`) — see the trap noted in Task 13.
4. **Insertion** replaces the trigger text with a pill:
   ```tsx
   editor.update(() => {
     const selection = $getSelection()
     if (!$isRangeSelection(selection)) return
     // Delete the trigger character plus the typed query, then insert the
     // pill followed by a space so typing continues outside it.
     const toDelete = 1 + match.query.length
     for (let i = 0; i < toDelete; i++) selection.deleteCharacter(true)
     selection.insertNodes([$createMentionNode(item), $createTextNode(' ')])
   })
   ```
5. **Keyboard**, all registered at `COMMAND_PRIORITY_HIGH`, all returning `true` only when they handle the key:
   - `KEY_ENTER_COMMAND`: menu open → select highlighted item; `event.shiftKey` → let Lexical insert a line break; otherwise → send.
   - `KEY_ARROW_DOWN_COMMAND` / `KEY_ARROW_UP_COMMAND` / `KEY_TAB_COMMAND`: move the highlight while the menu is open.
   - `KEY_ESCAPE_COMMAND`: close the menu (set match to null and suppress it until the next trigger).
6. **Paste as plain text:** a `PASTE_COMMAND` handler reading `text/plain` off the clipboard and inserting it, returning `true` so HTML never enters the model.
7. **Highlight tracked by `itemKey(item)`**, never by index (Task 14 exports `itemKey`).
8. **Toolbar preserved:** the five existing buttons keep wrapping the selection in mrkdwn characters, now via `$getSelection()` and `insertText`. Keep the existing `TOOLBAR_ACTIONS` array and its comment verbatim — only the click handler changes.
9. **Send** calls `onSend(text.trim())` and clears the editor (`$getRoot().clear()`), and stays disabled while the trimmed text is empty, exactly as today.

Update `ThreadView.tsx:363` to pass the new props:

```tsx
{status === 'ready' && data && (
  <Composer
    onSend={handleSend}
    channel={data.channel}
    users={data.users}
    groups={data.groups ?? {}}
  />
)}
```

**Contingency:** if `LexicalTypeaheadMenuPlugin` is used instead of the hand-wired listener above and its trigger/positioning API fights the three-trigger requirement, the hand-wired version described here IS the fallback — it is why the menu, the hook and the trigger detection are all separately testable units.

- [ ] **Step 4: Run the full UI suite**

Run: `cd ui && npm test`
Expected: PASS, including every pre-existing `Composer.test.tsx` behaviour and the `ThreadView` tests.

- [ ] **Step 5: Typecheck and build**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: no type errors, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/slack/Composer.tsx ui/src/components/slack/Composer.test.tsx ui/src/components/slack/ThreadView.tsx
git commit --signoff -m "feat(ui): rebuild the Slack composer on Lexical with mention pills"
```

---

### Task 16: Documentation and a real smoke test

**Files:**
- Modify: `docs/web-ui-architecture.md` (Slack thread view section)
- Modify: `docs/reverse-engineering/slack-web-api.md` (only if something new was learned)
- Modify: `.claude/CLAUDE.md` (the `internal/webui` bullet, one clause)

**Interfaces:**
- Consumes: everything.
- Produces: docs that match the shipped code, and evidence the feature works against real Slack.

- [ ] **Step 1: Document the route and DTO**

In `docs/web-ui-architecture.md`'s Slack section, add `GET /api/slack-autocomplete` alongside the existing `/api/thread*` routes: its three triggers, the `AutocompleteItem` shape, the fact that `token` is server-built mrkdwn, and the hybrid local-first behaviour with its one-time reorder. Mention the TTL/single-flight cache and why it is mandatory.

In `.claude/CLAUDE.md`, extend the `webui` bullet to note that it also serves the composer autocomplete route.

- [ ] **Step 2: Build and run for real**

```bash
make build
./bin/worktree ui --no-open
```

Open a worktree detail page with a real Slack thread resource selected.

- [ ] **Step 3: Smoke-test each trigger**

In the reply composer, verify:
1. `@` with no query → the three specials plus thread participants, instantly.
2. `@ada` (someone NOT in the thread) → workspace results arrive after the debounce; the menu reorders once and does not jump again.
3. Picking a candidate → a pill appears, not `<@U…>` text.
4. Backspace at the pill's right edge deletes the whole pill.
5. `:` and `#` menus populate.
6. Escape closes the menu; Enter then sends.
7. Send a reply mentioning yourself in a **real thread you own** (or the self-DM) and confirm in the real Slack client that it renders as a mention and notifies.
8. Check the browser console for errors and the server log for `autocomplete:` warnings.

- [ ] **Step 4: Record anything new in the RE doc**

If any Slack response shape, error, or rate-limit behaviour differed from what the RE doc says, update `docs/reverse-engineering/slack-web-api.md` in this commit — the repo rule requires it in the same change, not later. If nothing new was learned, say so in the commit body rather than silently skipping.

- [ ] **Step 5: Commit**

```bash
git add docs/web-ui-architecture.md .claude/CLAUDE.md
git commit --signoff -m "docs: document the Slack composer autocomplete route and behaviour"
```

- [ ] **Step 6: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to decide how this integrates. Do not merge or push without asking Mike.

---

## Self-Review Notes

**Spec coverage:** every spec section maps to a task — client layer (2–6), endpoint + DTO + cache + guards (7–9), Lexical composer with pills/paste/toolbar/Enter (14–15), hybrid lookup with abort + seq + degraded state (12–13), the `text`-vs-`blocks` risk (1), testing (throughout), documentation (16).

**Known deviation from the spec, flagged deliberately:** the spec says the frontend never builds mention syntax. Locally-derived candidates never round-trip through the server, so `ui/.../composer/tokens.ts` must build their tokens. It is confined to one file whose test table mirrors the Go table case for case, with cross-referencing comments in both. Task 11 records this.

**Type consistency:** `AutocompleteItem` field names are identical in Go (`internal/webui/autocomplete.go`) and TS (`slackApi.ts`); `User.Name` is added in both Go (Task 3) and TS (Task 12); `itemKey` is defined once (Task 14) and used by Tasks 14–15; `LocalContext` is defined in Task 12 and consumed in Tasks 13 and 15.
