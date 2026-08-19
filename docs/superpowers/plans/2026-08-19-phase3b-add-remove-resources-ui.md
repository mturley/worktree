# Add/Remove Worktree Resources from the Web UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user add a resource by pasting a PR/Jira/Slack URL, and remove a resource, from the web UI — via two new mutation endpoints and controls on the Overview tab + a `+` button in the Slack tab.

**Architecture:** Two new `internal/webui` endpoints mirroring `handleSetResourceMeta`. Add infers type+id from the URL using a shared helper wrapping the existing CLI primitives (`prURLPattern`, `jira.ParseJiraURL`, `slackurl.Parse`), calls `resources.Add`, then inline-enriches by polling that one resource through a shared `pollOne` helper factored out of `pollAll` (no duplicated fetch logic). Remove calls `resources.Remove`. Frontend adds `api.addResource`/`api.removeResource`, an "Add resource" URL field on Overview, a confirm-popover remove control on each card, and a `+` button in the Slack rail — all reusing the Phase-3b `useWorktreeDetail` refetch.

**Tech Stack:** Go (internal/webui), React 19 + Mantine + Vite + vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-phase3b-add-remove-resources-ui-design.md`

## Global Constraints

- Endpoints live in `internal/webui`, mirror `handleSetResourceMeta` (JSON body, `writeError`, `path` required), registered in `server.go` next to the other resource routes.
- **Share, don't duplicate** the URL-inference primitives: `prURLPattern` (`cmd/root.go`), `jira.ParseJiraURL` (`internal/jira/detect.go`), `slackurl.Parse` + `slackurl.ResourceID` (`internal/slackurl`).
- **Inferred id formats MUST match the CLI** so a UI-added and CLI-added resource collide on the same id:
  - PR: `fmt.Sprintf("%s/%s#%d", owner, repo, number)` (verbatim from `cmd/root.go:146`, e.g. `owner/repo#123`).
  - Jira: the issue key from `jira.ParseJiraURL` (already upper-cased), e.g. `RHOAIENG-123`.
  - Slack: `slackurl.ResourceID(channel, threadTS)` = `"<channel>:<thread_ts>"`.
- **Inline enrichment reuses the existing pollers** (`wgithub.Poll`/`wjira.Poll`/`wslack.Poll` with a single-element `[]watcher.Resource` slice) — the SAME functions `pollAll` calls. Missing creds / poll error → do NOT fail the add (subscription exists; background pollAll retries); log it.
- Remove is **hard `resources.Remove`** only. NO soft-`Unwatch` in the UI (semantics being reconsidered for Phase 5).
- Remove has a **confirm step** (Mantine popover), not one-click.
- Frontend refetch reuses `useWorktreeDetail`'s react-query `resources.refetch()` (queryKey `["resources", path]`).

---

### Task 1: Shared URL→resource inference helper

**Files:**
- Create: `internal/webui/inferresource.go`
- Test: `internal/webui/inferresource_test.go`

**Interfaces:**
- Produces (consumed by Task 2): `func inferResource(rawURL string) (resType, id string, ok bool)` in package `webui`.

**Note:** put it in `internal/webui` (the only consumer for now). It imports the existing primitives. Keeping the CLI's own dispatch (`cmd/add.go`) as-is is fine — do NOT refactor the CLI in this task; just don't duplicate the regexes (call the same exported primitives).

- [ ] **Step 1: Write the failing test**

`internal/webui/inferresource_test.go`:
```go
package webui

import "testing"

func TestInferResource(t *testing.T) {
	cases := []struct {
		url, wantType, wantID string
		wantOK                bool
	}{
		{"https://github.com/opendatahub-io/odh-dashboard/pull/9097", "pr", "opendatahub-io/odh-dashboard#9097", true},
		{"https://redhat.atlassian.net/browse/RHOAIENG-123", "jira", "RHOAIENG-123", true},
		{"https://x.slack.com/archives/C069KSM8T9N/p1787087256917159", "slack", "C069KSM8T9N:1787087256.917159", true},
		{"https://example.com/nope", "", "", false},
		{"", "", "", false},
	}
	for _, c := range cases {
		gotType, gotID, gotOK := inferResource(c.url)
		if gotType != c.wantType || gotID != c.wantID || gotOK != c.wantOK {
			t.Errorf("inferResource(%q) = (%q,%q,%v), want (%q,%q,%v)",
				c.url, gotType, gotID, gotOK, c.wantType, c.wantID, c.wantOK)
		}
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/mturley/git/worktree && go test ./internal/webui/ -run TestInferResource -v`
Expected: FAIL — `undefined: inferResource`.

- [ ] **Step 3: Implement**

`internal/webui/inferresource.go` — reuse the existing primitives (import `cmd`'s pattern is not possible since `prURLPattern` is unexported in package `cmd`; the PR regex is small — define it here mirroring `cmd/root.go:57` EXACTLY, with a comment pointing at the source of truth; Jira/Slack use the exported `jira.ParseJiraURL` / `slackurl.Parse`):
```go
package webui

import (
	"fmt"
	"regexp"
	"strconv"

	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/slackurl"
)

// prURLPattern mirrors cmd/root.go's prURLPattern (kept in sync — the CLI is
// the source of truth for the PR id format). Extracts owner/repo/number from a
// GitHub PR URL.
var prURLPattern = regexp.MustCompile(`github\.com/([^/]+)/([^/]+)/pull/(\d+)`)

// inferResource infers a worktree resource (type, id) from a pasted URL,
// matching the CLI's `worktree add` behavior so a UI-added and CLI-added
// resource share the same id. Returns ok=false for an unrecognized URL.
func inferResource(rawURL string) (resType, id string, ok bool) {
	if m := prURLPattern.FindStringSubmatch(rawURL); m != nil {
		number, _ := strconv.Atoi(m[3])
		return "pr", fmt.Sprintf("%s/%s#%d", m[1], m[2], number), true
	}
	if key, ok := jira.ParseJiraURL(rawURL); ok {
		return "jira", key, true
	}
	if ch, ts, ok := slackurl.Parse(rawURL); ok {
		return "slack", slackurl.ResourceID(ch, ts), true
	}
	return "", "", false
}
```
NOTE: verify `cmd/root.go`'s `prURLPattern` regex string still equals the one above; if it has diverged, match the CLI's. (A shared exported primitive would be cleaner but `cmd` importing `internal/webui` or vice-versa risks a cycle — a mirrored regex with a sync comment is the pragmatic choice; flag in your report if you find a clean way to share it.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/mturley/git/worktree && go test ./internal/webui/ -run TestInferResource -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mturley/git/worktree
git add internal/webui/inferresource.go internal/webui/inferresource_test.go
git commit --signoff -m "webui: shared URL->resource type/id inference helper"
```

---

### Task 2: `pollOne` helper (factor inline-enrichment out of pollAll)

**Files:**
- Modify: `internal/webui/poller.go` (extract a `pollOne` helper; `pollAll` may optionally use it but is NOT required to change behavior)

**Interfaces:**
- Produces (consumed by Task 3): `func (s *Server) pollOne(r watcher.Resource)` — loads creds (same as `pollAll`) and polls just that one resource via the matching library poller; logs + returns on missing creds / error (never panics, never fatal).

- [ ] **Step 1: Write the failing test**

`pollOne` does live network I/O when creds exist, so unit-testing the happy path is out of scope (matches how `pollAll` isn't unit-tested). Instead assert the **no-creds path is safe** — with an empty config it must not panic and must be a no-op. Add to `internal/webui/poller_test.go` (read it first for the Server+DB setup helper):
```go
func TestPollOne_NoCredsIsNoOp(t *testing.T) {
	// With no configured creds, pollOne must not panic and must not error out
	// the caller — it logs and returns. (We can't assert enrichment without
	// live creds; this guards the degenerate path the add endpoint relies on.)
	srv, conn := newTestServer(t) // match existing helper; if none, construct &Server{DB: conn, Logger: testLogger}
	_ = conn
	srv.pollOne(watcher.Resource{Type: "pr", ID: "o/r#1", URL: "https://github.com/o/r/pull/1"})
	// no panic, no assertion beyond reaching here
}
```
NOTE: adapt to whatever Server/DB test helper `poller_test.go` already uses. If constructing a Server with a nil-safe logger is awkward, set `srv.Logger` to a discard logger. The point is: pollOne with unconfigured creds is a safe no-op.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/mturley/git/worktree && go test ./internal/webui/ -run TestPollOne -v`
Expected: FAIL — `srv.pollOne undefined`.

- [ ] **Step 3: Implement**

In `internal/webui/poller.go`, add `pollOne` reusing the exact cred-loading + poller-call pattern from `pollAll` (`poller.go:61-100`), specialized to one resource by type:
```go
// pollOne polls a single resource through the matching library poller, so a
// freshly-added resource is enriched into resource_state before the add
// endpoint responds. Reuses the same creds + poller entry points as pollAll.
// Missing creds or a poll error are logged, never fatal (the background
// pollAll will retry).
func (s *Server) pollOne(r watcher.Resource) {
	cfg, err := wconfig.Load(wconfig.DefaultPath())
	if err != nil {
		s.logger().Printf("pollOne: load config: %v", err)
		return
	}
	one := []watcher.Resource{r}
	switch r.Type {
	case "pr":
		if gh, err := cfg.GitHub(); err == nil {
			if err := wgithub.Poll(s.DB, gh.Token, one, s.logger()); err != nil {
				s.logger().Printf("pollOne github: %v", err)
			}
		} else {
			s.logger().Printf("pollOne: github not configured")
		}
	case "jira":
		if jc, err := cfg.Jira(); err == nil {
			auth := wjira.JiraAuth{URL: jc.Host, Email: jc.Email, Token: jc.Token, CustomFields: jc.CustomFields}
			if bcfg, err := wconfig.LoadConfig(wconfig.ConfigDefaultPath()); err == nil {
				auth.BotUsernames = bcfg.JiraBotUsernames()
			}
			if err := wjira.Poll(s.DB, auth, one, s.logger()); err != nil {
				s.logger().Printf("pollOne jira: %v", err)
			}
		} else {
			s.logger().Printf("pollOne: jira not configured")
		}
	case "slack":
		if sc, err := cfg.Slack(); err == nil {
			auth := wslack.SlackAuth{Token: sc.Token, Cookie: sc.Cookie, WorkspaceDomain: sc.WorkspaceDomain}
			if err := wslack.Poll(s.DB, auth, one, s.logger()); err != nil {
				s.logger().Printf("pollOne slack: %v", err)
			}
		} else {
			s.logger().Printf("pollOne: slack not configured")
		}
	default:
		s.logger().Printf("pollOne: unknown resource type %q", r.Type)
	}
}
```
(Optional: refactor `pollAll`'s three blocks to build on this — NOT required; if it complicates the diff, leave `pollAll` as-is. The imports `wgithub`/`wjira`/`wslack`/`watcher`/`wconfig`/`watcherdb` are already in poller.go.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/mturley/git/worktree && go test ./internal/webui/ -run TestPollOne -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/mturley/git/worktree
git add internal/webui/poller.go internal/webui/poller_test.go
git commit --signoff -m "webui: pollOne helper to enrich a single resource (reuses pollAll's pollers)"
```

---

### Task 3: Add + Remove endpoints

**Files:**
- Create: `internal/webui/resource_mutate_api.go`
- Modify: `internal/webui/server.go` (register two routes)
- Test: `internal/webui/resource_mutate_api_test.go`

**Interfaces:**
- Consumes: `inferResource` (Task 1), `s.pollOne` (Task 2), `resources.Add`/`resources.Remove`, the DTO-building path (`resourceDTO` + `enrichResourceDTO`).
- Produces: `POST /api/worktree-resources/add` → `resourceDTO` (200); `POST /api/worktree-resources/remove` → 204.

- [ ] **Step 1: Write the failing tests**

Read `internal/webui/resource_meta_api_test.go` first for the server+DB+add-resource test setup pattern. Create `internal/webui/resource_mutate_api_test.go`:
```go
package webui

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestAddResource_Jira(t *testing.T) {
	ts, conn, wtPath := newTestServerWithWorktree(t) // match the existing helper shape
	_ = conn
	body := `{"path":"` + wtPath + `","url":"https://redhat.atlassian.net/browse/RHOAIENG-123"}`
	resp, err := http.Post(ts.URL+"/api/worktree-resources/add", "application/json", bytes.NewReader([]byte(body)))
	if err != nil { t.Fatal(err) }
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("add: got %d, want 200", resp.StatusCode)
	}
	// It should now appear in the resources list as a jira resource.
	r2, _ := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	buf := new(bytes.Buffer); buf.ReadFrom(r2.Body)
	if !strings.Contains(buf.String(), `"id":"RHOAIENG-123"`) || !strings.Contains(buf.String(), `"type":"jira"`) {
		t.Fatalf("resource not added: %s", buf.String())
	}
}

func TestAddResource_UnrecognizedURL(t *testing.T) {
	ts, _, wtPath := newTestServerWithWorktree(t)
	body := `{"path":"` + wtPath + `","url":"https://example.com/nope"}`
	resp, _ := http.Post(ts.URL+"/api/worktree-resources/add", "application/json", bytes.NewReader([]byte(body)))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", resp.StatusCode)
	}
}

func TestAddResource_MissingFields(t *testing.T) {
	ts, _, _ := newTestServerWithWorktree(t)
	resp, _ := http.Post(ts.URL+"/api/worktree-resources/add", "application/json", bytes.NewReader([]byte(`{"url":"x"}`)))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing path: got %d, want 400", resp.StatusCode)
	}
}

func TestRemoveResource(t *testing.T) {
	ts, conn, wtPath := newTestServerWithWorktree(t)
	addSlackResource(t, conn, wtPath, "C1:1700000000.000100", "https://x") // reuse existing helper
	body := `{"path":"` + wtPath + `","type":"slack","id":"C1:1700000000.000100"}`
	resp, _ := http.Post(ts.URL+"/api/worktree-resources/remove", "application/json", bytes.NewReader([]byte(body)))
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove: got %d, want 204", resp.StatusCode)
	}
	r2, _ := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	buf := new(bytes.Buffer); buf.ReadFrom(r2.Body)
	if strings.Contains(buf.String(), "C1:1700000000.000100") {
		t.Fatalf("resource still present after remove: %s", buf.String())
	}
}

func TestRemoveResource_MissingFields(t *testing.T) {
	ts, _, _ := newTestServerWithWorktree(t)
	resp, _ := http.Post(ts.URL+"/api/worktree-resources/remove", "application/json", bytes.NewReader([]byte(`{"path":"/x"}`)))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", resp.StatusCode)
	}
}
```
NOTE: adapt helper names to what `resource_meta_api_test.go` actually uses (it inlined `wdb.OpenAt`+`resources.Add`+`srv.Handler()` rather than shared helpers — match that). The Jira add test relies on `pollOne` being a safe no-op with no creds configured in the test env (Task 2), so the add still returns 200 and the subscription exists even though enrichment is skipped.

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/mturley/git/worktree && go test ./internal/webui/ -run 'TestAddResource|TestRemoveResource' -v`
Expected: FAIL — routes 404.

- [ ] **Step 3: Implement the handlers**

Create `internal/webui/resource_mutate_api.go`:
```go
package webui

import (
	"encoding/json"
	"net/http"

	"github.com/mturley/watcher"
	"github.com/mturley/worktree/internal/resources"
)

type addResourceRequest struct {
	Path    string `json:"path"`
	URL     string `json:"url"`
	Related bool   `json:"related"`
}

func (s *Server) handleAddResource(w http.ResponseWriter, r *http.Request) {
	var req addResourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" || req.URL == "" {
		writeError(w, http.StatusBadRequest, "missing path or url")
		return
	}
	resType, id, ok := inferResource(req.URL)
	if !ok {
		writeError(w, http.StatusBadRequest, "unrecognized resource URL")
		return
	}
	if err := resources.Add(s.DB, req.Path, resources.Resource{Type: resType, ID: id, URL: req.URL, Related: req.Related}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Inline-enrich (best effort): populate resource_state before responding.
	s.pollOne(watcher.Resource{Type: resType, ID: id, URL: req.URL})

	// Build the DTO for the newly-added resource (mirrors handleWorktreeResources).
	dto := resourceDTO{Type: resType, ID: id, URL: req.URL, Primary: !req.Related}
	s.enrichResourceDTO(&dto)
	writeJSON(w, http.StatusOK, dto)
}

type removeResourceRequest struct {
	Path string `json:"path"`
	Type string `json:"type"`
	ID   string `json:"id"`
}

func (s *Server) handleRemoveResource(w http.ResponseWriter, r *http.Request) {
	var req removeResourceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" || req.Type == "" || req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing path, type, or id")
		return
	}
	if err := resources.Remove(s.DB, req.Path, req.Type, req.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```
NOTE: confirm `resourceDTO`'s custom_name/description fields — the DTO here won't have them (a new resource has no meta), which is fine (omitempty). If you want parity, you may `resources.Load` + find the added one instead of hand-building the DTO; hand-building is leaner and sufficient. Confirm `enrichResourceDTO` is the method name (it is, from Phase 3b).

- [ ] **Step 4: Register the routes**

In `internal/webui/server.go`, next to the other resource routes:
```go
	mux.HandleFunc("POST /api/worktree-resources/add", s.handleAddResource)
	mux.HandleFunc("POST /api/worktree-resources/remove", s.handleRemoveResource)
```

- [ ] **Step 5: Run tests + full suite**

Run: `cd /Users/mturley/git/worktree && go test ./internal/webui/ -run 'TestAddResource|TestRemoveResource' -v && go test ./...`
Expected: PASS; full suite green.

- [ ] **Step 6: Commit**

```bash
cd /Users/mturley/git/worktree
git add internal/webui/resource_mutate_api.go internal/webui/server.go internal/webui/resource_mutate_api_test.go
git commit --signoff -m "webui: POST /api/worktree-resources/add + /remove endpoints"
```

---

### Task 4: Frontend API client methods

**Files:**
- Modify: `ui/src/api/client.ts`
- Test: `ui/src/api/client.test.ts` (extend)

**Interfaces:**
- Produces (consumed by Tasks 5-6): `api.addResource({path,url,related?}): Promise<ResourceDTO>`, `api.removeResource({path,type,id}): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Extend `ui/src/api/client.test.ts` (matches the existing `setResourceMeta` test style):
```ts
describe("api.addResource", () => {
  it("POSTs the url to /api/worktree-resources/add", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ type: "jira", id: "RHOAIENG-1" }) })
    vi.stubGlobal("fetch", fetchMock)
    await api.addResource({ path: "/w", url: "https://redhat.atlassian.net/browse/RHOAIENG-1" })
    expect(fetchMock).toHaveBeenCalledWith("/api/worktree-resources/add", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/w", url: "https://redhat.atlassian.net/browse/RHOAIENG-1" }),
    }))
  })
})

describe("api.removeResource", () => {
  it("POSTs type/id/path to /api/worktree-resources/remove", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => null })
    vi.stubGlobal("fetch", fetchMock)
    await api.removeResource({ path: "/w", type: "slack", id: "C1:1" })
    expect(fetchMock).toHaveBeenCalledWith("/api/worktree-resources/remove", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/w", type: "slack", id: "C1:1" }),
    }))
  })
})
```
(afterEach restoreAllMocks is already in the file.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/mturley/git/worktree/ui && npx vitest run src/api/client.test.ts`
Expected: FAIL — `api.addResource is not a function`.

- [ ] **Step 3: Implement**

In `ui/src/api/client.ts`, add to the `api` object:
```ts
  addResource: (args: { path: string; url: string; related?: boolean }) =>
    fetchJSON<ResourceDTO>("/api/worktree-resources/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  removeResource: (args: { path: string; type: string; id: string }) =>
    fetchJSON<null>("/api/worktree-resources/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
```
NOTE: the test asserts the body is `JSON.stringify({path,url})` WITHOUT `related` when not passed — since `args` omits `related` when undefined, `JSON.stringify` drops it. Good. (`ResourceDTO` is already imported in client.ts.)

- [ ] **Step 4: Run to verify it passes + tsc**

Run: `cd /Users/mturley/git/worktree/ui && npx vitest run src/api/client.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/mturley/git/worktree
git add ui/src/api/client.ts ui/src/api/client.test.ts
git commit --signoff -m "ui/api: add addResource + removeResource client methods"
```

---

### Task 5: Overview "Add resource" field + card remove control

**Files:**
- Modify: `ui/src/components/ResourceList.tsx` (add-resource field)
- Modify: `ui/src/components/ResourceCard.tsx` (remove control + confirm popover)
- Modify: `ui/src/pages/WorktreeDetailPage.tsx` (thread `path` + refetch into ResourceList/cards)
- Test: `ui/src/components/ResourceList.test.tsx`, `ui/src/components/ResourceCard.test.tsx` (extend)

**Interfaces:**
- Consumes: `api.addResource`/`api.removeResource` (Task 4); `useWorktreeDetail(path)` `resources.refetch()`.

- [ ] **Step 1: Read the current shapes**

Read `ui/src/components/ResourceList.tsx`, `ResourceCard.tsx`, `pages/WorktreeDetailPage.tsx`, and an existing component test (e.g. `ResourceCard.test.tsx`) for the render wrapper. Determine how `path` + a `refetch` reach these components (WorktreeDetailPage has `useWorktreeDetail(path)` → `resources.refetch`).

- [ ] **Step 2: Write the failing tests**

In `ui/src/components/ResourceList.test.tsx` (create if absent; wrap in MantineProvider + a QueryClient if needed, matching existing component tests):
```tsx
// Given an onAdd handler / api.addResource mock, typing a URL and clicking Add
// calls api.addResource with {path, url} and (on success) triggers refetch;
// a rejected add shows a dismissible error alert.
```
In `ui/src/components/ResourceCard.test.tsx`:
```tsx
// The remove control opens a confirm popover; confirming calls api.removeResource
// with {path, type, id} and triggers onRemoved/refetch; cancel does nothing.
```
Write concrete tests using `@testing-library/react` + `userEvent`, mocking `../api/client` (spread real + override addResource/removeResource), asserting the exact call args. Assert error-alert presence via `findByText` on the rejection message.

- [ ] **Step 3: Run to verify they fail**

Run: `cd /Users/mturley/git/worktree/ui && npx vitest run src/components/ResourceList.test.tsx src/components/ResourceCard.test.tsx`
Expected: FAIL (no add field / no remove control yet).

- [ ] **Step 4: Implement the Overview add field**

In `ResourceList.tsx`: add an "Add resource" row (Mantine `TextInput` placeholder "Paste a PR, Jira, or Slack URL" + `Button` "Add", disabled while empty or submitting). On submit: `await api.addResource({ path, url })` in a try/catch; on success clear the field + call the passed `onChanged`/`refetch`; on error set a dismissible `Alert` message (reuse the SlackTab save-error alert pattern). `ResourceList` gains props `path: string` and `onChanged: () => void` (or `refetch`).

- [ ] **Step 5: Implement the card remove control**

In `ResourceCard.tsx`: add a subtle trash/`×` `ActionIcon`. Wrap it in a Mantine `Popover` (or `Menu`) with a small "Remove this resource?" + Remove/Cancel confirmation. Confirm → `await api.removeResource({ path, type: r.type, id: r.id })` → call `onRemoved`/refetch. `ResourceCard` gains props `path: string` and `onRemoved: () => void`.

- [ ] **Step 6: Thread path + refetch in WorktreeDetailPage**

In `WorktreeDetailPage.tsx`: pass `path` and `resources.refetch` down to `ResourceList` (and through to each `ResourceCard`). Confirm `useWorktreeDetail` exposes `resources.refetch` (it does, from Phase 3b).

- [ ] **Step 7: Run tests + tsc + full frontend suite**

Run: `cd /Users/mturley/git/worktree/ui && npx vitest run src/components/ResourceList.test.tsx src/components/ResourceCard.test.tsx && npx tsc --noEmit && npx vitest run`
Expected: PASS, clean, full suite green.

- [ ] **Step 8: Commit**

```bash
cd /Users/mturley/git/worktree
git add ui/src/components/ResourceList.tsx ui/src/components/ResourceCard.tsx ui/src/pages/WorktreeDetailPage.tsx ui/src/components/ResourceList.test.tsx ui/src/components/ResourceCard.test.tsx
git commit --signoff -m "ui: add-resource field on Overview + confirm-popover remove on cards"
```

---

### Task 6: Slack tab `+` button

**Files:**
- Modify: `ui/src/components/SlackTab.tsx` (+ button → add flow)
- Test: `ui/src/components/SlackTab.test.tsx` (extend)

**Interfaces:**
- Consumes: `api.addResource` (Task 4); the SlackTab's existing `refetch`.

- [ ] **Step 1: Write the failing test**

Extend `ui/src/components/SlackTab.test.tsx`:
```tsx
// Clicking the + button opens an add input; entering a Slack URL and submitting
// calls api.addResource({ path, url: <the slack url> }) and triggers refetch.
```
Concrete test: mock `api.addResource`, click the `+` (by aria-label e.g. "Add Slack thread"), type a slack URL, submit, assert `api.addResource` called with `{path, url}` and the refetch mock fired.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/mturley/git/worktree/ui && npx vitest run src/components/SlackTab.test.tsx`
Expected: FAIL (no + button).

- [ ] **Step 3: Implement**

In `SlackTab.tsx`: add a `+` `ActionIcon`/`Button` (aria-label "Add Slack thread") at the top of the NavLink rail. Clicking opens a small Mantine `Modal` (or inline field) with a URL `TextInput` labeled "Paste a Slack thread URL" + Add. On submit: `await api.addResource({ path, url })` → refetch (SlackTab already has it) → close + clear; on error show a dismissible message. No slack-specific endpoint — the generic add infers `type:"slack"`.
Also update the empty-state text (currently `Add one with <worktree add <slack-thread-url>>`) to mention the `+` button.

- [ ] **Step 4: Run tests + tsc + full suite**

Run: `cd /Users/mturley/git/worktree/ui && npx vitest run src/components/SlackTab.test.tsx && npx tsc --noEmit && npx vitest run`
Expected: PASS, clean, full suite green.

- [ ] **Step 5: Commit**

```bash
cd /Users/mturley/git/worktree
git add ui/src/components/SlackTab.tsx ui/src/components/SlackTab.test.tsx
git commit --signoff -m "ui/slack: + button to add a thread from the Slack tab"
```

---

### Task 7: Full build + docs

**Files:**
- Modify: `docs/web-ui-architecture.md` (document the two mutation endpoints + the add/remove UI)

- [ ] **Step 1: Full build**

Run: `cd /Users/mturley/git/worktree && make build`
Expected: clean.

- [ ] **Step 2: Full test**

Run: `cd /Users/mturley/git/worktree && make test`
Expected: Go + vitest green.

- [ ] **Step 3: Docs**

In `docs/web-ui-architecture.md`, in the routes section add `POST /api/worktree-resources/add` (`{path,url,related?}` → resourceDTO; infers type/id from the URL, inline-enriches via pollOne) and `POST /api/worktree-resources/remove` (`{path,type,id}` → 204, hard remove). Note the frontend: Overview "Add resource" URL field, confirm-popover remove on cards, Slack-tab `+` button; all refetch via useWorktreeDetail. Note Unwatch is intentionally NOT in the UI (Phase-5 semantics pending).

- [ ] **Step 4: Commit**

```bash
cd /Users/mturley/git/worktree
git add docs/web-ui-architecture.md
git commit --signoff -m "docs: add/remove resource endpoints + UI"
```

---

## Notes for the executor
- All tasks are worktree-only (no cross-repo/library change). No new watcher release.
- Task order: 1→2→3 (backend, each builds on the prior), then 4 (client), 5+6 (UI, both depend on 4; independent of each other — 5 touches ResourceList/ResourceCard/WorktreeDetailPage, 6 touches SlackTab), 7 (build+docs).
- Do NOT add a soft-Unwatch control (Phase-5 semantics unsettled).
- The PR-id-format match is load-bearing (a UI-added PR must share the CLI's id) — verify against `cmd/root.go:146`.
