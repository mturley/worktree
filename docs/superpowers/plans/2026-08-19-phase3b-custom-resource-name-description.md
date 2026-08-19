# Custom Resource Name/Description Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the lost "custom thread name/description" feature by persisting user-supplied `custom_name`/`custom_description` per resource in the watcher library and surfacing them in worktree's Slack tab (rail + header) and Overview resource card.

**Architecture:** The watcher library gains a per-resource `watcher_resource_meta` table (keyed `(resource_type, resource_id)`, columns `custom_name`/`custom_description`) plus a typed `ResourceMeta` struct and `Set/GetResourceMeta` accessors — released as v0.2.8. worktree re-pins that release, decorates its `resources.Resource` with the custom fields on load, exposes a `POST /api/resource-meta` write endpoint, and wires the existing (currently no-op) Slack "Edit thread details" modal to persist + refetch. Fallback logic (empty custom value → platform name / first-message preview) lives entirely in the worktree consumer, never the library.

**Tech Stack:** Go (watcher lib + worktree backend), SQLite, React 19 + Mantine + Vite + vitest (worktree frontend).

**Spec:** No separate spec doc — this plan implements the design approved in-session on 2026-08-19 (bug-fix round before Phase 3b). The design decisions are captured verbatim in the Global Constraints below and in `~/.claude/projects/-Users-mturley-git-worktree/memory/watcher-ui-roadmap.md` (Phase 3b defer note).

## Global Constraints

- **Cross-repo protocol (CLAUDE.md "Watcher library"):** the library change lands in `~/git/watcher` FIRST — change + tests (`go test ./...`) → commit → verify the COMMITTED tree builds+tests green in an ISOLATED detached worktree (the v0.2.6 lesson: a dirty working tree can mask a broken committed tree) → tag `v0.2.8` → `git push origin main && git push origin v0.2.8`. Only then re-pin in worktree.
- **The library is also consumed by agent-handler** — the new table/API must be additive and not break existing consumers. New table only; do NOT alter existing `watcher_*` tables.
- **Column names are exactly `custom_name` and `custom_description`** (the `custom_` prefix signals they are often empty and the consumer falls back to the platform's own name). Go struct fields are `CustomName` / `CustomDescription`.
- **Scope is per-RESOURCE**, keyed `(resource_type, resource_id)` — one label per resource, NOT per subscriber. New table `watcher_resource_meta`, separate from `watcher_resource_state` (which is poller-overwritten).
- **Typed struct, not a key/value bag.** Exactly two fields.
- **Empty string clears a field.** `SetResourceMeta(conn, r, "", "")` stores empty strings; `GetResourceMeta` returns `nil` only when no row exists at all.
- **All fallback logic stays in the worktree consumer.** The library stores/returns raw custom values only.
- **Overview resource card fallback = raw `channel:ts` for now** when `custom_name` is empty. A real Slack fallback title (truncated first message) is DEFERRED to Phase 4 / the poller-rethink — do NOT add `case "slack"` polling/enrichment in this plan.
- **Never auto-mark threads read** and **writes are optimistic + rolled back on failure** (existing Slack conventions — unaffected here but don't regress them).
- **watcher `CurrentSchemaVersion` must be bumped** (currently 2 → 3) so already-migrated DBs pick up the new table (Migrate short-circuits when the recorded version already equals the constant).

---

### Task 1: Add `watcher_resource_meta` table + `ResourceMeta` API to the watcher library

**Repo:** `~/git/watcher` (NOT worktree).

**Files:**
- Modify: `~/git/watcher/db/schema.go` (add table to `schemaDDL`, `managedTables`, `managedColumns`; bump `CurrentSchemaVersion` 2→3)
- Create: `~/git/watcher/db/resourcemeta.go`
- Test: `~/git/watcher/db/resourcemeta_test.go`

**Interfaces:**
- Consumes: existing `watcher.Resource{Type, ID, URL}` (`~/git/watcher/watcher.go`); existing `db.Migrate(conn)` flow.
- Produces (consumed by Task 3):
  - `type ResourceMeta struct { CustomName string; CustomDescription string }`
  - `func SetResourceMeta(conn *sql.DB, r watcher.Resource, name, description string) error`
  - `func GetResourceMeta(conn *sql.DB, resourceType, resourceID string) (*ResourceMeta, error)` — returns `(nil, nil)` when no row exists.

- [ ] **Step 1: Write the failing test**

Create `~/git/watcher/db/resourcemeta_test.go`. Follow the existing test setup pattern in `~/git/watcher/db/resourcestate_test.go` for opening an in-memory DB and running `Migrate` (read that file first to match the exact helper, e.g. `openTestDB(t)` or `sql.Open("sqlite3", ":memory:")` + `Migrate`).

```go
package db

import (
	"testing"

	"github.com/mturley/watcher"
)

func TestResourceMeta_SetGet(t *testing.T) {
	conn := newTestDB(t) // match the helper used by resourcestate_test.go
	r := watcher.Resource{Type: "slack", ID: "C123:1700000000.000100"}

	// Absent -> nil, nil
	got, err := GetResourceMeta(conn, r.Type, r.ID)
	if err != nil {
		t.Fatalf("GetResourceMeta(absent): %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for absent meta, got %+v", got)
	}

	// Set -> Get returns values
	if err := SetResourceMeta(conn, r, "Release blocker", "Tracking the e2e regression"); err != nil {
		t.Fatalf("SetResourceMeta: %v", err)
	}
	got, err = GetResourceMeta(conn, r.Type, r.ID)
	if err != nil {
		t.Fatalf("GetResourceMeta: %v", err)
	}
	if got == nil || got.CustomName != "Release blocker" || got.CustomDescription != "Tracking the e2e regression" {
		t.Fatalf("unexpected meta: %+v", got)
	}

	// Upsert overwrites
	if err := SetResourceMeta(conn, r, "Renamed", ""); err != nil {
		t.Fatalf("SetResourceMeta(upsert): %v", err)
	}
	got, _ = GetResourceMeta(conn, r.Type, r.ID)
	if got.CustomName != "Renamed" || got.CustomDescription != "" {
		t.Fatalf("upsert did not overwrite: %+v", got)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/git/watcher && go test ./db/ -run TestResourceMeta_SetGet -v`
Expected: FAIL — `undefined: SetResourceMeta` / `undefined: GetResourceMeta` / `undefined: ResourceMeta` (and/or the `newTestDB` helper name if it differs — fix the helper name to match `resourcestate_test.go`, then it should fail on the undefined functions).

- [ ] **Step 3: Add the table to the schema**

In `~/git/watcher/db/schema.go`:

(a) Bump the version constant and update its comment:
```go
// Bumped to 3 to add watcher_resource_meta below. The bump is required
// even though the table is purely additive and schemaDDL is idempotent:
// Migrate short-circuits and skips re-running schemaDDL entirely when the
// recorded version already equals CurrentSchemaVersion, so a database
// already at version 2 would never create the new table without this bump.
// A brand-new table is not part of managedColumns' collision check for
// existing tables, so this doesn't interact with checkForCollisions beyond
// adding the table to the managed set.
const CurrentSchemaVersion = 3
```

(b) Add the table name to `managedTables`:
```go
var managedTables = []string{
	"watcher_schema_version", "watcher_events", "watcher_event_resources",
	"watcher_resource_state", "watcher_subscriptions",
	"watcher_resource_relationships", "watcher_poller_status",
	"watcher_resource_meta",
}
```

(c) Add its columns to `managedColumns`:
```go
	"watcher_resource_meta": {
		"resource_type", "resource_id", "custom_name", "custom_description",
	},
```

(d) Add the `CREATE TABLE` to the `schemaDDL` string (place it after the `watcher_resource_state` block):
```sql
CREATE TABLE IF NOT EXISTS watcher_resource_meta (
	resource_type TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	custom_name TEXT,
	custom_description TEXT,
	PRIMARY KEY (resource_type, resource_id)
);
```

- [ ] **Step 4: Implement the accessors**

Create `~/git/watcher/db/resourcemeta.go`:
```go
package db

import (
	"database/sql"
	"fmt"

	"github.com/mturley/watcher"
)

// ResourceMeta holds user-supplied presentation metadata for a resource.
// Both fields are commonly empty; consumers fall back to the platform's own
// name (e.g. PR/Jira title, or a Slack thread's first message) when empty.
type ResourceMeta struct {
	CustomName        string
	CustomDescription string
}

// SetResourceMeta upserts the custom name/description for a resource. Empty
// strings are stored as-is (passing "" clears a field). Keyed per resource
// (resource_type, resource_id), independent of any subscriber.
func SetResourceMeta(conn *sql.DB, r watcher.Resource, name, description string) error {
	_, err := conn.Exec(`
		INSERT INTO watcher_resource_meta (resource_type, resource_id, custom_name, custom_description)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(resource_type, resource_id) DO UPDATE SET
			custom_name = excluded.custom_name,
			custom_description = excluded.custom_description
	`, r.Type, r.ID, name, description)
	if err != nil {
		return fmt.Errorf("failed to upsert resource meta: %w", err)
	}
	return nil
}

// GetResourceMeta returns the custom metadata for a resource, or nil if no
// row exists (never set).
func GetResourceMeta(conn *sql.DB, resourceType, resourceID string) (*ResourceMeta, error) {
	var m ResourceMeta
	err := conn.QueryRow(`
		SELECT custom_name, custom_description
		FROM watcher_resource_meta
		WHERE resource_type = ? AND resource_id = ?
	`, resourceType, resourceID).Scan(&m.CustomName, &m.CustomDescription)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get resource meta: %w", err)
	}
	return &m, nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/git/watcher && go test ./db/ -run TestResourceMeta -v`
Expected: PASS.

- [ ] **Step 6: Run the full watcher test suite**

Run: `cd ~/git/watcher && go test ./...`
Expected: PASS (the schema-version bump must not break existing migration tests; if a migration test asserts the version number, update it to 3).

- [ ] **Step 7: Commit**

```bash
cd ~/git/watcher
git add db/schema.go db/resourcemeta.go db/resourcemeta_test.go
git commit --signoff -m "db: add watcher_resource_meta for custom name/description

Per-resource user-supplied custom_name/custom_description, keyed
(resource_type, resource_id). Typed ResourceMeta struct + Set/GetResourceMeta.
Bumps schema version 2->3. Additive; existing consumers unaffected."
```

---

### Task 2: Release watcher v0.2.8 (verify committed tree in isolation, then tag + push)

**Repo:** `~/git/watcher`.

**Files:** none (release mechanics only).

**Interfaces:**
- Consumes: Task 1's committed change on `~/git/watcher` main.
- Produces: pushed tag `v0.2.8` (consumed by Task 3's `go get`).

- [ ] **Step 1: Verify the COMMITTED tree in an isolated detached worktree**

This guards against a dirty working tree masking a broken committed tree (the v0.2.6 lesson). Do NOT skip.
```bash
cd ~/git/watcher
git worktree add --detach /tmp/watcher-verify-v028 HEAD
cd /tmp/watcher-verify-v028
go build ./... && go test ./...
```
Expected: build + all tests PASS in the isolated checkout.

- [ ] **Step 2: Clean up the verification worktree**

```bash
cd ~/git/watcher
git worktree remove /tmp/watcher-verify-v028
```

- [ ] **Step 3: Tag and push (main + tag)**

```bash
cd ~/git/watcher
git tag v0.2.8
git push origin main
git push origin v0.2.8
```
Expected: both pushes succeed. (Pushing the tag is an outward-facing action — the controller has session-level approval to push this round, but announce it in the ledger.)

- [ ] **Step 4: Confirm the tag is on the remote**

Run: `cd ~/git/watcher && git ls-remote --tags origin v0.2.8`
Expected: prints a ref line for `refs/tags/v0.2.8`.

---

### Task 3: Re-pin watcher v0.2.8 and decorate `resources.Resource` with custom fields

**Repo:** `~/git/worktree`.

**Files:**
- Modify: `~/git/worktree/go.mod`, `~/git/worktree/go.sum` (via `go get`)
- Modify: `~/git/worktree/internal/resources/resources.go`
- Test: `~/git/worktree/internal/resources/resources_test.go` (add cases; create if absent)

**Interfaces:**
- Consumes: Task 1's `watcherdb.GetResourceMeta(conn, type, id) (*ResourceMeta, error)` and `watcherdb.SetResourceMeta(conn, r, name, desc) error`.
- Produces (consumed by Task 4):
  - `Resource` gains `CustomName string` and `CustomDescription string`.
  - `func SetMeta(conn *sql.DB, resType, id, name, description string) error`.

- [ ] **Step 1: Re-pin the library**

```bash
cd ~/git/worktree
go get github.com/mturley/watcher@v0.2.8
go mod tidy
```
Expected: `go.mod` now shows `github.com/mturley/watcher v0.2.8`.

- [ ] **Step 2: Write the failing test**

In `~/git/worktree/internal/resources/resources_test.go` (read the existing file first to match its DB-setup helper — it likely opens via `internal/db`'s test helper and creates a worktree subscriber). Add:
```go
func TestSetMetaAndLoadDecorates(t *testing.T) {
	conn := newTestDB(t)          // match the helper used elsewhere in this file
	wt := "/tmp/wt-meta-test"

	if err := Add(conn, wt, Resource{Type: "slack", ID: "C1:1700000000.000100", URL: "https://x"}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := SetMeta(conn, "slack", "C1:1700000000.000100", "Release blocker", "e2e regression"); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}
	rs, err := Load(conn, wt)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(rs) != 1 {
		t.Fatalf("expected 1 resource, got %d", len(rs))
	}
	if rs[0].CustomName != "Release blocker" || rs[0].CustomDescription != "e2e regression" {
		t.Fatalf("Load did not decorate custom meta: %+v", rs[0])
	}
}

func TestLoadNoMetaLeavesEmpty(t *testing.T) {
	conn := newTestDB(t)
	wt := "/tmp/wt-meta-test2"
	if err := Add(conn, wt, Resource{Type: "slack", ID: "C2:1700000000.000200", URL: "https://y"}); err != nil {
		t.Fatalf("Add: %v", err)
	}
	rs, _ := Load(conn, wt)
	if rs[0].CustomName != "" || rs[0].CustomDescription != "" {
		t.Fatalf("expected empty custom meta, got %+v", rs[0])
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/git/worktree && go test ./internal/resources/ -run 'TestSetMeta|TestLoadNoMeta' -v`
Expected: FAIL — `rs[0].CustomName undefined` and `undefined: SetMeta`.

- [ ] **Step 4: Add the struct fields**

In `~/git/worktree/internal/resources/resources.go`, extend the `Resource` struct:
```go
type Resource struct {
	Type              string // "pr", "jira", "slack"
	ID                string // "owner/repo#123" or "RHOAIENG-456" or "<channel>:<thread_ts>"
	URL               string
	Related           bool   // true when NOT the primary resource of its type
	CustomName        string // user-supplied; empty => consumer falls back to platform name
	CustomDescription string // user-supplied; empty => no description
}
```

- [ ] **Step 5: Decorate in `Load`**

In `Load`, after the `primary` map is built and inside the `for _, s := range subs` loop, look up meta per resource and populate the new fields. Replace the append block:
```go
	var out []Resource
	for _, s := range subs {
		key := s.Resource.Type + "\x00" + s.Resource.ID
		r := Resource{
			Type:    s.Resource.Type,
			ID:      s.Resource.ID,
			URL:     s.Resource.URL,
			Related: !primary[key], // absent flag => related (not primary)
		}
		meta, err := watcherdb.GetResourceMeta(conn, s.Resource.Type, s.Resource.ID)
		if err != nil {
			return nil, err
		}
		if meta != nil {
			r.CustomName = meta.CustomName
			r.CustomDescription = meta.CustomDescription
		}
		out = append(out, r)
	}
	return out, nil
```

- [ ] **Step 6: Add `SetMeta`**

Add to `resources.go` (near `Add`/`Unwatch`):
```go
// SetMeta upserts the user-supplied custom name/description for a resource.
// Custom metadata is per-resource (not per-worktree), so worktreePath is not
// needed. Empty strings clear the respective field.
func SetMeta(conn *sql.DB, resType, id, name, description string) error {
	return watcherdb.SetResourceMeta(conn, watcher.Resource{Type: resType, ID: id}, name, description)
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd ~/git/worktree && go test ./internal/resources/ -v`
Expected: PASS.

- [ ] **Step 8: Build to confirm the re-pin is consistent**

Run: `cd ~/git/worktree && go build ./...`
Expected: builds clean.

- [ ] **Step 9: Commit**

```bash
cd ~/git/worktree
git add go.mod go.sum internal/resources/resources.go internal/resources/resources_test.go
git commit --signoff -m "resources: carry custom name/description from watcher_resource_meta

Re-pin watcher v0.2.8. Load decorates each Resource with CustomName/
CustomDescription via GetResourceMeta; add SetMeta writer."
```

---

### Task 4: Expose custom fields in the resources DTO + `POST /api/resource-meta` write endpoint

**Repo:** `~/git/worktree`.

**Files:**
- Modify: `~/git/worktree/internal/webui/resources_api.go` (add DTO fields + populate)
- Create: `~/git/worktree/internal/webui/resource_meta_api.go` (the write handler)
- Modify: `~/git/worktree/internal/webui/server.go` (register the route)
- Test: `~/git/worktree/internal/webui/resource_meta_api_test.go`

**Interfaces:**
- Consumes: Task 3's `resources.SetMeta(conn, resType, id, name, description)` and the decorated `resources.Load`.
- Produces (consumed by Task 5):
  - `resourceDTO` gains `CustomName string` (json `custom_name,omitempty`) and `CustomDescription string` (json `custom_description,omitempty`).
  - Route `POST /api/resource-meta` accepting JSON body `{"type","id","name","description"}` → 204 on success, 400 on missing `type`/`id`, 500 on DB error.

- [ ] **Step 1: Write the failing test**

Read `~/git/worktree/internal/webui/resources_api_test.go` first to match the test-server + DB setup helper (e.g. `newTestServer(t)` returning `*httptest.Server` + a `*sql.DB`, and a helper to add a worktree resource). Create `~/git/worktree/internal/webui/resource_meta_api_test.go`:
```go
package webui

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestSetResourceMetaThenLoad(t *testing.T) {
	ts, conn, wtPath := newTestServerWithWorktree(t) // match existing helper name/shape
	// Add a slack resource to the worktree (reuse the helper resources_api_test.go uses).
	addSlackResource(t, conn, wtPath, "C1:1700000000.000100", "https://x")

	body := `{"type":"slack","id":"C1:1700000000.000100","name":"Release blocker","description":"e2e"}`
	resp, err := http.Post(ts.URL+"/api/resource-meta", "application/json", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatalf("POST resource-meta: %v", err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", resp.StatusCode)
	}

	// The GET resources endpoint should now include custom_name.
	resp2, _ := http.Get(ts.URL + "/api/worktree-resources?path=" + url.QueryEscape(wtPath))
	defer resp2.Body.Close()
	var got string
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp2.Body)
	got = buf.String()
	if !strings.Contains(got, `"custom_name":"Release blocker"`) {
		t.Fatalf("resources JSON missing custom_name: %s", got)
	}
}

func TestSetResourceMetaMissingFields(t *testing.T) {
	ts, _, _ := newTestServerWithWorktree(t)
	resp, _ := http.Post(ts.URL+"/api/resource-meta", "application/json",
		bytes.NewReader([]byte(`{"name":"x"}`)))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing type/id, got %d", resp.StatusCode)
	}
}
```
NOTE for the implementer: if `resources_api_test.go` does not already have `newTestServerWithWorktree`/`addSlackResource` helpers, adapt these tests to whatever setup helpers exist there (open a DB via the `internal/db` test helper, construct `&Server{DB: conn}`, wrap with the mux from `registerAPI`/the server's handler, call `resources.Add`). Keep the two assertions (204 + custom_name present; 400 on missing type/id).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/git/worktree && go test ./internal/webui/ -run TestSetResourceMeta -v`
Expected: FAIL — 404 (route not registered) / missing `custom_name` in JSON.

- [ ] **Step 3: Add the DTO fields**

In `~/git/worktree/internal/webui/resources_api.go`, add to `resourceDTO` (after `Primary`):
```go
	CustomName        string `json:"custom_name,omitempty"`
	CustomDescription string `json:"custom_description,omitempty"`
```
And in `handleWorktreeResources`, populate them when building each `dto`:
```go
		dto := resourceDTO{
			Type: res.Type, ID: res.ID, URL: res.URL, Primary: !res.Related,
			CustomName: res.CustomName, CustomDescription: res.CustomDescription,
		}
```

- [ ] **Step 4: Implement the write handler**

Create `~/git/worktree/internal/webui/resource_meta_api.go`:
```go
package webui

import (
	"encoding/json"
	"net/http"

	"github.com/mturley/worktree/internal/resources"
)

type resourceMetaRequest struct {
	Type        string `json:"type"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// handleSetResourceMeta persists a user-supplied custom name/description for a
// resource. Metadata is per-resource, so no worktree path is required.
func (s *Server) handleSetResourceMeta(w http.ResponseWriter, r *http.Request) {
	var req resourceMetaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Type == "" || req.ID == "" {
		writeError(w, http.StatusBadRequest, "missing type or id")
		return
	}
	if err := resources.SetMeta(s.DB, req.Type, req.ID, req.Name, req.Description); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 5: Register the route**

In `~/git/worktree/internal/webui/server.go`, next to the other `mux.HandleFunc(...)` registrations (e.g. beside `GET /api/worktree-resources`), add:
```go
	mux.HandleFunc("POST /api/resource-meta", s.handleSetResourceMeta)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ~/git/worktree && go test ./internal/webui/ -run TestSetResourceMeta -v`
Expected: PASS.

- [ ] **Step 7: Run the full backend suite**

Run: `cd ~/git/worktree && go test ./...`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd ~/git/worktree
git add internal/webui/resources_api.go internal/webui/resource_meta_api.go internal/webui/server.go internal/webui/resource_meta_api_test.go
git commit --signoff -m "webui: expose custom_name/description + POST /api/resource-meta

DTO now carries custom_name/custom_description; new write endpoint persists
user-supplied name/description via resources.SetMeta."
```

---

### Task 5: Frontend API client + types for resource meta

**Repo:** `~/git/worktree`.

**Files:**
- Modify: `~/git/worktree/ui/src/api/types.ts` (add DTO fields)
- Modify: `~/git/worktree/ui/src/api/client.ts` (add `setResourceMeta`)
- Test: `~/git/worktree/ui/src/api/client.test.ts` (create; verify request shape)

**Interfaces:**
- Consumes: Task 4's `POST /api/resource-meta` and the `custom_name`/`custom_description` DTO fields.
- Produces (consumed by Task 6):
  - `ResourceDTO` gains `custom_name?: string` and `custom_description?: string`.
  - `api.setResourceMeta(args: { type: string; id: string; name: string; description: string }): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `~/git/worktree/ui/src/api/client.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest"
import { api } from "./client"

afterEach(() => vi.restoreAllMocks())

describe("api.setResourceMeta", () => {
  it("POSTs the meta payload to /api/resource-meta", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => null })
    vi.stubGlobal("fetch", fetchMock)

    await api.setResourceMeta({ type: "slack", id: "C1:1", name: "n", description: "d" })

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/resource-meta",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "slack", id: "C1:1", name: "n", description: "d" }),
      }),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/git/worktree/ui && npx vitest run src/api/client.test.ts`
Expected: FAIL — `api.setResourceMeta is not a function`.

- [ ] **Step 3: Add the DTO fields**

In `~/git/worktree/ui/src/api/types.ts`, add to `ResourceDTO` (after `updated_at?`):
```ts
  custom_name?: string
  custom_description?: string
```

- [ ] **Step 4: Add the client method**

In `~/git/worktree/ui/src/api/client.ts`, add to the `api` object (note the existing `fetchJSON` returns parsed JSON; the endpoint returns 204/no body, which `fetchJSON` handles via its `.catch(() => null)`):
```ts
  setResourceMeta: (args: { type: string; id: string; name: string; description: string }) =>
    fetchJSON<null>("/api/resource-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ~/git/worktree/ui && npx vitest run src/api/client.test.ts`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `cd ~/git/worktree/ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/git/worktree
git add ui/src/api/types.ts ui/src/api/client.ts ui/src/api/client.test.ts
git commit --signoff -m "ui/api: add setResourceMeta + custom_name/description on ResourceDTO"
```

---

### Task 6: Wire the Slack "Edit thread details" modal to persist + surface custom name/description

**Repo:** `~/git/worktree`.

**Files:**
- Modify: `~/git/worktree/ui/src/hooks/useWorktreeSlackThreads.ts` (carry custom fields through)
- Modify: `~/git/worktree/ui/src/components/SlackTab.tsx` (real `onUpdateTab`; feed custom name/description into tabs; rail label)
- Test: `~/git/worktree/ui/src/components/SlackTab.test.tsx` (create)

**Interfaces:**
- Consumes: Task 5's `api.setResourceMeta(...)` and `ResourceDTO.custom_name/custom_description`; existing `useWorktreeDetail(path)` which exposes `resources` (a react-query result with `.data` and `.refetch()`); existing `ThreadView` prop `onUpdateTab: (id, { name, description }) => void`; existing `defaultTabName(channel, threadTs)` and `type Tab { id, channel, threadTs, name, description }` from `../state/tabs`.
- Produces: a working persist path (modal Save → `api.setResourceMeta` → refetch) and custom name/description shown in the rail label + thread header.

- [ ] **Step 1: Carry custom fields through the hook**

In `~/git/worktree/ui/src/hooks/useWorktreeSlackThreads.ts`, add the two optional fields to `SlackThreadRef` and map them from the resource:
```ts
export interface SlackThreadRef {
  channel: string
  threadTs: string
  url: string
  id: string
  customName?: string
  customDescription?: string
}
```
and in the `.map`:
```ts
  return slack.map((r) => {
    const [channel, threadTs] = r.id.split(":")
    return {
      channel, threadTs, url: r.url, id: r.id,
      customName: r.custom_name,
      customDescription: r.custom_description,
    }
  })
```

- [ ] **Step 2: Write the failing test**

Create `~/git/worktree/ui/src/components/SlackTab.test.tsx`. This test renders `SlackTab`, so it needs the app's providers. Read an existing component test (e.g. `WorktreeList.test.tsx` from Task 11 of Phase 3) to copy the render wrapper (MantineProvider + QueryClientProvider) and the `api` mock pattern. The assertions to keep:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { renderWithProviders } from "../test-utils" // match the helper used by other component tests
import { SlackTab } from "./SlackTab"
import { api } from "../api/client"

vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api } }
})

describe("SlackTab custom name", () => {
  beforeEach(() => {
    vi.spyOn(api, "worktreeResources").mockResolvedValue([
      { type: "slack", id: "C1:1700000000.000100", url: "https://x", primary: false, custom_name: "Release blocker" } as any,
    ])
    vi.spyOn(api, "worktreeTimeline").mockResolvedValue({ events: [], next_cursor: "" })
    vi.spyOn(api, "setResourceMeta").mockResolvedValue(null as any)
  })

  it("shows the custom name in the rail instead of channel:ts", async () => {
    renderWithProviders(<SlackTab path="/wt" />)
    await waitFor(() => expect(screen.getByText("Release blocker")).toBeInTheDocument())
    expect(screen.queryByText("C1:1700000000.000100")).not.toBeInTheDocument()
  })
})
```
NOTE: the ThreadView will try to fetch the thread via `useThread`; mock whatever `useThread` calls (likely a `getThread` on the slack api module) to resolve to an empty thread so the header renders without a live network call. Match the existing Slack test mocks if any exist under `ui/src/components/slack/`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ~/git/worktree/ui && npx vitest run src/components/SlackTab.test.tsx`
Expected: FAIL — the rail shows `C1:1700000000.000100` (the current `defaultTabName`) rather than `Release blocker`.

- [ ] **Step 4: Feed custom name/description into the tab derivation**

In `~/git/worktree/ui/src/components/SlackTab.tsx`, replace `threadRefToTab` so custom values win when present:
```tsx
function threadRefToTab(ref: SlackThreadRef): Tab {
  return {
    id: ref.id,
    channel: ref.channel,
    threadTs: ref.threadTs,
    name: ref.customName || defaultTabName(ref.channel, ref.threadTs),
    description: ref.customDescription || "",
  }
}
```
(The header's existing `hasCustomTitle = tab.name !== defaultTabName(...)` logic then lights up automatically when a custom name is set; when empty it falls back to `defaultTabName` and — in the header — the first-message preview, unchanged.)

- [ ] **Step 5: Replace the no-op `onUpdateTab` with a real persist + refetch**

In `SlackTab.tsx`: obtain the resources query so we can refetch after a write. `useWorktreeSlackThreads` currently derives from `useWorktreeDetail` internally; to get `refetch`, call `useWorktreeDetail(path)` here for its `resources.refetch`, or have `useWorktreeSlackThreads` also return a `refetch`. Minimal approach — import the detail hook and the api client at the top:
```tsx
import { api } from "../api/client"
import { useWorktreeDetail } from "../hooks/useWorktreeDetail"
```
Inside the component, after `const threads = useWorktreeSlackThreads(path)`:
```tsx
  const { resources } = useWorktreeDetail(path)
```
Then replace `onUpdateTab={() => {}}` with:
```tsx
            onUpdateTab={async (id, updates) => {
              const [type] = ["slack"] // slack tab only manages slack resources
              await api.setResourceMeta({
                type: "slack",
                id,
                name: updates.name,
                description: updates.description,
              })
              await resources.refetch()
            }}
```
NOTE: `useWorktreeDetail(path)` and `useWorktreeSlackThreads(path)` both call `useWorktreeDetail` under the hood; react-query dedupes by query key so this is a shared cache entry, and `resources.refetch()` updates both. Verify `useWorktreeDetail` returns `resources` as a query object with `.refetch()` (read the hook); if it returns plain data, add a `refetch` passthrough there instead.

- [ ] **Step 6: Use the custom name for the rail label**

Still in `SlackTab.tsx`, the `NavLink` label already calls `threadRefToTab(t).name`, which now returns the custom name when set — no change needed beyond Step 4. Confirm the `label={threadRefToTab(t).name}` line is present and unchanged.

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd ~/git/worktree/ui && npx vitest run src/components/SlackTab.test.tsx`
Expected: PASS.

- [ ] **Step 8: Type-check + full frontend tests**

Run: `cd ~/git/worktree/ui && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 9: Commit**

```bash
cd ~/git/worktree
git add ui/src/hooks/useWorktreeSlackThreads.ts ui/src/components/SlackTab.tsx ui/src/components/SlackTab.test.tsx
git commit --signoff -m "ui/slack: persist + show custom thread name/description

Edit-thread-details modal now writes via api.setResourceMeta and refetches;
custom name/description flow into the rail label and thread header (falling
back to channel:ts / first-message preview when empty)."
```

---

### Task 7: Show custom name on the Overview resource card

**Repo:** `~/git/worktree`.

**Files:**
- Modify: `~/git/worktree/ui/src/components/ResourceCard.tsx` (`SlackCardBody`)
- Test: `~/git/worktree/ui/src/components/ResourceCard.test.tsx` (create or extend)

**Interfaces:**
- Consumes: Task 5's `ResourceDTO.custom_name`.
- Produces: `SlackCardBody` shows `custom_name` when set, else the raw `id` (`channel:ts`) — the deliberate deferred fallback.

- [ ] **Step 1: Write the failing test**

Create/extend `~/git/worktree/ui/src/components/ResourceCard.test.tsx` (wrap in `MantineProvider` — copy from another component test):
```tsx
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { ResourceCard } from "./ResourceCard"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

describe("ResourceCard slack", () => {
  it("shows custom_name when set", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false, custom_name: "Release blocker" } as any} />)
    expect(screen.getByText("Release blocker")).toBeInTheDocument()
    expect(screen.queryByText("C1:170.100")).not.toBeInTheDocument()
  })

  it("falls back to id when no custom_name", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false } as any} />)
    expect(screen.getByText("C1:170.100")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/git/worktree/ui && npx vitest run src/components/ResourceCard.test.tsx`
Expected: FAIL — the first test fails because `SlackCardBody` always renders `r.id`.

- [ ] **Step 3: Update `SlackCardBody`**

In `~/git/worktree/ui/src/components/ResourceCard.tsx`, change `SlackCardBody` to prefer `custom_name`:
```tsx
function SlackCardBody({ r }: { r: ResourceDTO }) {
  const label = r.custom_name || r.id
  return (
    <Group gap="xs">
      <Badge size="xs" variant="light" color="grape">Slack</Badge>
      {r.url ? <Anchor href={r.url} target="_blank" size="sm">{label}</Anchor> : <Text size="sm">{label}</Text>}
    </Group>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/git/worktree/ui && npx vitest run src/components/ResourceCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Type-check + full frontend suite**

Run: `cd ~/git/worktree/ui && npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd ~/git/worktree
git add ui/src/components/ResourceCard.tsx ui/src/components/ResourceCard.test.tsx
git commit --signoff -m "ui/slack: show custom name on Overview resource card

Falls back to raw channel:ts when unset (real first-message fallback deferred
to Phase 4 / poller-rethink)."
```

---

### Task 8: Full build + docs touch-up

**Repo:** `~/git/worktree`.

**Files:**
- Modify: `~/git/worktree/docs/web-ui-architecture.md` (document the meta endpoint + custom fields)
- (build only) `~/git/worktree/Makefile` targets

**Interfaces:**
- Consumes: everything above.
- Produces: a green `make build` + `make test` and up-to-date docs.

- [ ] **Step 1: Full build (embeds the UI)**

Run: `cd ~/git/worktree && make build`
Expected: builds `bin/worktree` with the rebuilt UI embedded, no errors.

- [ ] **Step 2: Full test (Go + frontend)**

Run: `cd ~/git/worktree && make test`
Expected: Go tests pass; frontend vitest passes.

- [ ] **Step 3: Document the endpoint + fields**

In `~/git/worktree/docs/web-ui-architecture.md`, in the routes/DTO section, add a short entry: `POST /api/resource-meta {type,id,name,description}` → persists per-resource `custom_name`/`custom_description` (stored in the library's `watcher_resource_meta`, keyed `(resource_type, resource_id)`); the resources DTO now carries `custom_name`/`custom_description`; the Slack tab (rail + header) and Overview slack card prefer `custom_name`, falling back to `channel:ts` (a real first-message fallback on the card is deferred to Phase 4 / the poller-rethink). Keep it to a few sentences matching the doc's existing style.

- [ ] **Step 4: Commit**

```bash
cd ~/git/worktree
git add docs/web-ui-architecture.md
git commit --signoff -m "docs: document /api/resource-meta and custom_name/description"
```

---

## Notes for the executor

- **Task order is strict for Tasks 1→3** (library release must be tagged+pushed before the `go get` in Task 3). Tasks 4–8 are worktree-only and sequential.
- The empty-state text in `SlackTab.tsx` still reads `worktree add <slack-thread-url>` — that copy is Phase 3b's concern (add/remove UX), NOT this bug fix. Do not change it here.
- Do NOT add a `case "slack"` to `enrichResourceDTO` or a slack branch to `internal/webui/poller.go` — the card fallback is intentionally the raw id this round (see Global Constraints).
- The controller has session-level approval to commit AND push this round; still announce the watcher tag push and any merge-to-main in the ledger.
