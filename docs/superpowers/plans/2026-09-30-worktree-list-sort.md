# Worktree List Sort Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sort control to the home page's worktree list with five orders (cmux order, Latest activity, Created, Name, Unread first). The choice is remembered per browser.

**Architecture:** The backend gains two small fields: `created_at` on each worktree summary, and `index` (position in cmux's workspace list) on each cmux workspace. All sorting happens client-side in a pure `lib/worktreeSort.ts`. `localStorage` persistence lives in `lib/worktreeSortPref.ts`, and a `useWorktreeSort` hook resolves the effective mode, including the cmux-dependent default. A presentational `WorktreeSortControl` renders the choice, and `HomePage` wires everything together.

**Tech Stack:** Go (net/http, `internal/webui`), React 19 + Mantine 7 + TanStack Query 5, Vitest + Testing Library.

**Spec:** No separate spec file. The design was approved in the conversation that produced this plan and is reproduced here:

- **Modes:**
  - **cmux order:** offered only when cmux is available. Worktrees are ordered by the position of their FIRST (earliest-positioned) matching cmux workspace in cmux's workspace list. Worktrees without a workspace go at the bottom.
  - **Latest activity:** `latest_event_ts`, newest first. Worktrees with no events go at the bottom.
  - **Created:** `created_at`, with an ascending/descending toggle that defaults to ascending. The toggle is shown only in this mode.
  - **Name:** repo, then branch, then path. This is the registry's existing `ORDER BY repo, path` order, made explicit.
  - **Unread first:** `has_unread` first, then `unread_count` highest first, then latest activity.
- **Default:** with nothing saved, the mode is cmux order when cmux is available, otherwise Latest activity.
- **Persistence:** the mode and the created direction are stored per browser in `localStorage`. If the saved mode is cmux but cmux is unavailable, the list shows Latest activity WITHOUT overwriting the saved choice.
- **Ties:** every mode breaks ties by Name order. Missing or unparseable values sort to the bottom regardless of direction.
- **cmux refresh:** `useCmux` refetches every 15s, so cmux order follows workspace drags in cmux. The list is expected to reorder itself.
- **Out of scope:** group by repo. It may come later.

## Global Constraints

- Every `localStorage` read and write is wrapped in try/catch. A throwing or garbage-filled storage falls back to defaults and never breaks the page.
- Never use empty-string fallbacks to fake "not ready". While the default depends on a cmux answer that hasn't arrived, the sort mode is `null`, and the list renders in the order the server sent it.
- Commits use `--signoff` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage files by name (never `git add -A` / `git add .`).
- Commit prefixes follow the repo: `feat(webui):` for Go API, `feat(ui):` for frontend, `docs:` for docs.
- Frontend tests: `cd ui && npx vitest run <file>` for one file, `cd ui && npm test` for all. Go tests: `make test` or `go test ./internal/webui/ -run <Name>`.
- Type-check the frontend with `cd ui && npx tsc -b` before each frontend commit.
- Do not disable lint rules.

## Review Focus

1. **Storage throws or holds garbage:** a private window with blocked storage, or a value like `"bogus"` saved by an older build, yields the default mode and never a crash or a blank select. Pinned in Task 4.
2. **Saved cmux, cmux unavailable** (e.g. `worktree ui` launched outside cmux): the list shows Latest activity, the stored value stays `"cmux"`, and cmux order returns when cmux is back. Pinned in Tasks 3 and 4.
3. **Empty or unparseable timestamps:** `latest_event_ts: ""` for a worktree with no events, or a legacy `created_at` that isn't RFC3339, sort to the bottom in both directions instead of scrambling the order via `NaN` comparisons. Pinned in Task 3.
4. **A worktree with several workspaces** uses its earliest-positioned one, not the first in the match array. Pinned in Task 3 (`cmuxPositions`).
5. **cmux query still pending on first load:** no flash of activity order before cmux order. The mode is `null`, the list stays in server order and the control isn't rendered. Pinned in Tasks 3, 4 and 5.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `internal/webui/worktrees.go` | Modify | Add `CreatedAt` to `worktreeSummary` |
| `internal/webui/worktrees_test.go` | Modify | Assert `created_at` is returned |
| `internal/webui/cmux_api.go` | Modify | Add `Index` to `cmuxWorkspaceDTO` |
| `internal/webui/cmux_api_test.go` | Modify | Assert `index` is the list position |
| `ui/src/api/types.ts` | Modify | `created_at` on `WorktreeSummary`, `index` on `CmuxWorkspace` |
| `ui/src/lib/worktreeSort.ts` | Create | Pure: mode types, `sortWorktrees`, `cmuxPositions`, `resolveSortMode`, `isSortMode` |
| `ui/src/lib/worktreeSort.test.ts` | Create | Unit tests for the above |
| `ui/src/lib/worktreeSortPref.ts` | Create | `localStorage` read/write of mode + created direction |
| `ui/src/lib/worktreeSortPref.test.ts` | Create | Round-trip, garbage, throwing storage |
| `ui/src/hooks/useWorktreeSort.ts` | Create | State + persistence + cmux-aware effective mode |
| `ui/src/hooks/useWorktreeSort.test.tsx` | Create | Hook behavior with a mocked `api.cmux` |
| `ui/src/components/WorktreeSortControl.tsx` | Create | Presentational `NativeSelect` + direction toggle |
| `ui/src/components/WorktreeSortControl.test.tsx` | Create | Options, change events, toggle visibility |
| `ui/src/pages/HomePage.tsx` | Modify | Wire hook + control, sort the list |
| `ui/src/pages/HomePage.test.tsx` | Modify | End-to-end ordering on the page |
| `docs/web-ui-architecture.md` | Modify | Document the feature |

`NativeSelect` is used instead of Mantine's `Select` on purpose: it's a real `<select>`, so it gets the native picker on a phone (this UI is used remotely from one) and is directly testable with `userEvent.selectOptions` under jsdom.

---

### Task 1: `created_at` on the worktree summary

**Files:**
- Modify: `internal/webui/worktrees.go` (struct at lines 12-41, literal at lines 92-106)
- Modify: `internal/webui/worktrees_test.go` (`TestWorktreesEndpoint`, ends ~line 85)
- Modify: `ui/src/api/types.ts` (`WorktreeSummary`, lines 13-33)

**Interfaces:**
- Produces: JSON field `created_at: string` on every `/api/worktrees` entry. It's the registry's stored value verbatim (RFC3339 for worktrees created by `worktree add`). TS: `created_at?: string` on `WorktreeSummary`. It's optional because an older cached response lacks it.

- [ ] **Step 1: Write the failing test**

In `internal/webui/worktrees_test.go`, at the end of `TestWorktreesEndpoint` (after the `latest_event_ts` check), add:

```go
	if w.CreatedAt != "2026-08-13T00:00:00Z" {
		t.Fatalf("created_at = %q, want the registry's stored value", w.CreatedAt)
	}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/webui/ -run TestWorktreesEndpoint$`
Expected: compile FAIL: `w.CreatedAt undefined (type worktreeSummary has no field or method CreatedAt)`

- [ ] **Step 3: Implement**

In `internal/webui/worktrees.go`, add to `worktreeSummary` directly after `LatestEventTS`:

```go
	// CreatedAt is the registry's stored creation time, passed through
	// verbatim so the UI can sort by it. Not parsed here: worktrees seeded by
	// the Phase 1 cutover may carry older formats, and the UI already treats
	// an unparseable value as missing.
	CreatedAt string `json:"created_at"`
```

and in the `worktreeSummary{...}` literal inside `handleWorktrees`, after the `LatestEventTS:` line:

```go
			CreatedAt:      e.CreatedAt,
```

(Run `gofmt -w internal/webui/worktrees.go` afterwards to realign the literal.)

In `ui/src/api/types.ts`, add to `WorktreeSummary` after the `unread_count` field:

```ts
  /**
   * The registry's creation time, verbatim — RFC3339 for anything made by
   * `worktree add`, but not guaranteed, so parse defensively. Absent on an
   * older cached response.
   */
  created_at?: string;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/webui/ -run TestWorktreesEndpoint && (cd ui && npx tsc -b)`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/worktrees.go internal/webui/worktrees_test.go ui/src/api/types.ts
git commit --signoff -m "feat(webui): include created_at in the worktree summary" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: cmux workspace position in `/api/cmux`

**Files:**
- Modify: `internal/webui/cmux_api.go` (`cmuxWorkspaceDTO` lines 14-19, `handleCmux` lines 36-77)
- Modify: `internal/webui/cmux_api_test.go`
- Modify: `ui/src/api/types.ts` (`CmuxWorkspace`, lines 1-6)

**Interfaces:**
- Produces: JSON field `index: number` on every workspace in `matches`. It's the workspace's 0-based position in `cmux workspace list`'s output, which is cmux's sidebar order. TS: `index?: number` on `CmuxWorkspace`, optional because existing test fixtures and older cached responses lack it.

**Why the position and not the ref:** `cmux workspace list` returns workspaces in sidebar order, but ref numbers do not follow it. A live listing had `workspace:19` before `workspace:17`. Refs are unique within a single listing, so the ref is the right map KEY, but the slice position is the VALUE.

- [ ] **Step 1: Write the failing test**

Append to `internal/webui/cmux_api_test.go`:

```go
func TestCmuxIndexIsListPositionNotRefNumber(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/x")

	conn, err := wdb.OpenAt(filepath.Join(t.TempDir(), "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	pathA := t.TempDir()
	pathB := t.TempDir()
	for _, p := range []string{pathA, pathB} {
		if err := registry.Register(conn, registry.Entry{Path: p, Repo: "r", RepoRoot: p, Branch: "b", CreatedAt: "now"}); err != nil {
			t.Fatal(err)
		}
	}

	s := &Server{
		DB: conn,
		cmuxList: func() ([]cmux.Workspace, error) {
			// Sidebar order, with ref numbers deliberately out of order the
			// way real cmux produces them after workspaces are moved.
			return []cmux.Workspace{
				{Ref: "workspace:9", Title: "unrelated", CurrentDirectory: t.TempDir()},
				{Ref: "workspace:19", Title: "b-first", CurrentDirectory: pathB},
				{Ref: "workspace:17", Title: "a", CurrentDirectory: pathA},
				{Ref: "workspace:2", Title: "b-second", CurrentDirectory: pathB},
			}, nil
		},
	}

	rec := httptest.NewRecorder()
	s.handleCmux(rec, httptest.NewRequest(http.MethodGet, "/api/cmux", nil))
	var got cmuxResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}

	idx := map[string]int{}
	for _, hits := range got.Matches {
		for _, h := range hits {
			idx[h.Ref] = h.Index
		}
	}
	want := map[string]int{"workspace:19": 1, "workspace:17": 2, "workspace:2": 3}
	for ref, w := range want {
		if idx[ref] != w {
			t.Errorf("index[%s] = %d, want %d", ref, idx[ref], w)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/webui/ -run TestCmuxIndexIsListPositionNotRefNumber`
Expected: compile FAIL: `h.Index undefined (type cmuxWorkspaceDTO has no field or method Index)`

- [ ] **Step 3: Implement**

In `internal/webui/cmux_api.go`, add to `cmuxWorkspaceDTO` after `Selected`:

```go
	// Index is the workspace's position in cmux's own listing, which is the
	// order its sidebar shows. Matches is keyed by path, so without this the
	// UI could not recover that order to sort worktrees by it. Not derived
	// from Ref: ref numbers do not follow the sidebar once workspaces move.
	Index int `json:"index"`
```

In `handleCmux`, directly after the `if err != nil { ... }` block that follows `workspaces, err := list()`, add:

```go
	// Refs are unique within one listing, which is all this map has to
	// survive: it is rebuilt on every request.
	position := make(map[string]int, len(workspaces))
	for i, ws := range workspaces {
		position[ws.Ref] = i
	}
```

and in the DTO literal inside the `for _, ws := range hits` loop, add the field:

```go
			dto := cmuxWorkspaceDTO{
				Ref:      ws.Ref,
				Title:    ws.DisplayTitle(),
				Selected: ws.Selected,
				Index:    position[ws.Ref],
			}
```

In `ui/src/api/types.ts`, add to `CmuxWorkspace`:

```ts
  /**
   * Position in cmux's workspace list (its sidebar order). Absent on an older
   * cached response; consumers treat that as "no position".
   */
  index?: number
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/webui/ -run TestCmux && (cd ui && npx tsc -b)`
Expected: PASS (the new test plus the existing `TestCmux*` tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/cmux_api.go internal/webui/cmux_api_test.go ui/src/api/types.ts
git commit --signoff -m "feat(webui): report each cmux workspace's sidebar position" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Pure sort library

**Files:**
- Create: `ui/src/lib/worktreeSort.ts`
- Test: `ui/src/lib/worktreeSort.test.ts`

**Interfaces:**
- Consumes: `WorktreeSummary.created_at` (Task 1), `CmuxWorkspace.index` (Task 2).
- Produces (all exported from `ui/src/lib/worktreeSort.ts`):
  - `type SortMode = "cmux" | "activity" | "created" | "name" | "unread"`
  - `type SortDir = "asc" | "desc"`
  - `const SORT_MODES: readonly SortMode[]` (display order: cmux, activity, created, name, unread)
  - `function isSortMode(v: unknown): v is SortMode`
  - `function cmuxPositions(matches: Record<string, CmuxWorkspace[]> | undefined): Record<string, number>`
  - `interface SortOptions { mode: SortMode; createdDir: SortDir; cmuxPositions: Record<string, number> }`
  - `function sortWorktrees(items: WorktreeSummary[], opts: SortOptions): WorktreeSummary[]` returns a NEW array and never mutates `items`
  - `function resolveSortMode(saved: SortMode | null, cmuxPending: boolean, cmuxAvailable: boolean): SortMode | null`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/worktreeSort.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { WorktreeSummary } from "../api/types"
import { cmuxPositions, isSortMode, resolveSortMode, sortWorktrees, type SortOptions } from "./worktreeSort"

function wt(branch: string, over: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path: `/wt/${branch}`, repo: "odh", branch,
    on_disk: true, resource_count: 0, primary_count: 0, latest_event_ts: "",
    primary_by_type: {}, related_count: 0, focus_resources: [],
    ...over,
  }
}

const opts = (over: Partial<SortOptions> = {}): SortOptions => ({
  mode: "name", createdDir: "asc", cmuxPositions: {}, ...over,
})

const branches = (items: WorktreeSummary[]) => items.map((w) => w.branch)

describe("sortWorktrees", () => {
  it("does not mutate its input", () => {
    const items = [wt("b"), wt("a")]
    sortWorktrees(items, opts())
    expect(branches(items)).toEqual(["b", "a"])
  })

  it("name: repo, then branch, then path", () => {
    const items = [
      wt("b", { repo: "zeta" }),
      wt("b", { repo: "alpha", path: "/wt/2" }),
      wt("a", { repo: "alpha" }),
      wt("b", { repo: "alpha", path: "/wt/1" }),
    ]
    expect(sortWorktrees(items, opts()).map((w) => `${w.repo}/${w.branch}${w.path}`)).toEqual([
      "alpha/a/wt/a", "alpha/b/wt/1", "alpha/b/wt/2", "zeta/b/wt/b",
    ])
  })

  it("activity: newest first, no events last, ties by name", () => {
    const items = [
      wt("none"),
      wt("old", { latest_event_ts: "2026-09-01T00:00:00Z" }),
      wt("new-b", { latest_event_ts: "2026-09-20T00:00:00Z" }),
      wt("new-a", { latest_event_ts: "2026-09-20T00:00:00Z" }),
    ]
    expect(branches(sortWorktrees(items, opts({ mode: "activity" })))).toEqual(["new-a", "new-b", "old", "none"])
  })

  it("created: ascending by default, descending on request, unparseable last both ways", () => {
    const items = [
      wt("legacy", { created_at: "now" }),
      wt("mid", { created_at: "2026-08-15T00:00:00Z" }),
      wt("missing"),
      wt("first", { created_at: "2026-08-01T00:00:00Z" }),
      wt("last", { created_at: "2026-09-01T00:00:00Z" }),
    ]
    expect(branches(sortWorktrees(items, opts({ mode: "created" })))).toEqual(["first", "mid", "last", "legacy", "missing"])
    expect(branches(sortWorktrees(items, opts({ mode: "created", createdDir: "desc" })))).toEqual(["last", "mid", "first", "legacy", "missing"])
  })

  it("cmux: by position, no workspace last, ties by name", () => {
    const items = [wt("none-b"), wt("second"), wt("none-a"), wt("first")]
    const pos = { "/wt/first": 0, "/wt/second": 4 }
    expect(branches(sortWorktrees(items, opts({ mode: "cmux", cmuxPositions: pos })))).toEqual(["first", "second", "none-a", "none-b"])
  })

  it("unread: unread first, more unread first, then latest activity, then name", () => {
    const items = [
      wt("read-new", { latest_event_ts: "2026-09-29T00:00:00Z" }),
      wt("slack-only", { has_unread: true, unread_count: 0, latest_event_ts: "2026-09-02T00:00:00Z" }),
      wt("three", { has_unread: true, unread_count: 3 }),
      wt("one-old", { has_unread: true, unread_count: 1, latest_event_ts: "2026-09-01T00:00:00Z" }),
      wt("one-new", { has_unread: true, unread_count: 1, latest_event_ts: "2026-09-10T00:00:00Z" }),
      wt("read-none"),
    ]
    expect(branches(sortWorktrees(items, opts({ mode: "unread" })))).toEqual([
      "three", "one-new", "one-old", "slack-only", "read-new", "read-none",
    ])
  })
})

describe("cmuxPositions", () => {
  it("takes each path's EARLIEST workspace, not the first in its array", () => {
    expect(cmuxPositions({
      "/wt/a": [
        { ref: "workspace:9", title: "late", selected: false, index: 7 },
        { ref: "workspace:3", title: "early", selected: false, index: 2 },
      ],
      "/wt/b": [{ ref: "workspace:1", title: "b", selected: false, index: 0 }],
    })).toEqual({ "/wt/a": 2, "/wt/b": 0 })
  })

  it("skips workspaces without an index and tolerates missing matches", () => {
    expect(cmuxPositions({ "/wt/a": [{ ref: "w", title: "t", selected: false }] })).toEqual({})
    expect(cmuxPositions(undefined)).toEqual({})
  })
})

describe("resolveSortMode", () => {
  it("honours any saved non-cmux mode immediately, even while cmux is pending", () => {
    expect(resolveSortMode("name", true, false)).toBe("name")
    expect(resolveSortMode("created", false, true)).toBe("created")
  })

  it("is undecided while cmux is pending and the answer matters", () => {
    expect(resolveSortMode(null, true, false)).toBeNull()
    expect(resolveSortMode("cmux", true, false)).toBeNull()
  })

  it("defaults to cmux when available, activity otherwise", () => {
    expect(resolveSortMode(null, false, true)).toBe("cmux")
    expect(resolveSortMode(null, false, false)).toBe("activity")
  })

  it("falls back to activity for a saved cmux mode when cmux is gone", () => {
    expect(resolveSortMode("cmux", false, false)).toBe("activity")
    expect(resolveSortMode("cmux", false, true)).toBe("cmux")
  })
})

describe("isSortMode", () => {
  it("accepts only known modes", () => {
    expect(isSortMode("unread")).toBe(true)
    expect(isSortMode("bogus")).toBe(false)
    expect(isSortMode(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npx vitest run src/lib/worktreeSort.test.ts`
Expected: FAIL. The suite fails to import `./worktreeSort`.

- [ ] **Step 3: Implement**

Create `ui/src/lib/worktreeSort.ts`:

```ts
import type { CmuxWorkspace, WorktreeSummary } from "../api/types"

/** The home page worktree list's sort orders. */
export type SortMode = "cmux" | "activity" | "created" | "name" | "unread"
export type SortDir = "asc" | "desc"

/** Every mode, in the order the picker lists them. */
export const SORT_MODES: readonly SortMode[] = ["cmux", "activity", "created", "name", "unread"]

export function isSortMode(v: unknown): v is SortMode {
  return typeof v === "string" && (SORT_MODES as readonly string[]).includes(v)
}

export interface SortOptions {
  mode: SortMode
  /** Only consulted in "created" mode. */
  createdDir: SortDir
  /** Path -> the worktree's earliest cmux workspace position; see cmuxPositions. */
  cmuxPositions: Record<string, number>
}

/**
 * Each worktree's position in cmux's sidebar: the EARLIEST of its matching
 * workspaces, which is not necessarily the first in its array. Paths with no
 * positioned workspace are absent, which is what sends them to the bottom.
 */
export function cmuxPositions(matches: Record<string, CmuxWorkspace[]> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [path, list] of Object.entries(matches ?? {})) {
    for (const ws of list) {
      if (typeof ws.index !== "number") continue
      if (!(path in out) || ws.index < out[path]) out[path] = ws.index
    }
  }
  return out
}

/**
 * Picks the mode to show.
 *
 * Returns null while the answer depends on a cmux query that has not come
 * back — the caller then leaves the list in server order rather than flashing
 * "activity" and jumping to "cmux" a moment later. A saved "cmux" falls back
 * to "activity" without the caller overwriting what was saved, so the choice
 * returns on its own once cmux is reachable again.
 */
export function resolveSortMode(saved: SortMode | null, cmuxPending: boolean, cmuxAvailable: boolean): SortMode | null {
  if (saved !== null && saved !== "cmux") return saved
  if (cmuxPending) return null
  return cmuxAvailable ? "cmux" : "activity"
}

type Compare = (a: WorktreeSummary, b: WorktreeSummary) => number

/** Byte-order compare, matching the registry's SQL ORDER BY. */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const byName: Compare = (a, b) =>
  cmpStr(a.repo, b.repo) || cmpStr(a.branch, b.branch) || cmpStr(a.path, b.path)

/** Empty and unparseable timestamps are "missing", never NaN. */
function parseTime(ts: string | undefined): number | undefined {
  if (!ts) return undefined
  const t = Date.parse(ts)
  return Number.isNaN(t) ? undefined : t
}

/** Missing values sort last whichever way the present ones run. */
function missingLast(a: number | undefined, b: number | undefined, dir: SortDir): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  return dir === "asc" ? a - b : b - a
}

const byActivity: Compare = (a, b) =>
  missingLast(parseTime(a.latest_event_ts), parseTime(b.latest_event_ts), "desc")

function comparatorFor({ mode, createdDir, cmuxPositions: pos }: SortOptions): Compare {
  switch (mode) {
    case "cmux":
      return (a, b) => missingLast(pos[a.path], pos[b.path], "asc")
    case "activity":
      return byActivity
    case "created":
      return (a, b) => missingLast(parseTime(a.created_at), parseTime(b.created_at), createdDir)
    case "name":
      return () => 0
    case "unread":
      return (a, b) =>
        Number(Boolean(b.has_unread)) - Number(Boolean(a.has_unread)) ||
        (b.unread_count ?? 0) - (a.unread_count ?? 0) ||
        byActivity(a, b)
  }
}

/** Returns a new, sorted array; every mode breaks ties by name. */
export function sortWorktrees(items: WorktreeSummary[], opts: SortOptions): WorktreeSummary[] {
  const primary = comparatorFor(opts)
  return [...items].sort((a, b) => primary(a, b) || byName(a, b))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/lib/worktreeSort.test.ts && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/worktreeSort.ts ui/src/lib/worktreeSort.test.ts
git commit --signoff -m "feat(ui): add worktree list sort orders" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Persistence and the `useWorktreeSort` hook

**Files:**
- Create: `ui/src/lib/worktreeSortPref.ts`
- Test: `ui/src/lib/worktreeSortPref.test.ts`
- Create: `ui/src/hooks/useWorktreeSort.ts`
- Test: `ui/src/hooks/useWorktreeSort.test.tsx`

**Interfaces:**
- Consumes: `SortMode`, `SortDir`, `isSortMode`, `resolveSortMode` from `ui/src/lib/worktreeSort.ts` (Task 3). `useCmux()` from `ui/src/api/cmux.ts`, which returns a TanStack `useQuery` result over `CmuxResponse`.
- Produces:
  - `ui/src/lib/worktreeSortPref.ts`: `readSortMode(): SortMode | null`, `writeSortMode(m: SortMode): void`, `readCreatedDir(): SortDir` (default `"asc"`), `writeCreatedDir(d: SortDir): void`. Storage keys: `worktree.home.sort.mode` and `worktree.home.sort.createdDir`.
  - `ui/src/hooks/useWorktreeSort.ts`: `useWorktreeSort(): WorktreeSort`, where

    ```ts
    interface WorktreeSort {
      mode: SortMode | null      // null = undecided (cmux pending)
      createdDir: SortDir
      cmuxAvailable: boolean
      setMode: (m: SortMode) => void
      setCreatedDir: (d: SortDir) => void
    }
    ```

- [ ] **Step 1: Write the failing storage tests**

Create `ui/src/lib/worktreeSortPref.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readCreatedDir, readSortMode, writeCreatedDir, writeSortMode } from "./worktreeSortPref"

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("worktreeSortPref", () => {
  it("round-trips the mode and direction", () => {
    writeSortMode("unread")
    writeCreatedDir("desc")
    expect(readSortMode()).toBe("unread")
    expect(readCreatedDir()).toBe("desc")
  })

  it("defaults when nothing is saved", () => {
    expect(readSortMode()).toBeNull()
    expect(readCreatedDir()).toBe("asc")
  })

  it("ignores garbage left by another build", () => {
    window.localStorage.setItem("worktree.home.sort.mode", "bogus")
    window.localStorage.setItem("worktree.home.sort.createdDir", "sideways")
    expect(readSortMode()).toBeNull()
    expect(readCreatedDir()).toBe("asc")
  })

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    expect(readSortMode()).toBeNull()
    expect(readCreatedDir()).toBe("asc")
    expect(() => writeSortMode("name")).not.toThrow()
    expect(() => writeCreatedDir("desc")).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/lib/worktreeSortPref.test.ts`
Expected: FAIL. The suite fails to import `./worktreeSortPref`.

- [ ] **Step 3: Implement storage**

Create `ui/src/lib/worktreeSortPref.ts`:

```ts
import { isSortMode, type SortDir, type SortMode } from "./worktreeSort"

/**
 * The home page sort choice, remembered per browser.
 *
 * localStorage rather than sessionStorage (contrast bannerDismiss.ts): this
 * is a preference, and a new tab or a restored cmux pane should keep it. It
 * is deliberately per-browser, not server state — the phone and the desktop
 * can sort differently.
 */
const MODE_KEY = "worktree.home.sort.mode"
const DIR_KEY = "worktree.home.sort.createdDir"

/** The saved mode, or null when none is saved or the value is unrecognised. */
export function readSortMode(): SortMode | null {
  try {
    const v = window.localStorage.getItem(MODE_KEY)
    return isSortMode(v) ? v : null
  } catch {
    // Blocked storage (private windows) throws outright; fall back to the default.
    return null
  }
}

export function writeSortMode(mode: SortMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode)
  } catch {
    // The hook's own state still applies the choice; only the memory is lost.
  }
}

export function readCreatedDir(): SortDir {
  try {
    return window.localStorage.getItem(DIR_KEY) === "desc" ? "desc" : "asc"
  } catch {
    return "asc"
  }
}

export function writeCreatedDir(dir: SortDir): void {
  try {
    window.localStorage.setItem(DIR_KEY, dir)
  } catch {
    // As writeSortMode.
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/lib/worktreeSortPref.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing hook tests**

Create `ui/src/hooks/useWorktreeSort.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { useWorktreeSort } from "./useWorktreeSort"

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe("useWorktreeSort", () => {
  it("is undecided until cmux answers, then defaults to cmux", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    expect(result.current.mode).toBeNull()
    await waitFor(() => expect(result.current.mode).toBe("cmux"))
    expect(result.current.cmuxAvailable).toBe(true)
  })

  it("defaults to activity without cmux", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    await waitFor(() => expect(result.current.mode).toBe("activity"))
    expect(result.current.cmuxAvailable).toBe(false)
  })

  it("uses a saved non-cmux mode immediately", () => {
    window.localStorage.setItem("worktree.home.sort.mode", "name")
    vi.spyOn(api, "cmux").mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    expect(result.current.mode).toBe("name")
  })

  it("shows activity for a saved cmux mode without cmux, and keeps what was saved", async () => {
    window.localStorage.setItem("worktree.home.sort.mode", "cmux")
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    await waitFor(() => expect(result.current.mode).toBe("activity"))
    expect(window.localStorage.getItem("worktree.home.sort.mode")).toBe("cmux")
  })

  it("persists changes", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    const { result } = renderHook(() => useWorktreeSort(), { wrapper })
    act(() => result.current.setMode("created"))
    act(() => result.current.setCreatedDir("desc"))
    expect(result.current.mode).toBe("created")
    expect(result.current.createdDir).toBe("desc")
    expect(window.localStorage.getItem("worktree.home.sort.mode")).toBe("created")
    expect(window.localStorage.getItem("worktree.home.sort.createdDir")).toBe("desc")
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd ui && npx vitest run src/hooks/useWorktreeSort.test.tsx`
Expected: FAIL. The suite fails to import `./useWorktreeSort`.

- [ ] **Step 7: Implement the hook**

Create `ui/src/hooks/useWorktreeSort.ts`:

```ts
import { useState } from "react"
import { useCmux } from "../api/cmux"
import { resolveSortMode, type SortDir, type SortMode } from "../lib/worktreeSort"
import { readCreatedDir, readSortMode, writeCreatedDir, writeSortMode } from "../lib/worktreeSortPref"

export interface WorktreeSort {
  /** The mode to apply, or null while it depends on a cmux answer not yet in. */
  mode: SortMode | null
  createdDir: SortDir
  cmuxAvailable: boolean
  setMode: (mode: SortMode) => void
  setCreatedDir: (dir: SortDir) => void
}

/**
 * The home page's worktree sort choice: remembered per browser, with a
 * default that depends on whether cmux is reachable. See resolveSortMode for
 * how a saved "cmux" behaves when it is not.
 */
export function useWorktreeSort(): WorktreeSort {
  const cmux = useCmux()
  const [saved, setSaved] = useState<SortMode | null>(readSortMode)
  const [createdDir, setDir] = useState<SortDir>(readCreatedDir)
  const cmuxAvailable = cmux.data?.available === true
  return {
    mode: resolveSortMode(saved, cmux.isPending, cmuxAvailable),
    createdDir,
    cmuxAvailable,
    setMode: (mode) => {
      writeSortMode(mode)
      setSaved(mode)
    },
    setCreatedDir: (dir) => {
      writeCreatedDir(dir)
      setDir(dir)
    },
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `cd ui && npx vitest run src/lib/worktreeSortPref.test.ts src/hooks/useWorktreeSort.test.tsx && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 9: Commit**

```bash
git add ui/src/lib/worktreeSortPref.ts ui/src/lib/worktreeSortPref.test.ts ui/src/hooks/useWorktreeSort.ts ui/src/hooks/useWorktreeSort.test.tsx
git commit --signoff -m "feat(ui): remember the worktree sort choice per browser" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `WorktreeSortControl` component

**Files:**
- Create: `ui/src/components/WorktreeSortControl.tsx`
- Test: `ui/src/components/WorktreeSortControl.test.tsx`

**Interfaces:**
- Consumes: `SORT_MODES`, `isSortMode`, `SortMode`, `SortDir` from `ui/src/lib/worktreeSort.ts`.
- Produces: `WorktreeSortControl(props: WorktreeSortControlProps)`, where

  ```ts
  interface WorktreeSortControlProps {
    mode: SortMode | null
    createdDir: SortDir
    cmuxAvailable: boolean
    onModeChange: (mode: SortMode) => void
    onCreatedDirChange: (dir: SortDir) => void
  }
  ```

  Renders nothing while `mode` is null. Accessible names: the select is `"Sort worktrees"` and the direction button is `"Toggle sort direction"`. Option labels are exactly `cmux order`, `Latest activity`, `Created`, `Name`, `Unread first`.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/WorktreeSortControl.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { WorktreeSortControl, type WorktreeSortControlProps } from "./WorktreeSortControl"

function renderControl(over: Partial<WorktreeSortControlProps> = {}) {
  const props: WorktreeSortControlProps = {
    mode: "activity", createdDir: "asc", cmuxAvailable: true,
    onModeChange: vi.fn(), onCreatedDirChange: vi.fn(), ...over,
  }
  render(<MantineProvider><WorktreeSortControl {...props} /></MantineProvider>)
  return props
}

const optionLabels = () => screen.getAllByRole("option").map((o) => o.textContent)

afterEach(cleanup)

describe("WorktreeSortControl", () => {
  it("lists every mode, cmux first, when cmux is available", () => {
    renderControl()
    expect(optionLabels()).toEqual(["cmux order", "Latest activity", "Created", "Name", "Unread first"])
  })

  it("omits cmux order when cmux is unavailable", () => {
    renderControl({ cmuxAvailable: false })
    expect(optionLabels()).toEqual(["Latest activity", "Created", "Name", "Unread first"])
  })

  it("reports a chosen mode", async () => {
    const props = renderControl()
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Sort worktrees" }), "Unread first")
    expect(props.onModeChange).toHaveBeenCalledWith("unread")
  })

  it("renders nothing while the mode is undecided", () => {
    renderControl({ mode: null })
    expect(screen.queryByRole("combobox", { name: "Sort worktrees" })).not.toBeInTheDocument()
  })

  it("shows the direction toggle only in created mode", () => {
    renderControl({ mode: "activity" })
    expect(screen.queryByRole("button", { name: "Toggle sort direction" })).not.toBeInTheDocument()
    cleanup()
    renderControl({ mode: "created" })
    expect(screen.getByRole("button", { name: "Toggle sort direction" })).toBeInTheDocument()
  })

  it("flips the direction", async () => {
    const props = renderControl({ mode: "created", createdDir: "asc" })
    await userEvent.click(screen.getByRole("button", { name: "Toggle sort direction" }))
    expect(props.onCreatedDirChange).toHaveBeenCalledWith("desc")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/components/WorktreeSortControl.test.tsx`
Expected: FAIL. The suite fails to import `./WorktreeSortControl`.

- [ ] **Step 3: Implement**

Create `ui/src/components/WorktreeSortControl.tsx`:

```tsx
import { ActionIcon, Group, NativeSelect, Tooltip } from "@mantine/core"
import { IconSortAscending, IconSortDescending } from "@tabler/icons-react"
import { SORT_MODES, isSortMode, type SortDir, type SortMode } from "../lib/worktreeSort"

const LABELS: Record<SortMode, string> = {
  cmux: "cmux order",
  activity: "Latest activity",
  created: "Created",
  name: "Name",
  unread: "Unread first",
}

export interface WorktreeSortControlProps {
  /** null while the default is undecided; nothing renders until then. */
  mode: SortMode | null
  createdDir: SortDir
  cmuxAvailable: boolean
  onModeChange: (mode: SortMode) => void
  onCreatedDirChange: (dir: SortDir) => void
}

/**
 * The home page's worktree sort picker. A native select on purpose: it gets
 * the platform picker on a phone, where this UI is also used.
 */
export function WorktreeSortControl({
  mode, createdDir, cmuxAvailable, onModeChange, onCreatedDirChange,
}: WorktreeSortControlProps) {
  // Undecided lasts one cmux round-trip. Rendering nothing beats a select
  // whose value is a lie, and keeps it a controlled input from first render.
  if (mode === null) return null
  const modes = SORT_MODES.filter((m) => m !== "cmux" || cmuxAvailable)
  const dirLabel = createdDir === "asc" ? "Oldest first" : "Newest first"
  return (
    <Group gap={4} wrap="nowrap">
      <NativeSelect
        size="xs"
        aria-label="Sort worktrees"
        value={mode}
        data={modes.map((m) => ({ value: m, label: LABELS[m] }))}
        onChange={(e) => {
          const v = e.currentTarget.value
          if (isSortMode(v)) onModeChange(v)
        }}
      />
      {mode === "created" && (
        <Tooltip label={dirLabel}>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Toggle sort direction"
            onClick={() => onCreatedDirChange(createdDir === "asc" ? "desc" : "asc")}
          >
            {createdDir === "asc" ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />}
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/components/WorktreeSortControl.test.tsx && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/WorktreeSortControl.tsx ui/src/components/WorktreeSortControl.test.tsx
git commit --signoff -m "feat(ui): add the worktree sort control" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire into `HomePage` and document

**Files:**
- Modify: `ui/src/pages/HomePage.tsx`
- Modify: `ui/src/pages/HomePage.test.tsx`
- Modify: `docs/web-ui-architecture.md` (home page section around lines 720-740)

**Interfaces:**
- Consumes: `useWorktreeSort()` (Task 4), `WorktreeSortControl` (Task 5), `sortWorktrees` and `cmuxPositions` (Task 3), `useCmux()` from `ui/src/api/cmux.ts`.

- [ ] **Step 1: Write the failing page tests**

In `ui/src/pages/HomePage.test.tsx`:

1. Replace the fixed `useWorktrees` mock with a hoisted, mutable list, and add the `api` import. Replace:

```ts
vi.mock("../hooks/useWorktrees", () => ({ useWorktrees: () => ({ data: [summary] }) }))
```

with:

```ts
const mocks = vi.hoisted(() => ({ worktrees: [] as WorktreeSummary[] }))
vi.mock("../hooks/useWorktrees", () => ({ useWorktrees: () => ({ data: mocks.worktrees }) }))
```

and add `import { api } from "../api/client"` alongside the other imports (below the `vi.mock` calls, next to the `HomePage` import).

2. Replace the existing `beforeEach(() => window.history.replaceState({}, "", "/"))` with:

```ts
beforeEach(() => {
  window.history.replaceState({}, "", "/")
  window.localStorage.clear()
  mocks.worktrees = [summary]
  vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
})
afterEach(() => vi.restoreAllMocks())
```

(Keep the existing `afterEach(cleanup)`.)

3. Append:

```ts
describe("HomePage worktree sorting", () => {
  const older: WorktreeSummary = { ...summary, path: "/wt/zeta", branch: "zeta-branch", latest_event_ts: "2026-09-01T00:00:00Z", focus_resources: [] }
  const newer: WorktreeSummary = { ...summary, path: "/wt/alpha", branch: "alpha-branch", latest_event_ts: "2026-09-20T00:00:00Z", focus_resources: [] }

  /** Branch names in on-page order. */
  const order = () => {
    const text = document.body.textContent ?? ""
    return ["alpha-branch", "zeta-branch"].sort((a, b) => text.indexOf(a) - text.indexOf(b))
  }

  it("offers the sort control at both widths", async () => {
    for (const width of ["narrow", "wide"] as const) {
      setViewport(width)
      wrap()
      expect(await screen.findByRole("combobox", { name: "Sort worktrees" })).toBeInTheDocument()
      cleanup()
    }
  })

  it("defaults to latest activity without cmux, and re-sorts on change", async () => {
    setViewport("wide")
    mocks.worktrees = [newer, older].reverse()
    wrap()
    const select = await screen.findByRole("combobox", { name: "Sort worktrees" })
    await waitFor(() => expect(select).toHaveValue("activity"))
    expect(order()).toEqual(["alpha-branch", "zeta-branch"])

    await userEvent.selectOptions(select, "Created")
    await userEvent.click(screen.getByRole("button", { name: "Toggle sort direction" }))
    // Same created_at on both, so ties fall back to name order either way.
    expect(order()).toEqual(["alpha-branch", "zeta-branch"])
    expect(window.localStorage.getItem("worktree.home.sort.createdDir")).toBe("desc")
  })

  it("restores a saved mode", async () => {
    setViewport("wide")
    window.localStorage.setItem("worktree.home.sort.mode", "name")
    mocks.worktrees = [older, newer]
    wrap()
    expect(await screen.findByRole("combobox", { name: "Sort worktrees" })).toHaveValue("name")
    expect(order()).toEqual(["alpha-branch", "zeta-branch"])
  })

  it("orders by cmux sidebar position when cmux is available", async () => {
    setViewport("wide")
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/zeta": [{ ref: "workspace:4", title: "z", selected: false, index: 0 }] },
    })
    mocks.worktrees = [newer, older]
    wrap()
    const select = await screen.findByRole("combobox", { name: "Sort worktrees" })
    await waitFor(() => expect(select).toHaveValue("cmux"))
    expect(order()).toEqual(["zeta-branch", "alpha-branch"])
  })
})
```

Update the imports at the top of the file: add `waitFor` to the `@testing-library/react` import and add `import userEvent from "@testing-library/user-event"`.

Note on `order()`: a zeta worktree's cmux workspace title may also render on its card, but the helper searches only for the branch strings, so extra text doesn't matter. The cmux title is `"z"`, which contains neither branch name.

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && npx vitest run src/pages/HomePage.test.tsx`
Expected: FAIL. `findByRole("combobox", { name: "Sort worktrees" })` times out in the new tests. The existing tests still pass.

- [ ] **Step 3: Implement**

In `ui/src/pages/HomePage.tsx`:

Change the React import to `import { useMemo, useState } from "react"`, and add:

```ts
import { useCmux } from "../api/cmux"
import { useWorktreeSort } from "../hooks/useWorktreeSort"
import { WorktreeSortControl } from "../components/WorktreeSortControl"
import { cmuxPositions, sortWorktrees } from "../lib/worktreeSort"
```

Inside `HomePage`, after `const tl = useGlobalTimeline(archived, sources)`:

```ts
  const sort = useWorktreeSort()
  // Same shared query the cards use, so this costs no extra request.
  const cmux = useCmux()
  const positions = useMemo(() => cmuxPositions(cmux.data?.matches), [cmux.data])
  // Undecided (null) leaves the server's order in place rather than showing
  // one order and jumping to another when the cmux answer lands.
  const sortedWorktrees = useMemo(() => {
    const items = wts.data ?? []
    if (sort.mode === null) return items
    return sortWorktrees(items, { mode: sort.mode, createdDir: sort.createdDir, cmuxPositions: positions })
  }, [wts.data, sort.mode, sort.createdDir, positions])

  const sortControl = (
    <WorktreeSortControl
      mode={sort.mode}
      createdDir={sort.createdDir}
      cmuxAvailable={sort.cmuxAvailable}
      onModeChange={sort.setMode}
      onCreatedDirChange={sort.setCreatedDir}
    />
  )
```

Change `const worktrees = <WorktreeList items={wts.data ?? []} />` to:

```ts
  const worktrees = <WorktreeList items={sortedWorktrees} />
```

In the narrow layout, replace

```tsx
          <Tabs.Panel value="worktrees" pt="md">{worktrees}</Tabs.Panel>
```

with

```tsx
          <Tabs.Panel value="worktrees" pt="md">
            <Stack gap="xs">
              <Group justify="flex-end">{sortControl}</Group>
              {worktrees}
            </Stack>
          </Tabs.Panel>
```

In the wide layout, replace

```tsx
            <Title order={4}>Worktrees</Title>
```

with

```tsx
            <Group gap="sm" wrap="nowrap">
              <Title order={4}>Worktrees</Title>
              {sortControl}
            </Group>
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd ui && npx vitest run src/pages/HomePage.test.tsx && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 5: Document**

In `docs/web-ui-architecture.md`:

1. In the **Components** bullet (the one starting `` - **Components** (`ui/src/components/`): `WorktreeList`, ``), add `` `WorktreeSortControl` (see "Worktree list sorting" below), `` after `WorktreeList`.
2. In the **Lib** bullet, add `` `worktreeSort.ts` + `worktreeSortPref.ts` (see "Worktree list sorting" below), `` before `relativeTime.ts`.
3. Insert this subsection immediately before the `### Responsive resource selection` heading:

```markdown
### Worktree list sorting

The home page's worktree list is sorted client-side. The server returns
`/api/worktrees` in registry order (`ORDER BY repo, path`) and nothing about
the sort choice reaches it.

- **Modes** (`lib/worktreeSort.ts`): cmux order, Latest activity, Created
  (with an ascending/descending toggle), Name, Unread first. Every mode breaks
  ties by Name, and missing or unparseable values (`latest_event_ts: ""`, a
  legacy non-RFC3339 `created_at`) sort last in either direction.
- **cmux order** uses `index` on each `/api/cmux` workspace: its position in
  `cmux workspace list`, which is the sidebar order. It is deliberately not the
  ref number, since refs stop following the sidebar once workspaces are moved.
  A worktree with several workspaces takes its earliest. The query refetches
  every 15s, so the list follows drags in cmux.
- **Created** uses `created_at` on the worktree summary, the registry value
  verbatim.
- **Persistence** (`lib/worktreeSortPref.ts`): `localStorage`, per browser,
  keys `worktree.home.sort.mode` and `worktree.home.sort.createdDir`.
- **Default** (`resolveSortMode`): cmux order when cmux is reachable,
  otherwise Latest activity. A saved "cmux" shows Latest activity while cmux
  is unreachable, without overwriting what was saved. While the cmux query is
  still pending and the answer matters, the mode is `null`: the list stays in
  server order and the picker is not rendered, which avoids a visible re-sort on
  load.
```

- [ ] **Step 6: Full verification**

Run: `make test && (cd ui && npm test && npx tsc -b) && make build`
Expected: all Go and UI tests pass, type-check clean, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/HomePage.tsx ui/src/pages/HomePage.test.tsx docs/web-ui-architecture.md
git commit --signoff -m "feat(ui): sort the home page worktree list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
