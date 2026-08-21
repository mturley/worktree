# Worktree UI: Cards, Resource Selection & Responsive Drilldown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the worktree UI around a shared worktree card and a URL-backed selected resource, so each worktree shows its focus resources at a glance and selecting one filters the timeline — presenting as side-by-side panes on wide viewports and as a drilldown on narrow ones.

**Architecture:** Two additive backend changes (`focus_resources` on `/api/worktrees`; optional `resource_type`/`resource_id` filter on `/api/worktree-timeline`). On the frontend, selection lives in a `?resource=<type>:<id>` query param read through one hook, and the viewport only decides presentation. The selected-resource area is a swappable pane (`ResourceDetailPane`) so the deferred Slack phase is a single branch rather than a rewrite.

**Tech Stack:** Go 1.x + SQLite (`internal/webui`), React 19 + Mantine 7 + wouter 3 + TanStack Query 5, Vitest + Testing Library, `@tabler/icons-react`.

**Spec:** `docs/superpowers/specs/2026-08-21-worktree-ui-resource-selection-design.md`

## Global Constraints

- **Scope is Phase A only** (spec items 1–5). Item 6 (Slack restructure) is Phase B — do **not** remove the Overview/Slack tabs or the Slack thread rail in this plan.
- **Branch:** work on `wt-ui-fixes`. **No new branches, no pushes, no PRs.**
- **Commits:** ask the user before every commit; use `--signoff`; never `git add -A` (add files by name).
- **TDD is mandatory:** write the failing test, watch it fail, then implement.
- **Do not disable lint rules.** If a lint error appears, fix the underlying issue or stop and ask.
- **Breakpoint is `48em`** (Mantine `sm`), matching existing `Grid.Col span={{ base: 12, sm: N }}` usage. All responsive logic goes through `useIsWide()` — never call `useMediaQuery` directly in a component.
- **No watcher-library changes.** Everything is local to this repo.
- **Backend slices** returned as JSON use `make([]T, 0, n)` so they marshal as `[]`, never `null`.
- Go tests: `go test ./internal/webui/ -run <Name> -v` from the repo root.
- Frontend tests: `cd ui && npx vitest run <path>` (the `ui/` package uses `vitest run` as `npm test`).

---

### Task 1: Backend — expose focus resources on `/api/worktrees`

**Files:**
- Modify: `internal/webui/worktrees.go`
- Test: `internal/webui/worktrees_test.go`

**Interfaces:**
- Consumes: existing `resourceDTO` and `(*Server).enrichResourceDTO(*resourceDTO)` from `internal/webui/resources_api.go`.
- Produces: `worktreeSummary.FocusResources []resourceDTO` with JSON key `focus_resources` — consumed by Task 4 (TS type) and Task 8 (`WorktreeCard`).

- [ ] **Step 1: Write the failing test**

Append to `internal/webui/worktrees_test.go`:

```go
func TestWorktreesEndpointFocusResources(t *testing.T) {
	conn := seededDB(t)
	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2", Related: true})

	prState := `{"title":"Fix the widget","state":"OPEN","author":"octocat"}`
	if err := watcherdb.UpsertResourceState(conn, "pr", "o/r#1", prState, "2026-08-01T00:00:00Z", "2026-08-01T00:05:00Z"); err != nil {
		t.Fatal(err)
	}

	// A second worktree with no resources at all, to prove focus_resources
	// marshals as [] rather than null.
	emptyPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: emptyPath, Repo: "odh", RepoRoot: "/r", Branch: "b2", CreatedAt: "2026-08-13T00:00:00Z"})

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var got []worktreeSummary
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}

	byBranch := map[string]worktreeSummary{}
	for _, w := range got {
		byBranch[w.Branch] = w
	}

	b1 := byBranch["b1"]
	if len(b1.FocusResources) != 1 {
		t.Fatalf("want 1 focus resource (primary only), got %d: %+v", len(b1.FocusResources), b1.FocusResources)
	}
	fr := b1.FocusResources[0]
	if fr.Type != "pr" || fr.ID != "o/r#1" {
		t.Fatalf("wrong focus resource: %+v", fr)
	}
	if !fr.Primary {
		t.Fatalf("focus resource must be primary: %+v", fr)
	}
	if fr.Title != "Fix the widget" || fr.State != "OPEN" {
		t.Fatalf("focus resource not enriched: %+v", fr)
	}

	// Existing count fields must be unchanged by this addition.
	if b1.PrimaryCount != 1 || b1.RelatedCount != 1 || b1.ResourceCount != 2 {
		t.Fatalf("counts changed unexpectedly: %+v", b1)
	}

	// Empty worktree serializes as [], not null.
	if !strings.Contains(string(body), `"focus_resources":[]`) {
		t.Fatalf("expected an empty focus_resources array in payload, got: %s", string(body))
	}
	if byBranch["b2"].FocusResources == nil {
		t.Fatal("focus_resources must be an empty slice, not nil")
	}
}
```

Add these imports to `internal/webui/worktrees_test.go` if not already present: `io`, `strings`, and `watcherdb "github.com/mturley/watcher/db"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/webui/ -run TestWorktreesEndpointFocusResources -v`
Expected: FAIL to compile — `b1.FocusResources undefined (type worktreeSummary has no field or method FocusResources)`.

- [ ] **Step 3: Write minimal implementation**

In `internal/webui/worktrees.go`, add the field to the struct:

```go
type worktreeSummary struct {
	Path          string         `json:"path"`
	Repo          string         `json:"repo"`
	Branch        string         `json:"branch"`
	OnDisk        bool           `json:"on_disk"`
	ResourceCount int            `json:"resource_count"`
	PrimaryCount  int            `json:"primary_count"`
	PrimaryByType map[string]int `json:"primary_by_type"`
	RelatedCount  int            `json:"related_count"`
	LatestEventTS string         `json:"latest_event_ts"`
	// FocusResources are the primary (non-related) resources, enriched from
	// watcher_resource_state, so the worktree list can show what each
	// worktree is actually about instead of bare counts.
	FocusResources []resourceDTO `json:"focus_resources"`
}
```

Then inside `handleWorktrees`, in the existing `for _, res := range rs` loop, collect the primaries. Replace the counting block with:

```go
		primary := 0
		primaryByType := make(map[string]int)
		relatedCount := 0
		// Sized for the common case; make(...) (not nil) so it marshals as [].
		focus := make([]resourceDTO, 0, len(rs))
		for _, res := range rs {
			if !res.Related {
				primary++
				primaryByType[res.Type]++
				dto := resourceDTO{
					Type: res.Type, ID: res.ID, URL: res.URL, Primary: true,
					CustomName: res.CustomName, CustomDescription: res.CustomDescription,
				}
				s.enrichResourceDTO(&dto)
				focus = append(focus, dto)
			} else {
				relatedCount++
			}
		}
```

And add `FocusResources: focus,` to the `worktreeSummary{...}` literal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/webui/ -run TestWorktrees -v`
Expected: PASS — both `TestWorktreesEndpoint` (unchanged behavior) and `TestWorktreesEndpointFocusResources`.

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add internal/webui/worktrees.go internal/webui/worktrees_test.go
git commit --signoff -m "feat(webui): include enriched focus resources in /api/worktrees"
```

---

### Task 2: Backend — resource-filtered worktree timeline

**Files:**
- Modify: `internal/webui/timeline.go` (`handleWorktreeTimeline`)
- Test: `internal/webui/timeline_test.go`

**Interfaces:**
- Consumes: existing `insertEvent` test helper, `parseLimit(r)`, `(*Server).enrichEvent`.
- Produces: `GET /api/worktree-timeline?path=&resource_type=&resource_id=` — consumed by Task 4 (`api.worktreeTimeline`).

**Why it is written this way:** `enrichEvent` runs three DB queries per event. Filtering after enrichment would pay that cost for rows we then throw away, so we resolve the resource's event ids in one query and enrich only survivors. The filter is applied **before** the limit so a filtered page really is the newest N events for that resource.

- [ ] **Step 1: Write the failing test**

Append to `internal/webui/timeline_test.go`:

```go
func TestWorktreeTimelineResourceFilter(t *testing.T) {
	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	wtPath := t.TempDir()
	registry.Register(conn, registry.Entry{Path: wtPath, Repo: "odh", RepoRoot: "/r", Branch: "b1", CreatedAt: "2026-08-13T00:00:00Z"})
	resources.Add(conn, wtPath, resources.Resource{Type: "pr", ID: "o/r#1", URL: "u1"})
	resources.Add(conn, wtPath, resources.Resource{Type: "jira", ID: "J-1", URL: "u2"})

	// Interleave 5 matching and 5 non-matching events so that a naive
	// "limit first, filter second" implementation would return fewer than 5.
	base := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < 5; i++ {
		insertEvent(t, conn, fmt.Sprintf("pr-%d", i), base.Add(time.Duration(i*2)*time.Minute).Format(time.RFC3339),
			"github", "pr_comment", fmt.Sprintf("pr comment %d", i), "pr", "o/r#1", "u1")
		insertEvent(t, conn, fmt.Sprintf("jira-%d", i), base.Add(time.Duration(i*2+1)*time.Minute).Format(time.RFC3339),
			"jira", "jira_comment", fmt.Sprintf("jira comment %d", i), "jira", "J-1", "u2")
	}

	srv := &Server{DB: conn}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	get := func(query string) (int, []TimelineEvent) {
		resp, err := http.Get(ts.URL + "/api/worktree-timeline?path=" + url.QueryEscape(wtPath) + query)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			Events []TimelineEvent `json:"events"`
		}
		json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body.Events
	}

	// Unfiltered: all 10 events.
	if _, evs := get(""); len(evs) != 10 {
		t.Fatalf("unfiltered: want 10 events, got %d", len(evs))
	}

	// Filtered: only the PR's events.
	code, evs := get("&resource_type=pr&resource_id=" + url.QueryEscape("o/r#1"))
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if len(evs) != 5 {
		t.Fatalf("filtered: want 5 pr events, got %d", len(evs))
	}
	for _, e := range evs {
		if e.ResourceType != "pr" || e.ResourceID != "o/r#1" {
			t.Fatalf("filter leaked a non-matching event: %+v", e)
		}
	}

	// The filter must be applied BEFORE the limit: with limit=3 we must get
	// 3 matching events, not "3 newest overall, then filtered down".
	_, limited := get("&limit=3&resource_type=pr&resource_id=" + url.QueryEscape("o/r#1"))
	if len(limited) != 3 {
		t.Fatalf("want 3 matching events under limit=3, got %d", len(limited))
	}
	for _, e := range limited {
		if e.ResourceType != "pr" {
			t.Fatalf("limited filter leaked: %+v", e)
		}
	}

	// A half-specified filter is a client error, not a silent unfiltered page.
	if code, _ := get("&resource_type=pr"); code != http.StatusBadRequest {
		t.Fatalf("resource_type without resource_id: want 400, got %d", code)
	}
	if code, _ := get("&resource_id=" + url.QueryEscape("o/r#1")); code != http.StatusBadRequest {
		t.Fatalf("resource_id without resource_type: want 400, got %d", code)
	}
}
```

Add `fmt` to `internal/webui/timeline_test.go` imports if not present.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/webui/ -run TestWorktreeTimelineResourceFilter -v`
Expected: FAIL — the filtered request returns 10 events (filter ignored), so `want 5 pr events, got 10`.

- [ ] **Step 3: Write minimal implementation**

In `internal/webui/timeline.go`, add this helper above `handleWorktreeTimeline`:

```go
// eventIDsForResource returns the set of event ids linked to one resource.
// Resolving the set up front means handleWorktreeTimeline can skip
// non-matching events without paying enrichEvent's three-queries-per-event
// cost on rows it would discard.
func (s *Server) eventIDsForResource(rtype, rid string) (map[string]struct{}, error) {
	rows, err := s.DB.Query(
		`SELECT event_id FROM watcher_event_resources WHERE resource_type = ? AND resource_id = ?`,
		rtype, rid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids[id] = struct{}{}
	}
	return ids, rows.Err()
}
```

Then in `handleWorktreeTimeline`, after the existing `path` check and before the `EventsForSubscriberSince` call, add the param parsing:

```go
	rtype := r.URL.Query().Get("resource_type")
	rid := r.URL.Query().Get("resource_id")
	if (rtype == "") != (rid == "") {
		writeError(w, http.StatusBadRequest, "resource_type and resource_id must be supplied together")
		return
	}
	var only map[string]struct{}
	if rtype != "" {
		var err error
		only, err = s.eventIDsForResource(rtype, rid)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
```

And change the reverse loop to skip non-members before enriching:

```go
	for i := len(evs) - 1; i >= 0 && len(out) < limit; i-- {
		if only != nil {
			if _, ok := only[evs[i].ID]; !ok {
				continue
			}
		}
		out = append(out, s.enrichEvent(evs[i]))
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/webui/ -v`
Expected: PASS, including the pre-existing timeline tests (unfiltered behavior unchanged).

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add internal/webui/timeline.go internal/webui/timeline_test.go
git commit --signoff -m "feat(webui): filter worktree timeline by resource"
```

---

### Task 3: Frontend bootstrap — deps, `useIsWide`, and a viewport test helper

**Files:**
- Modify: `ui/package.json` (add `@tabler/icons-react`)
- Create: `ui/src/hooks/useIsWide.ts`
- Create: `ui/src/testing/viewport.ts`
- Test: `ui/src/hooks/useIsWide.test.tsx`

**Interfaces:**
- Produces:
  - `useIsWide(): boolean` — the single responsive predicate; used by Tasks 9 and 12.
  - `setViewport(mode: "wide" | "narrow"): void` — test-only helper; used by Tasks 9 and 12.

**Context:** `node_modules` is not installed in this worktree yet. Also note `ui/src/test-setup.ts` stubs `matchMedia` with `matches: false`, so **tests default to narrow** — wide-layout tests must call `setViewport("wide")` explicitly.

- [ ] **Step 1: Install dependencies**

```bash
cd ui && npm install && npm install @tabler/icons-react
```

Then confirm wouter exposes the search hook this plan relies on in Task 6:

```bash
cd ui && node -e "const w=require('wouter'); console.log('useSearch:', typeof w.useSearch, '| useLocation:', typeof w.useLocation)"
```

Expected: `useSearch: function | useLocation: function`. If `useSearch` is **not** a function, stop and tell the user — Task 6 then reads `window.location.search` directly and subscribes via `useLocation()` instead, and the plan needs that adjustment recorded before continuing.

- [ ] **Step 2: Write the failing test**

Create `ui/src/hooks/useIsWide.test.tsx`:

```tsx
import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { setViewport } from "../testing/viewport"
import { useIsWide } from "./useIsWide"

function Probe() {
  return <span data-testid="probe">{useIsWide() ? "wide" : "narrow"}</span>
}

afterEach(cleanup)

describe("useIsWide", () => {
  it("reports narrow by default (matchMedia stub reports no match)", () => {
    setViewport("narrow")
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("narrow")
  })

  it("reports wide when the viewport query matches", () => {
    setViewport("wide")
    render(<Probe />)
    expect(screen.getByTestId("probe")).toHaveTextContent("wide")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ui && npx vitest run src/hooks/useIsWide.test.tsx`
Expected: FAIL — cannot resolve `../testing/viewport` and `./useIsWide`.

- [ ] **Step 4: Write minimal implementation**

Create `ui/src/testing/viewport.ts`:

```ts
/**
 * Test-only helper: force the viewport the UI believes it is rendering at.
 *
 * `src/test-setup.ts` stubs matchMedia with `matches: false`, so every test
 * renders the NARROW layout unless it opts in. Call this explicitly rather
 * than re-stubbing matchMedia ad hoc, so the intent of each test is obvious.
 */
export function setViewport(mode: "wide" | "narrow"): void {
  const matches = mode === "wide"
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
```

Create `ui/src/hooks/useIsWide.ts`:

```ts
import { useMediaQuery } from "@mantine/hooks"

/** 48em is Mantine's `sm`, matching the existing Grid `sm` breakpoints. */
const WIDE_QUERY = "(min-width: 48em)"

/**
 * The single responsive predicate for the app. Components must use this
 * rather than calling useMediaQuery directly, so every layout flips at the
 * same width and tests have one thing to control (see testing/viewport.ts).
 *
 * getInitialValueInEffect:false makes the first render read matchMedia
 * immediately — avoiding a narrow-then-wide flash in the browser and making
 * the value deterministic in tests.
 */
export function useIsWide(): boolean {
  return useMediaQuery(WIDE_QUERY, false, { getInitialValueInEffect: false }) ?? false
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && npx vitest run src/hooks/useIsWide.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit** (ask the user first)

```bash
git add ui/package.json ui/package-lock.json ui/src/hooks/useIsWide.ts ui/src/hooks/useIsWide.test.tsx ui/src/testing/viewport.ts
git commit --signoff -m "feat(ui): add useIsWide breakpoint hook, viewport test helper, tabler icons"
```

---

### Task 4: Frontend API layer — focus resources and the timeline filter

**Files:**
- Modify: `ui/src/api/types.ts`
- Modify: `ui/src/api/client.ts`
- Modify: `ui/src/hooks/useTimeline.ts`
- Test: `ui/src/api/client.test.ts`

**Interfaces:**
- Consumes: Task 1's `focus_resources`, Task 2's `resource_type`/`resource_id` params.
- Produces:
  - `WorktreeSummary.focus_resources: ResourceDTO[]`
  - `api.worktreeTimeline(path, limit?, resource?: { type: string; id: string })`
  - `useWorktreeTimeline(path, resource?: { type: string; id: string })` — used by Task 11.

- [ ] **Step 1: Write the failing test**

Create `ui/src/api/client.test.ts`:

```ts
import { afterEach, describe, it, expect, vi } from "vitest"
import { api } from "./client"

afterEach(() => vi.unstubAllGlobals())

function stubFetch() {
  const calls: string[] = []
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(url)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ events: [], next_cursor: "" }) } as Response)
  })
  return calls
}

describe("api.worktreeTimeline", () => {
  it("omits resource params when no resource is given", async () => {
    const calls = stubFetch()
    await api.worktreeTimeline("/wt/foo")
    expect(calls[0]).toContain("path=%2Fwt%2Ffoo")
    expect(calls[0]).not.toContain("resource_type")
  })

  it("sends encoded resource_type and resource_id when a resource is given", async () => {
    const calls = stubFetch()
    await api.worktreeTimeline("/wt/foo", 100, { type: "pr", id: "org/repo#1" })
    expect(calls[0]).toContain("resource_type=pr")
    expect(calls[0]).toContain("resource_id=org%2Frepo%231")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/api/client.test.ts`
Expected: FAIL — the second test fails because the URL contains no `resource_type` (the third argument is ignored today).

- [ ] **Step 3: Write minimal implementation**

In `ui/src/api/types.ts`, add the field to `WorktreeSummary`:

```ts
export interface WorktreeSummary {
  path: string; repo: string; branch: string;
  on_disk: boolean; resource_count: number; primary_count: number; latest_event_ts: string;
  primary_by_type: Record<string, number>; related_count: number;
  /** Primary ("focus") resources, enriched. Always an array — never null. */
  focus_resources: ResourceDTO[];
}
```

In `ui/src/api/client.ts`, replace the `worktreeTimeline` entry:

```ts
  worktreeTimeline: (path: string, limit = 100, resource?: { type: string; id: string }) => {
    const params = new URLSearchParams({ path, limit: String(limit) })
    if (resource) {
      params.set("resource_type", resource.type)
      params.set("resource_id", resource.id)
    }
    return fetchJSON<TimelineResponse>(`/api/worktree-timeline?${params.toString()}`)
  },
```

In `ui/src/hooks/useTimeline.ts`, thread the resource through the query key:

```ts
export function useWorktreeTimeline(path: string, resource?: { type: string; id: string }) {
  // The resource is part of the key so switching selection is a normal
  // cache-keyed fetch and switching back to unfiltered is a cache hit.
  const key = resource ? `${resource.type}:${resource.id}` : ""
  return useQuery({
    queryKey: ["timeline", "worktree", path, key],
    queryFn: () => api.worktreeTimeline(path, 100, resource),
    enabled: !!path,
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/api/client.test.ts && npx vitest run`
Expected: PASS. The whole suite must stay green — `useWorktreeDetail` still calls `useWorktreeTimeline(path)` with one argument, which remains valid.

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add ui/src/api/types.ts ui/src/api/client.ts ui/src/api/client.test.ts ui/src/hooks/useTimeline.ts
git commit --signoff -m "feat(ui): thread an optional resource filter through the timeline API"
```

---

### Task 5: `resourceKey` — serialize/parse the selection param

**Files:**
- Create: `ui/src/lib/resourceKey.ts`
- Test: `ui/src/lib/resourceKey.test.ts`

**Interfaces:**
- Produces (used by Tasks 6, 10, 11, 12):
  - `interface ResourceKey { type: string; id: string }`
  - `serializeResourceKey(key: ResourceKey): string`
  - `parseResourceKey(raw: string | null | undefined): ResourceKey | null`
  - `resourceKeyEquals(a: ResourceKey | null, b: ResourceKey | null): boolean`

**Why a separate file:** this is pure logic with a nasty edge case (Slack ids contain a colon), so it is tested without React.

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/resourceKey.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { serializeResourceKey, parseResourceKey, resourceKeyEquals } from "./resourceKey"

describe("resourceKey", () => {
  it("round-trips a PR id containing / and #", () => {
    const key = { type: "pr", id: "org/repo#1" }
    expect(parseResourceKey(serializeResourceKey(key))).toEqual(key)
  })

  it("round-trips a Slack id that itself contains a colon", () => {
    const key = { type: "slack", id: "C123:1700000000.000100" }
    const raw = serializeResourceKey(key)
    expect(parseResourceKey(raw)).toEqual(key)
  })

  it("splits on the first colon only", () => {
    // Even unencoded, everything after the first colon is the id.
    expect(parseResourceKey("slack:C1:2.3")).toEqual({ type: "slack", id: "C1:2.3" })
  })

  it("returns null for empty, missing, or malformed input", () => {
    expect(parseResourceKey(null)).toBeNull()
    expect(parseResourceKey(undefined)).toBeNull()
    expect(parseResourceKey("")).toBeNull()
    expect(parseResourceKey("noseparator")).toBeNull()
    expect(parseResourceKey(":missingtype")).toBeNull()
    expect(parseResourceKey("missingid:")).toBeNull()
  })

  it("compares keys structurally, treating nulls as unequal to keys", () => {
    expect(resourceKeyEquals({ type: "pr", id: "a" }, { type: "pr", id: "a" })).toBe(true)
    expect(resourceKeyEquals({ type: "pr", id: "a" }, { type: "jira", id: "a" })).toBe(false)
    expect(resourceKeyEquals(null, null)).toBe(true)
    expect(resourceKeyEquals(null, { type: "pr", id: "a" })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/lib/resourceKey.test.ts`
Expected: FAIL — cannot resolve `./resourceKey`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/lib/resourceKey.ts`:

```ts
/** Identifies one resource within a worktree. */
export interface ResourceKey {
  type: string
  id: string
}

/**
 * Encodes a key for the `?resource=` query param as `<type>:<encoded id>`.
 * The id is percent-encoded because ids legitimately contain `/`, `#`, and
 * (for Slack threads) `:`.
 */
export function serializeResourceKey(key: ResourceKey): string {
  return `${key.type}:${encodeURIComponent(key.id)}`
}

/**
 * Parses a `?resource=` value. Splits on the FIRST colon only: a Slack
 * resource id is itself `channel:threadTs`, so everything after the first
 * colon belongs to the id. Returns null for anything malformed rather than
 * throwing, so a stale or hand-edited URL degrades to "nothing selected".
 */
export function parseResourceKey(raw: string | null | undefined): ResourceKey | null {
  if (!raw) return null
  const idx = raw.indexOf(":")
  if (idx <= 0) return null
  const type = raw.slice(0, idx)
  const rest = raw.slice(idx + 1)
  if (!type || !rest) return null
  let id: string
  try {
    id = decodeURIComponent(rest)
  } catch {
    id = rest // malformed percent-encoding: use the raw remainder
  }
  return { type, id }
}

export function resourceKeyEquals(a: ResourceKey | null, b: ResourceKey | null): boolean {
  if (a === null || b === null) return a === b
  return a.type === b.type && a.id === b.id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/lib/resourceKey.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add ui/src/lib/resourceKey.ts ui/src/lib/resourceKey.test.ts
git commit --signoff -m "feat(ui): add resource key serialize/parse for URL selection state"
```

---

### Task 6: `useSelectedResource` — selection state in the URL

**Files:**
- Create: `ui/src/hooks/useSelectedResource.ts`
- Test: `ui/src/hooks/useSelectedResource.test.tsx`

**Interfaces:**
- Consumes: `ResourceKey`, `serializeResourceKey`, `parseResourceKey`, `resourceKeyEquals` (Task 5).
- Produces (used by Task 12):
  ```ts
  function useSelectedResource(): {
    selected: ResourceKey | null
    select: (key: ResourceKey) => void
    clear: () => void
    toggle: (key: ResourceKey) => void
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `ui/src/hooks/useSelectedResource.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useSelectedResource } from "./useSelectedResource"

function Probe() {
  const { selected, select, clear, toggle } = useSelectedResource()
  return (
    <div>
      <span data-testid="selected">{selected ? `${selected.type}|${selected.id}` : "none"}</span>
      <button onClick={() => select({ type: "pr", id: "org/repo#1" })}>select pr</button>
      <button onClick={() => toggle({ type: "pr", id: "org/repo#1" })}>toggle pr</button>
      <button onClick={clear}>clear</button>
    </div>
  )
}

beforeEach(() => window.history.replaceState({}, "", "/worktree/wt"))
afterEach(cleanup)

describe("useSelectedResource", () => {
  it("reads the selection from the ?resource= param", () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=slack:C1%3A1700000000.000100")
    render(<Probe />)
    expect(screen.getByTestId("selected")).toHaveTextContent("slack|C1:1700000000.000100")
  })

  it("reports no selection when the param is absent", () => {
    render(<Probe />)
    expect(screen.getByTestId("selected")).toHaveTextContent("none")
  })

  it("writes the selection into the URL on select", async () => {
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "select pr" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("pr|org/repo#1")
    expect(window.location.search).toContain("resource=pr%3Aorg%252Frepo%25231")
  })

  it("removes the param on clear", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=pr:org%2Frepo%231")
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "clear" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("none")
    expect(window.location.search).not.toContain("resource=")
  })

  it("toggle deselects a key that is already selected", async () => {
    window.history.replaceState({}, "", "/worktree/wt?resource=pr:org%2Frepo%231")
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "toggle pr" }))
    expect(screen.getByTestId("selected")).toHaveTextContent("none")
  })

  it("preserves other query params", async () => {
    window.history.replaceState({}, "", "/worktree/wt?tab=overview")
    const user = userEvent.setup()
    render(<Probe />)
    await user.click(screen.getByRole("button", { name: "select pr" }))
    expect(window.location.search).toContain("tab=overview")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/hooks/useSelectedResource.test.tsx`
Expected: FAIL — cannot resolve `./useSelectedResource`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/hooks/useSelectedResource.ts`:

```ts
import { useCallback } from "react"
import { useLocation, useSearch } from "wouter"
import {
  parseResourceKey,
  serializeResourceKey,
  resourceKeyEquals,
  type ResourceKey,
} from "../lib/resourceKey"

const PARAM = "resource"

/**
 * The selected resource, stored in the URL as `?resource=<type>:<id>`.
 *
 * Keeping it in the URL (rather than component state) makes a selection
 * deep-linkable, survive a refresh, and be undone by the browser back button.
 * Crucially it is also the SINGLE source of truth shared by the wide-viewport
 * card highlight and the narrow-viewport drilldown, so resizing the viewport
 * swaps presentation without disturbing the selection.
 */
export function useSelectedResource(): {
  selected: ResourceKey | null
  select: (key: ResourceKey) => void
  clear: () => void
  toggle: (key: ResourceKey) => void
} {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const selected = parseResourceKey(new URLSearchParams(search).get(PARAM))

  const setParam = useCallback(
    (value: string | null) => {
      const params = new URLSearchParams(search)
      if (value === null) params.delete(PARAM)
      else params.set(PARAM, value)
      const qs = params.toString()
      navigate(qs ? `${location}?${qs}` : location)
    },
    [search, location, navigate],
  )

  const select = useCallback((key: ResourceKey) => setParam(serializeResourceKey(key)), [setParam])
  const clear = useCallback(() => setParam(null), [setParam])
  const toggle = useCallback(
    (key: ResourceKey) => (resourceKeyEquals(selected, key) ? clear() : select(key)),
    [selected, clear, select],
  )

  return { selected, select, clear, toggle }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/hooks/useSelectedResource.test.tsx`
Expected: PASS (6 tests).

If `useSearch` was found missing in Task 3 Step 1, replace `const search = useSearch()` with a `useLocation()`-subscribed read of `window.location.search`, and rerun.

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add ui/src/hooks/useSelectedResource.ts ui/src/hooks/useSelectedResource.test.tsx
git commit --signoff -m "feat(ui): add useSelectedResource backed by the ?resource= param"
```

---

### Task 7: `ResourceStatusIcon`

**Files:**
- Create: `ui/src/components/ResourceStatusIcon.tsx`
- Test: `ui/src/components/ResourceStatusIcon.test.tsx`

**Interfaces:**
- Produces (used by Tasks 8 and 10):
  - `resourceStatusMeta(r: ResourceDTO): { color: string; label: string }`
  - `<ResourceStatusIcon r={resource} size={14} />`

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/ResourceStatusIcon.test.tsx`:

```tsx
import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import type { ResourceDTO } from "../api/types"
import { ResourceStatusIcon, resourceStatusMeta } from "./ResourceStatusIcon"

const base = (over: Partial<ResourceDTO>): ResourceDTO =>
  ({ type: "pr", id: "o/r#1", url: "u", primary: true, ...over }) as ResourceDTO

afterEach(cleanup)

describe("resourceStatusMeta", () => {
  it("colors PRs by state like GitHub", () => {
    expect(resourceStatusMeta(base({ state: "OPEN" })).color).toBe("green")
    expect(resourceStatusMeta(base({ state: "MERGED" })).color).toBe("violet")
    expect(resourceStatusMeta(base({ state: "CLOSED" })).color).toBe("red")
  })

  it("colors Jira by status family", () => {
    expect(resourceStatusMeta(base({ type: "jira", status: "Done" })).color).toBe("green")
    expect(resourceStatusMeta(base({ type: "jira", status: "In Progress" })).color).toBe("blue")
    expect(resourceStatusMeta(base({ type: "jira", status: "Backlog" })).color).toBe("gray")
  })

  it("uses grape for slack and gray for never-polled resources", () => {
    expect(resourceStatusMeta(base({ type: "slack" })).color).toBe("grape")
    expect(resourceStatusMeta(base({ state: undefined })).color).toBe("gray")
  })
})

describe("ResourceStatusIcon", () => {
  it("exposes the status as an accessible label", () => {
    render(<ResourceStatusIcon r={base({ state: "MERGED" })} />)
    expect(screen.getByLabelText("merged")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/components/ResourceStatusIcon.test.tsx`
Expected: FAIL — cannot resolve `./ResourceStatusIcon`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/components/ResourceStatusIcon.tsx`:

```tsx
import {
  IconCircleDashed,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconMessage,
  IconTicket,
} from "@tabler/icons-react"
import type { ResourceDTO } from "../api/types"

type IconComponent = typeof IconGitPullRequest

interface StatusMeta {
  Icon: IconComponent
  color: string
  label: string
}

/**
 * Single mapping from a resource's cached state to an icon + colour, so the
 * worktree card, the resource list, and the detail pane can never disagree
 * about what "open" or "merged" looks like.
 */
export function resourceStatusMeta(r: ResourceDTO): StatusMeta {
  if (r.type === "slack") {
    return { Icon: IconMessage, color: "grape", label: "slack thread" }
  }
  if (r.type === "pr") {
    switch ((r.state || "").toUpperCase()) {
      case "OPEN": return { Icon: IconGitPullRequest, color: "green", label: "open" }
      case "MERGED": return { Icon: IconGitMerge, color: "violet", label: "merged" }
      case "CLOSED": return { Icon: IconGitPullRequestClosed, color: "red", label: "closed" }
    }
    return { Icon: IconCircleDashed, color: "gray", label: "unknown state" }
  }
  if (r.type === "jira") {
    const status = r.status || ""
    if (!status) return { Icon: IconCircleDashed, color: "gray", label: "unknown state" }
    if (/done|closed|resolved/i.test(status)) return { Icon: IconTicket, color: "green", label: status }
    if (/progress|review/i.test(status)) return { Icon: IconTicket, color: "blue", label: status }
    return { Icon: IconTicket, color: "gray", label: status }
  }
  return { Icon: IconCircleDashed, color: "gray", label: "unknown state" }
}

export function ResourceStatusIcon({ r, size = 14 }: { r: ResourceDTO; size?: number }) {
  const { Icon, color, label } = resourceStatusMeta(r)
  return (
    <Icon
      size={size}
      aria-label={label}
      role="img"
      style={{ color: `var(--mantine-color-${color}-6)`, flexShrink: 0 }}
    />
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/components/ResourceStatusIcon.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add ui/src/components/ResourceStatusIcon.tsx ui/src/components/ResourceStatusIcon.test.tsx
git commit --signoff -m "feat(ui): add ResourceStatusIcon with GitHub-style PR state colors"
```

---

### Task 8: `WorktreeCard`

**Files:**
- Create: `ui/src/components/WorktreeCard.tsx`
- Test: `ui/src/components/WorktreeCard.test.tsx`

**Interfaces:**
- Consumes: `WorktreeSummary.focus_resources` (Task 4), `ResourceStatusIcon` (Task 7), existing `resourceSummary` from `ui/src/lib/resourceSummary.ts`.
- Produces: `<WorktreeCard w={summary} clickable />` — used by Tasks 9 and 12.

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/WorktreeCard.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { WorktreeSummary } from "../api/types"
import { WorktreeCard } from "./WorktreeCard"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 2, primary_count: 2, latest_event_ts: "",
  primary_by_type: { pr: 1, jira: 1 }, related_count: 0,
  focus_resources: [
    { type: "pr", id: "o/r#1", url: "https://github.com/o/r/pull/1", primary: true, title: "Fix the widget", state: "OPEN" },
    { type: "jira", id: "J-1", url: "https://jira/browse/J-1", primary: true, title: "Investigate flux", status: "In Progress" },
  ],
}

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

beforeEach(() => window.history.replaceState({}, "", "/"))
afterEach(cleanup)

describe("WorktreeCard", () => {
  it("shows the branch and repo", () => {
    wrap(<WorktreeCard w={summary} />)
    expect(screen.getByText("my-branch")).toBeInTheDocument()
    expect(screen.getByText(/odh/)).toBeInTheDocument()
  })

  it("renders one line per focus resource with its title and link", () => {
    wrap(<WorktreeCard w={summary} />)
    const pr = screen.getByRole("link", { name: /Fix the widget/ })
    expect(pr).toHaveAttribute("href", "https://github.com/o/r/pull/1")
    expect(screen.getByRole("link", { name: /Investigate flux/ })).toBeInTheDocument()
    expect(screen.getByLabelText("open")).toBeInTheDocument()
  })

  it("navigates to the worktree detail page when the card is clicked", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} />)
    await user.click(screen.getByRole("link", { name: /open worktree my-branch/i }))
    expect(window.location.pathname).toBe(`/worktree/${encodeURIComponent("/wt/foo")}`)
  })

  it("does not navigate when a resource link is clicked", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} />)
    await user.click(screen.getByRole("link", { name: /Fix the widget/ }))
    expect(window.location.pathname).toBe("/")
  })

  it("does not navigate when clickable is false", async () => {
    const user = userEvent.setup()
    wrap(<WorktreeCard w={summary} clickable={false} />)
    await user.click(screen.getByText("my-branch"))
    expect(window.location.pathname).toBe("/")
  })

  it("flags a worktree that is missing on disk", () => {
    wrap(<WorktreeCard w={{ ...summary, on_disk: false }} />)
    expect(screen.getByText("missing")).toBeInTheDocument()
  })

  it("renders without resource lines when there are no focus resources", () => {
    wrap(<WorktreeCard w={{ ...summary, focus_resources: [], primary_by_type: {}, primary_count: 0, resource_count: 0 }} />)
    expect(screen.getByText("my-branch")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Fix the widget/ })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/components/WorktreeCard.test.tsx`
Expected: FAIL — cannot resolve `./WorktreeCard`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/components/WorktreeCard.tsx`:

```tsx
import { Anchor, Badge, Group, Paper, Stack, Text } from "@mantine/core"
import { useLocation } from "wouter"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { resourceSummary } from "../lib/resourceSummary"
import { ResourceStatusIcon } from "./ResourceStatusIcon"

interface WorktreeCardProps {
  w: WorktreeSummary
  /**
   * When true (default) the card navigates to the worktree detail page.
   * The detail page renders the same card with clickable={false}, since we
   * are already there.
   */
  clickable?: boolean
}

function FocusResourceLine({ r }: { r: ResourceDTO }) {
  const label = r.custom_name || r.title || r.id
  return (
    <Group gap={6} wrap="nowrap" align="center">
      <ResourceStatusIcon r={r} />
      {r.url ? (
        <Anchor
          href={r.url}
          target="_blank"
          rel="noreferrer"
          size="sm"
          // Stop the click reaching the card, so a resource link opens the
          // resource instead of navigating to the worktree.
          onClick={(e) => e.stopPropagation()}
          style={{ overflowWrap: "anywhere" }}
        >
          {label}
        </Anchor>
      ) : (
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>{label}</Text>
      )}
    </Group>
  )
}

export function WorktreeCard({ w, clickable = true }: WorktreeCardProps) {
  const [, navigate] = useLocation()
  const href = `/worktree/${encodeURIComponent(w.path)}`
  const summary = resourceSummary(w.primary_by_type, w.related_count)

  const go = () => navigate(href)

  return (
    <Paper p="sm" withBorder>
      <Stack gap={6}>
        <Group gap="xs" wrap="wrap">
          {clickable ? (
            <Anchor
              href={href}
              aria-label={`open worktree ${w.branch}`}
              onClick={(e) => {
                e.preventDefault()
                go()
              }}
              fw={600}
              size="sm"
              style={{ overflowWrap: "anywhere" }}
            >
              {w.branch}
            </Anchor>
          ) : (
            <Text fw={600} size="sm" style={{ overflowWrap: "anywhere" }}>{w.branch}</Text>
          )}
          {!w.on_disk && <Badge size="xs" color="red">missing</Badge>}
        </Group>
        <Text size="xs" c="dimmed">
          {w.repo}{summary ? ` · ${summary}` : ""}
        </Text>
        {w.focus_resources.length > 0 && (
          <Stack gap={2}>
            {w.focus_resources.map((r) => (
              <FocusResourceLine key={`${r.type}:${r.id}`} r={r} />
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/components/WorktreeCard.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add ui/src/components/WorktreeCard.tsx ui/src/components/WorktreeCard.test.tsx
git commit --signoff -m "feat(ui): add WorktreeCard listing focus resources with status icons"
```

---

### Task 9: HomePage — worktree cards plus a responsive tab bar

**Files:**
- Modify: `ui/src/pages/HomePage.tsx`
- Modify: `ui/src/components/WorktreeList.tsx` (render cards)
- Test: `ui/src/pages/HomePage.test.tsx`
- Test: `ui/src/components/WorktreeList.test.tsx` (update existing)

**Interfaces:**
- Consumes: `useIsWide` (Task 3), `WorktreeCard` (Task 8).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `ui/src/pages/HomePage.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { setViewport } from "../testing/viewport"
import type { WorktreeSummary } from "../api/types"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 1, primary_count: 1, latest_event_ts: "",
  primary_by_type: { pr: 1 }, related_count: 0,
  focus_resources: [{ type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN" }],
}

vi.mock("../hooks/useWorktrees", () => ({ useWorktrees: () => ({ data: [summary] }) }))
vi.mock("../hooks/useTimeline", () => ({
  useGlobalTimeline: () => ({ data: { events: [], next_cursor: "" }, isLoading: false, error: null }),
}))

import { HomePage } from "./HomePage"

const wrap = () => {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MantineProvider><HomePage /></MantineProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => window.history.replaceState({}, "", "/"))
afterEach(cleanup)

describe("HomePage responsive layout", () => {
  it("shows a Worktrees/Timeline tab bar when narrow", () => {
    setViewport("narrow")
    wrap()
    expect(screen.getByRole("tab", { name: "Worktrees" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Timeline" })).toBeInTheDocument()
  })

  it("shows no tab bar when wide", () => {
    setViewport("wide")
    wrap()
    expect(screen.queryByRole("tab", { name: "Worktrees" })).not.toBeInTheDocument()
  })

  it("renders worktrees as cards with their focus resources in both layouts", () => {
    setViewport("wide")
    wrap()
    expect(screen.getByText("my-branch")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Fix the widget/ })).toBeInTheDocument()
  })
})
```

Then update `ui/src/components/WorktreeList.test.tsx` so its expectations match card rendering. Replace its body with:

```tsx
import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import type { WorktreeSummary } from "../api/types"
import { WorktreeList } from "./WorktreeList"

const summary: WorktreeSummary = {
  path: "/wt/foo", repo: "odh", branch: "my-branch",
  on_disk: true, resource_count: 1, primary_count: 1, latest_event_ts: "",
  primary_by_type: { pr: 1 }, related_count: 0,
  focus_resources: [{ type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN" }],
}

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(cleanup)

describe("WorktreeList", () => {
  it("renders a card per worktree", () => {
    wrap(<WorktreeList items={[summary]} />)
    expect(screen.getByText("my-branch")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Fix the widget/ })).toBeInTheDocument()
  })

  it("shows an empty state with no worktrees", () => {
    wrap(<WorktreeList items={[]} />)
    expect(screen.getByText(/No worktrees/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/pages/HomePage.test.tsx src/components/WorktreeList.test.tsx`
Expected: FAIL — no tab roles exist, and `WorktreeList` still renders `NavLink`s without focus-resource links.

- [ ] **Step 3: Write minimal implementation**

Replace `ui/src/components/WorktreeList.tsx`:

```tsx
import { Stack, Text } from "@mantine/core"
import type { WorktreeSummary } from "../api/types"
import { WorktreeCard } from "./WorktreeCard"

export function WorktreeList({ items }: { items: WorktreeSummary[] }) {
  if (items.length === 0) return <Text c="dimmed" size="sm">No worktrees. Create one with `worktree add`.</Text>
  return (
    <Stack gap="xs">
      {items.map((w) => <WorktreeCard key={w.path} w={w} />)}
    </Stack>
  )
}
```

Replace `ui/src/pages/HomePage.tsx`:

```tsx
import { useState } from "react"
import { Grid, Group, Stack, Tabs, Title } from "@mantine/core"
import { useWorktrees } from "../hooks/useWorktrees"
import { useGlobalTimeline } from "../hooks/useTimeline"
import { useIsWide } from "../hooks/useIsWide"
import { WorktreeList } from "../components/WorktreeList"
import { TimelineFeed } from "../components/TimelineFeed"
import { ArchivedToggle } from "../components/ArchivedToggle"

export function HomePage() {
  const [archived, setArchived] = useState(false)
  const wide = useIsWide()
  const wts = useWorktrees()
  const tl = useGlobalTimeline(archived)

  const worktrees = <WorktreeList items={wts.data ?? []} />
  const timeline = (
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={4}>Timeline</Title>
        <ArchivedToggle value={archived} onChange={setArchived} />
      </Group>
      <TimelineFeed events={tl.data?.events ?? []} loading={tl.isLoading} error={tl.error} showWorktrees />
    </Stack>
  )

  // Narrow: the two panes would otherwise stack, pushing the worktree list
  // far off-screen, so offer them as tabs instead.
  if (!wide) {
    return (
      <Stack p="md" gap="sm">
        <Tabs defaultValue="worktrees">
          <Tabs.List>
            <Tabs.Tab value="worktrees">Worktrees</Tabs.Tab>
            <Tabs.Tab value="timeline">Timeline</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="worktrees" pt="md">{worktrees}</Tabs.Panel>
          <Tabs.Panel value="timeline" pt="md">{timeline}</Tabs.Panel>
        </Tabs>
      </Stack>
    )
  }

  return (
    <Grid p="md" gutter="md">
      <Grid.Col span={4}>
        <Stack gap="sm">
          <Title order={4}>Worktrees</Title>
          {worktrees}
        </Stack>
      </Grid.Col>
      <Grid.Col span={8}>{timeline}</Grid.Col>
    </Grid>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run`
Expected: PASS across the suite.

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add ui/src/pages/HomePage.tsx ui/src/pages/HomePage.test.tsx ui/src/components/WorktreeList.tsx ui/src/components/WorktreeList.test.tsx
git commit --signoff -m "feat(ui): worktree cards on the home page with a narrow-viewport tab bar"
```

---

### Task 10: `ResourceCard` — compact/detail variants and selection

**Files:**
- Modify: `ui/src/components/ResourceCard.tsx`
- Test: `ui/src/components/ResourceCard.test.tsx` (extend)

**Interfaces:**
- Consumes: `ResourceStatusIcon` (Task 7).
- Produces: `<ResourceCard r path onRemoved variant?="compact"|"detail" selected?=boolean onSelect?=() => void />` — used by Tasks 11 and 12.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/components/ResourceCard.test.tsx`:

```tsx
describe("ResourceCard variants and selection", () => {
  const jira: ResourceDTO = {
    type: "jira", id: "J-1", url: "https://jira/browse/J-1", primary: true,
    title: "Investigate flux", status: "In Progress", labels: ["backend", "urgent"],
  } as ResourceDTO

  it("hides Jira labels in the compact variant", () => {
    wrap(<ResourceCard r={jira} />)
    expect(screen.queryByText("backend")).not.toBeInTheDocument()
  })

  it("shows Jira labels in the detail variant", () => {
    wrap(<ResourceCard r={jira} variant="detail" />)
    expect(screen.getByText("backend")).toBeInTheDocument()
    expect(screen.getByText("urgent")).toBeInTheDocument()
  })

  it("calls onSelect when a selectable card is clicked", async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceCard r={jira} onSelect={onSelect} />)
    await user.click(screen.getByRole("button", { name: /select resource J-1/i }))
    expect(onSelect).toHaveBeenCalled()
  })

  it("marks a selected card as pressed for assistive tech", () => {
    wrap(<ResourceCard r={jira} onSelect={() => {}} selected />)
    expect(screen.getByRole("button", { name: /select resource J-1/i })).toHaveAttribute("aria-pressed", "true")
  })

  it("does not select when the remove control is used", async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    wrap(<ResourceCard r={jira} onSelect={onSelect} />)
    await user.click(screen.getByRole("button", { name: "Remove resource" }))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
```

Ensure the test file imports `userEvent`, `vi`, `screen`, and `ResourceDTO`, and has a `wrap` helper wrapping in `MantineProvider` (mirror the existing helpers already in this file; add any that are missing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/components/ResourceCard.test.tsx`
Expected: FAIL — labels render in compact, and there is no selectable button role.

- [ ] **Step 3: Write minimal implementation**

In `ui/src/components/ResourceCard.tsx`:

1. Change `JiraCardBody` to take the variant and gate labels on it:

```tsx
function JiraCardBody({ r, variant }: { r: ResourceDTO; variant: ResourceCardVariant }) {
```

and replace the labels block with:

```tsx
      {variant === "detail" && r.labels && r.labels.length > 0 && (
        <Group gap={4} wrap="wrap">
          {r.labels.map((l) => <Badge key={l} size="xs" variant="dot">{l}</Badge>)}
        </Group>
      )}
```

2. Replace the component's props and body:

```tsx
export type ResourceCardVariant = "compact" | "detail"

interface ResourceCardProps {
  r: ResourceDTO
  path?: string
  onRemoved?: () => void
  /** "detail" adds the fuller summary (e.g. Jira labels) shown in the pane. */
  variant?: ResourceCardVariant
  selected?: boolean
  /** When provided, the card becomes selectable. */
  onSelect?: () => void
}

export function ResourceCard({
  r,
  path = "",
  onRemoved = () => {},
  variant = "compact",
  selected = false,
  onSelect,
}: ResourceCardProps) {
  const body = r.type === "slack" ? (
    <SlackCardBody r={r} />
  ) : !isEnriched(r) ? (
    <MinimalRow r={r} />
  ) : r.type === "pr" ? (
    <PRCardBody r={r} />
  ) : r.type === "jira" ? (
    <JiraCardBody r={r} variant={variant} />
  ) : (
    <MinimalRow r={r} />
  )

  return (
    <Paper
      p="xs"
      withBorder
      // A selected card is tinted so the current selection is obvious next to
      // the pane it drives.
      bg={selected ? "var(--mantine-color-blue-light)" : undefined}
      style={selected ? { borderColor: "var(--mantine-color-blue-filled)" } : undefined}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        {onSelect ? (
          <UnstyledButton
            onClick={onSelect}
            aria-pressed={selected}
            aria-label={`select resource ${r.id}`}
            style={{ flex: 1, minWidth: 0, textAlign: "left" }}
          >
            {body}
          </UnstyledButton>
        ) : (
          <div style={{ flex: 1, minWidth: 0 }}>{body}</div>
        )}
        <RemoveControl r={r} path={path} onRemoved={onRemoved} />
      </Group>
    </Paper>
  )
}
```

3. Add `UnstyledButton` to the `@mantine/core` import.

4. In `RemoveControl`, stop the click from reaching the selectable region — change the `ActionIcon`'s handler to:

```tsx
          onClick={(e) => {
            e.stopPropagation()
            setOpened((v) => !v)
          }}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/components/ResourceCard.test.tsx`
Expected: PASS, including the file's pre-existing tests.

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add ui/src/components/ResourceCard.tsx ui/src/components/ResourceCard.test.tsx
git commit --signoff -m "feat(ui): add compact/detail variants and selection to ResourceCard"
```

---

### Task 11: `ResourceDetailPane` — the swappable pane

**Files:**
- Create: `ui/src/components/ResourceDetailPane.tsx`
- Test: `ui/src/components/ResourceDetailPane.test.tsx`

**Interfaces:**
- Consumes: `useWorktreeTimeline(path, resource?)` (Task 4), `ResourceCard` `variant="detail"` (Task 10), existing `TimelineFeed`.
- Produces: `<ResourceDetailPane path resource onBack? />` — used by Task 12.

**Phase B note:** this component is where item 6 lands — a `resource.type === "slack"` branch rendering the thread instead of the filtered timeline. Leave the marked comment in place for that.

- [ ] **Step 1: Write the failing test**

Create `ui/src/components/ResourceDetailPane.test.tsx`:

```tsx
import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO } from "../api/types"

const useWorktreeTimeline = vi.fn()
vi.mock("../hooks/useTimeline", () => ({
  useWorktreeTimeline: (...args: unknown[]) => useWorktreeTimeline(...args),
}))

import { ResourceDetailPane } from "./ResourceDetailPane"

const jira: ResourceDTO = {
  type: "jira", id: "J-1", url: "https://jira/browse/J-1", primary: true,
  title: "Investigate flux", status: "In Progress", labels: ["backend"],
} as ResourceDTO

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(() => {
  cleanup()
  useWorktreeTimeline.mockReset()
})

describe("ResourceDetailPane", () => {
  it("requests the timeline filtered to the selected resource", () => {
    useWorktreeTimeline.mockReturnValue({ data: { events: [], next_cursor: "" }, isLoading: false, error: null })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(useWorktreeTimeline).toHaveBeenCalledWith("/wt/foo", { type: "jira", id: "J-1" })
  })

  it("shows the detailed resource summary, including Jira labels", () => {
    useWorktreeTimeline.mockReturnValue({ data: { events: [], next_cursor: "" }, isLoading: false, error: null })
    wrap(<ResourceDetailPane path="/wt/foo" resource={jira} />)
    expect(screen.getByText("backend")).toBeInTheDocument()
  })

  it("renders a back control only when onBack is supplied", async () => {
    useWorktreeTimeline.mockReturnValue({ data: { events: [], next_cursor: "" }, isLoading: false, error: null })
    const onBack = vi.fn()
    const user = userEvent.setup()
    const { rerender } = wrap(<ResourceDetailPane path="/wt/foo" resource={jira} onBack={onBack} />)
    await user.click(screen.getByRole("button", { name: /all resources for worktree/i }))
    expect(onBack).toHaveBeenCalled()

    rerender(<MantineProvider><ResourceDetailPane path="/wt/foo" resource={jira} /></MantineProvider>)
    expect(screen.queryByRole("button", { name: /all resources for worktree/i })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/components/ResourceDetailPane.test.tsx`
Expected: FAIL — cannot resolve `./ResourceDetailPane`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/components/ResourceDetailPane.tsx`:

```tsx
import { Button, Stack, Title } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { useWorktreeTimeline } from "../hooks/useTimeline"
import { ResourceCard } from "./ResourceCard"
import { TimelineFeed } from "./TimelineFeed"

interface ResourceDetailPaneProps {
  path: string
  resource: ResourceDTO
  /** Supplied only on narrow viewports, where this pane is a drilldown. */
  onBack?: () => void
}

/**
 * The selected-resource pane: a fuller summary of the resource above a
 * timeline filtered to just that resource.
 *
 * This is deliberately a swappable slot. Phase B (see
 * docs/superpowers/specs/2026-08-21-worktree-ui-resource-selection-design.md)
 * adds a `resource.type === "slack"` branch here that renders the Slack
 * thread in place of the filtered timeline — the surrounding responsive
 * shell, selection state, and back control stay exactly as they are.
 */
export function ResourceDetailPane({ path, resource, onBack }: ResourceDetailPaneProps) {
  const timeline = useWorktreeTimeline(path, { type: resource.type, id: resource.id })

  return (
    <Stack gap="sm">
      {onBack && (
        <Button variant="subtle" size="compact-sm" onClick={onBack} style={{ alignSelf: "flex-start" }}>
          ← all resources for worktree
        </Button>
      )}
      <ResourceCard r={resource} variant="detail" />
      <Title order={5}>Activity</Title>
      <TimelineFeed
        events={timeline.data?.events ?? []}
        loading={timeline.isLoading}
        error={timeline.error}
      />
    </Stack>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/components/ResourceDetailPane.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add ui/src/components/ResourceDetailPane.tsx ui/src/components/ResourceDetailPane.test.tsx
git commit --signoff -m "feat(ui): add ResourceDetailPane with resource-filtered activity"
```

---

### Task 12: WorktreeDetailPage — card header, selection, responsive drilldown

**Files:**
- Modify: `ui/src/pages/WorktreeDetailPage.tsx`
- Modify: `ui/src/components/ResourceList.tsx` (selection wiring)
- Test: `ui/src/pages/WorktreeDetailPage.test.tsx`

**Note on getting the summary:** `useWorktrees()` already returns the whole
list under the React Query key `["worktrees"]`, so the detail page reuses it
and picks its own row with `.find((w) => w.path === path)`. No new hook and
no new endpoint — on a normal navigation from the home page this is a cache
hit. When the row is not present yet (deep link, cache cold) the card simply
does not render until the query resolves.

**Interfaces:**
- Consumes: `useSelectedResource` (Task 6), `useIsWide` (Task 3), `WorktreeCard` (Task 8), `ResourceDetailPane` (Task 11), `ResourceCard` selection props (Task 10).
- Produces: `ResourceList` gains `selectedKey?: ResourceKey | null` and `onSelectResource?: (key: ResourceKey) => void`.

**Behavior to implement (from the spec):**
- `WorktreeCard clickable={false}` above the existing Overview/Slack tabs (tabs stay — Phase B removes them).
- Wide: resource list beside the pane (or the unfiltered timeline when nothing is selected).
- Narrow + nothing selected: the resource list.
- Narrow + something selected: the pane with the back control.
- A `?resource=` that matches no loaded resource is cleared.

- [ ] **Step 1: Write the failing test**

Create `ui/src/pages/WorktreeDetailPage.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO } from "../api/types"

const resources: ResourceDTO[] = [
  { type: "pr", id: "o/r#1", url: "https://gh/pr/1", primary: true, title: "Fix the widget", state: "OPEN" } as ResourceDTO,
  { type: "jira", id: "J-1", url: "https://jira/J-1", primary: true, title: "Investigate flux", status: "In Progress" } as ResourceDTO,
]

vi.mock("../hooks/useWorktreeDetail", () => ({
  useWorktreeDetail: () => ({
    resources: { data: resources, refetch: vi.fn() },
    timeline: { data: { events: [], next_cursor: "" }, isLoading: false, error: null },
  }),
}))
vi.mock("../hooks/useWorktrees", () => ({ useWorktrees: () => ({ data: [] }) }))
vi.mock("../hooks/useTimeline", () => ({
  useWorktreeTimeline: () => ({ data: { events: [], next_cursor: "" }, isLoading: false, error: null }),
}))
vi.mock("../components/SlackTab", () => ({ SlackTab: () => <div>slack tab</div> }))

import { setViewport } from "../testing/viewport"
import { WorktreeDetailPage } from "./WorktreeDetailPage"

const wrap = () => render(<MantineProvider><WorktreeDetailPage /></MantineProvider>)

beforeEach(() => window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}`))
afterEach(cleanup)

describe("WorktreeDetailPage selection", () => {
  it("selects a resource on click and records it in the URL", async () => {
    setViewport("wide")
    const user = userEvent.setup()
    wrap()
    await user.click(screen.getByRole("button", { name: /select resource o\/r#1/i }))
    await waitFor(() => expect(window.location.search).toContain("resource=pr%3A"))
  })

  it("shows the drilldown with a back control when narrow and selected", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("narrow")
    wrap()
    expect(await screen.findByRole("button", { name: /all resources for worktree/i })).toBeInTheDocument()
  })

  it("returns to the list when the back control is used", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("narrow")
    const user = userEvent.setup()
    wrap()
    await user.click(await screen.findByRole("button", { name: /all resources for worktree/i }))
    await waitFor(() => expect(window.location.search).not.toContain("resource="))
  })

  it("keeps the resource list visible beside the pane when wide", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:o%2Fr%231`)
    setViewport("wide")
    wrap()
    // The list is still there (the other resource is selectable) and there is
    // no back control in the wide layout.
    expect(await screen.findByRole("button", { name: /select resource J-1/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /all resources for worktree/i })).not.toBeInTheDocument()
  })

  it("clears a ?resource= that matches no loaded resource", async () => {
    window.history.replaceState({}, "", `/worktree/${encodeURIComponent("/wt/foo")}?resource=pr:gone%23999`)
    setViewport("wide")
    wrap()
    await waitFor(() => expect(window.location.search).not.toContain("resource="))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/pages/WorktreeDetailPage.test.tsx`
Expected: FAIL — resource cards are not selectable and no drilldown exists.

- [ ] **Step 3: Write minimal implementation**

First extend `ui/src/components/ResourceList.tsx` — add to its props and pass them through to each card:

```tsx
import type { ResourceKey } from "../lib/resourceKey"

interface ResourceListProps {
  items: ResourceDTO[]
  path: string
  onChanged: () => void
  selectedKey?: ResourceKey | null
  onSelectResource?: (key: ResourceKey) => void
}
```

and in **both** the Focus and Related `.map(...)` calls, replace the `<ResourceCard .../>` with:

```tsx
                  <ResourceCard
                    key={`${r.type}:${r.id}`}
                    r={r}
                    path={path}
                    onRemoved={onChanged}
                    selected={selectedKey?.type === r.type && selectedKey?.id === r.id}
                    onSelect={onSelectResource ? () => onSelectResource({ type: r.type, id: r.id }) : undefined}
                  />
```

Then replace `ui/src/pages/WorktreeDetailPage.tsx`:

```tsx
import { useEffect } from "react"
import { Anchor, Grid, Group, Stack, Tabs, Title } from "@mantine/core"
import { Link, useRoute } from "wouter"
import { useWorktreeDetail } from "../hooks/useWorktreeDetail"
import { useSelectedResource } from "../hooks/useSelectedResource"
import { useIsWide } from "../hooks/useIsWide"
import { useWorktrees } from "../hooks/useWorktrees"
import { ResourceList } from "../components/ResourceList"
import { ResourceDetailPane } from "../components/ResourceDetailPane"
import { TimelineFeed } from "../components/TimelineFeed"
import { WorktreeCard } from "../components/WorktreeCard"
import { SlackTab } from "../components/SlackTab"

export function WorktreeDetailPage() {
  const [, params] = useRoute("/worktree/:path*")
  const rawPath = params?.["path*"]
  const path = rawPath ? decodeURIComponent(rawPath) : ""
  const { resources, timeline } = useWorktreeDetail(path)
  const { selected, toggle, clear } = useSelectedResource()
  const wide = useIsWide()
  const worktrees = useWorktrees()
  const branch = path.split("/").pop() || path

  const items = resources.data ?? []
  const summary = (worktrees.data ?? []).find((w) => w.path === path)
  const selectedResource = selected
    ? items.find((r) => r.type === selected.type && r.id === selected.id)
    : undefined

  // A ?resource= pointing at something this worktree no longer has (removed
  // out-of-band, or a stale shared link) must not leave an empty pane.
  useEffect(() => {
    if (selected && resources.data && !selectedResource) clear()
  }, [selected, resources.data, selectedResource, clear])

  const list = (
    <ResourceList
      items={items}
      path={path}
      onChanged={resources.refetch}
      selectedKey={selected}
      onSelectResource={toggle}
    />
  )

  const unfiltered = (
    <Stack gap="sm">
      <Title order={5}>Timeline</Title>
      <TimelineFeed events={timeline.data?.events ?? []} loading={timeline.isLoading} error={timeline.error} />
    </Stack>
  )

  // Narrow + a selection drills down to the resource, replacing the list.
  // Wide shows both. Both read the same selection state, so resizing swaps
  // presentation without disturbing what is selected.
  const overview = !wide ? (
    selectedResource ? (
      <ResourceDetailPane path={path} resource={selectedResource} onBack={clear} />
    ) : (
      list
    )
  ) : (
    <Grid gutter="md">
      <Grid.Col span={4}>{list}</Grid.Col>
      <Grid.Col span={8}>
        {selectedResource ? <ResourceDetailPane path={path} resource={selectedResource} /> : unfiltered}
      </Grid.Col>
    </Grid>
  )

  return (
    <Stack p="md" gap="md">
      <Group>
        <Anchor component={Link} href="/">← all worktrees</Anchor>
        <Title order={4}>{branch}</Title>
      </Group>
      {summary && <WorktreeCard w={summary} clickable={false} />}
      <Tabs defaultValue="overview">
        <Tabs.List>
          <Tabs.Tab value="overview">Overview</Tabs.Tab>
          <Tabs.Tab value="slack">Slack</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview" pt="md">{overview}</Tabs.Panel>
        <Tabs.Panel value="slack" pt="md"><SlackTab path={path} /></Tabs.Panel>
      </Tabs>
    </Stack>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run`
Expected: PASS across the whole suite.

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add ui/src/pages/WorktreeDetailPage.tsx ui/src/pages/WorktreeDetailPage.test.tsx ui/src/components/ResourceList.tsx
git commit --signoff -m "feat(ui): worktree card header, resource selection, responsive drilldown"
```

---

### Task 13: Documentation and full verification

**Files:**
- Modify: `docs/web-ui-architecture.md`
- Modify: `docs/ui-feature-roadmap.md`

- [ ] **Step 1: Update the architecture doc**

In `docs/web-ui-architecture.md`:

1. In the **HTTP API surface** table, change the `/api/worktree-timeline` row's params to:
   `path` (required), `limit`, `resource_type` + `resource_id` (optional, must be supplied together; 400 otherwise)
2. In the **`worktreeSummary`** block, add:
   `focus_resources  []resourceDTO   // primary resources, enriched; always [] never null`
3. Add a short subsection under **Frontend structure** documenting: `useIsWide()` as the single breakpoint predicate (48em), `useSelectedResource()` and the `?resource=<type>:<id>` param (noting the first-colon split for Slack ids), `WorktreeCard` being shared by both pages, and `ResourceDetailPane` being the swappable pane Phase B will branch in.
4. Note the testing trap: `test-setup.ts` stubs `matchMedia` to `matches: false`, so tests render **narrow** unless they call `setViewport("wide")` from `ui/src/testing/viewport.ts`.

- [ ] **Step 2: Update the roadmap**

In `docs/ui-feature-roadmap.md`, move the completed items into the "In progress / recently done" section (worktree cards, responsive tab bar, resource selection + filtered timeline, responsive drilldown) and add a **Phase B** entry for the Slack restructure that points at the spec.

- [ ] **Step 3: Full verification**

```bash
cd ui && npx vitest run && npm run build
cd .. && go build ./... && go test ./...
```

Expected: all frontend tests pass, `tsc -b && vite build` succeeds, Go builds and all Go tests pass.

- [ ] **Step 4: Manual smoke check**

```bash
make build && ./bin/worktree ui
```

Confirm by hand: the home page shows worktree cards with focus-resource lines; narrowing the window swaps to the Worktrees/Timeline tabs; on a worktree page, clicking a resource card highlights it, filters the activity feed, and updates `?resource=`; narrowing while a resource is selected shows the drilldown with the same selection; the back control and a second click both deselect.

- [ ] **Step 5: Commit** (ask the user first)

```bash
git add docs/web-ui-architecture.md docs/ui-feature-roadmap.md
git commit --signoff -m "docs: document worktree cards, resource selection, and responsive layout"
```

---

## Self-review notes

- **Spec coverage:** item 1 → Task 9; item 2 → Tasks 1, 7, 8, 9; item 3 → Task 12; item 4 → Tasks 2, 4, 10, 11, 12; item 5 → Tasks 3, 5, 6, 12. Item 6 is Phase B and deliberately unplanned here, with its seam established in Task 11.
- **Type consistency:** `ResourceKey` (Task 5) is the single selection type used by Tasks 6, 11, and 12. `useWorktreeTimeline(path, resource?)` (Task 4) is called with that exact shape in Task 11. `resourceStatusMeta`/`ResourceStatusIcon` (Task 7) are consumed only by Task 8.
- **Known follow-up, out of scope:** making `enrichEvent` cheaper (roadmapped); Task 2 routes around its cost but does not fix it.
