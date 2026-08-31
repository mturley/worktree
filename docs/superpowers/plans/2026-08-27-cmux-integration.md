# Phase H: cmux Integration + Worktree Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each worktree's cmux workspace on its cards with a switch button, let a worktree be created from the web UI, and narrow `worktree add` to inputs that actually create a worktree.

**Architecture:** Three sequenced pieces. H1 adds path→workspace matching in `internal/cmux` plus four read-mostly HTTP routes and a card section. H2 extracts creation into a shared `internal/worktreenew` runner — mirroring Phase G's `internal/worktreedel` — driven by both the CLI and a new stateless HTTP endpoint whose confirmations replay the whole request. H2a extracts URL→resource inference into `internal/resourceurl` so the CLI, the web handler, and the runner share one detector.

**Tech Stack:** Go 1.22+ (stdlib `net/http` mux, `database/sql`, SQLite), React 19 + Mantine 7 + TanStack Query 5 + wouter 3, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-27-cmux-integration-design.md`

## Global Constraints

- **No cmux failure ever 500s a page.** A failed `cmux workspace list` returns `{"available": false}`; select/create failures return `ok:false` with a message. Never a 5xx.
- **The card section does not render at all when not inside cmux** — the card must be byte-identical to today's.
- **Path matching happens in Go**, comparing after `Abs → EvalSymlinks → Clean` (the same canonicalization `internal/db`'s `Subscriber` uses). Canonicalize each side **once** — N+M syscalls, never N×M.
- **`matches` is keyed by exactly the path the UI already holds**, so the client does no path logic.
- **Always `osascript -e 'tell application "cmux" to activate'` after a successful select.**
- **`confirm` is a single nullable object**, never a marker plus a separate detail block — the two could otherwise disagree about whether a question is pending.
- **A pending confirmation is HTTP 200**, never an error status. A hard failure is also 200 with `ok:false`.
- **Every create request replays from the top**; already-done steps report `skipped`, never `failed`. There is no server-side session.
- **`worktree add` must never fall through to branch creation** for a Slack URL or a path — it emits a redirect error naming the right command.
- Checkbox defaults: **`git pull first` checked**, **`copy dotfiles` unchecked**.
- Tests: Go `make test`; UI `cd ui && npm test`. Type check with `cd ui && npx tsc -b`.
- Commits use `--signoff`. Never `git add -A` or `git add .` — add named files only.

## File Structure

| File | Responsibility |
|---|---|
| `internal/cmux/cmux.go` (modify) | `Workspace` fields, `DisplayTitle`, `Match`, `Activate`, `cmuxCmd` as var |
| `internal/cmux/match_test.go` (create) | matching incl. symlinks |
| `internal/webui/cmux_api.go` (create) | `GET /api/cmux`, `GET /api/cmux-groups`, `POST /api/cmux/select`, `POST /api/cmux/create` |
| `internal/resourceurl/resourceurl.go` (create) | URL → `(type, id)`, the single detector |
| `internal/worktreenew/worktreenew.go` (create) | the shared creation runner |
| `internal/webui/worktree_create_api.go` (create) | `POST /api/worktrees/create`, `GET /api/repos`, `GET /api/repo-dotfiles` |
| `ui/src/api/cmux.ts` (create) | `useCmux` hook |
| `ui/src/components/CmuxWorkspaceSection.tsx` (create) | the card section |
| `ui/src/components/CreateWorkspaceModal.tsx` (create) | name/group/colour fields, reused by H2 |
| `ui/src/components/NewWorktreeModal.tsx` (create) | the creation modal + stepper |

---

## Task 1: `internal/cmux` — workspace fields, matching, activation

**Files:**
- Modify: `internal/cmux/cmux.go`
- Test: `internal/cmux/match_test.go` (create)

**Interfaces:**
- Produces: `Workspace{Ref,Title,CustomTitle,CustomColor,CurrentDirectory,Selected}`, `(Workspace) DisplayTitle() string`, `Match([]Workspace, []string) map[string][]Workspace`, `Activate() error`, `var cmuxCmd func(...string) *exec.Cmd`.

- [ ] **Step 1: Write the failing test**

Create `internal/cmux/match_test.go`:

```go
package cmux

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDisplayTitlePrefersTitle(t *testing.T) {
	// cmux leaves custom_title null on workspaces it titles itself
	// (e.g. "◐ handler-ratelimits"), so Title is the primary source.
	cases := []struct {
		name string
		w    Workspace
		want string
	}{
		{"title wins", Workspace{Ref: "workspace:1", Title: "T", CustomTitle: "C"}, "T"},
		{"custom title fallback", Workspace{Ref: "workspace:1", CustomTitle: "C"}, "C"},
		{"ref last resort", Workspace{Ref: "workspace:1"}, "workspace:1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.w.DisplayTitle(); got != tc.want {
				t.Fatalf("DisplayTitle() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMatchResolvesSymlinks(t *testing.T) {
	// The bug this fixes: FindByDirectory compared raw strings, so a
	// worktree reached through a symlink never matched its workspace.
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	ws := []Workspace{{Ref: "workspace:1", CurrentDirectory: link}}
	got := Match(ws, []string{real})

	if len(got[real]) != 1 || got[real][0].Ref != "workspace:1" {
		t.Fatalf("Match() = %#v, want workspace:1 under %q", got, real)
	}
}

func TestMatchKeysByRequestedPathNotResolved(t *testing.T) {
	// Callers look up by the path they passed in. Keying by the resolved
	// path would make every lookup miss on a symlinked worktree.
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	ws := []Workspace{{Ref: "workspace:1", CurrentDirectory: real}}
	got := Match(ws, []string{link})

	if len(got[link]) != 1 {
		t.Fatalf("Match() should key by the requested path %q, got %#v", link, got)
	}
}

func TestMatchMultipleWorkspacesOnOnePath(t *testing.T) {
	dir := t.TempDir()
	ws := []Workspace{
		{Ref: "workspace:1", CurrentDirectory: dir},
		{Ref: "workspace:2", CurrentDirectory: dir},
	}
	got := Match(ws, []string{dir})
	if len(got[dir]) != 2 {
		t.Fatalf("want 2 matches, got %d", len(got[dir]))
	}
}

func TestMatchNoMatchIsAbsentNotEmpty(t *testing.T) {
	dir := t.TempDir()
	got := Match([]Workspace{{Ref: "workspace:1", CurrentDirectory: t.TempDir()}}, []string{dir})
	if _, ok := got[dir]; ok {
		t.Fatalf("unmatched path should be absent from the map, got %#v", got)
	}
}

func TestIsAvailableFollowsSocketEnv(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	if IsAvailable() {
		t.Fatal("IsAvailable() = true with no socket path")
	}
	t.Setenv("CMUX_SOCKET_PATH", "/tmp/cmux.sock")
	if !IsAvailable() {
		t.Fatal("IsAvailable() = false with a socket path set")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/cmux/ -run 'TestDisplayTitle|TestMatch' -v`
Expected: FAIL — `w.DisplayTitle undefined`, `undefined: Match`.

- [ ] **Step 3: Add the fields and functions**

In `internal/cmux/cmux.go`, replace the `Workspace` struct and add the new functions:

```go
type Workspace struct {
	Ref              string  `json:"ref"`
	Title            string  `json:"title"`
	CustomTitle      string  `json:"custom_title"`
	CustomColor      *string `json:"custom_color"` // hex like "#AD1457", or nil
	CurrentDirectory string  `json:"current_directory"`
	Selected         bool    `json:"selected"`
}

// DisplayTitle is the workspace's human name. cmux leaves custom_title null on
// workspaces it titles itself (e.g. "◐ handler-ratelimits"), so title comes
// first and the ref is the last resort.
func (w Workspace) DisplayTitle() string {
	if w.Title != "" {
		return w.Title
	}
	if w.CustomTitle != "" {
		return w.CustomTitle
	}
	return w.Ref
}

// canonical resolves a path for comparison: Abs -> EvalSymlinks -> Clean, the
// same normalization internal/db's Subscriber uses. A path that cannot be
// resolved (it may not exist) still gets Abs+Clean, so comparison degrades to
// a textual one rather than failing.
func canonical(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return filepath.Clean(abs)
}

// Match maps each requested path to the workspaces whose current_directory
// resolves to the same location.
//
// Both sides are canonicalized exactly once — len(paths)+len(workspaces)
// EvalSymlinks syscalls, not the product. internal/webui/timeline.go:279
// records what per-pair resolution cost the Phase F timeline; do not repeat it.
//
// Keys are the caller's ORIGINAL path strings, not the resolved ones, so a
// caller can look up by the same path it passed in. Paths with no workspace
// are absent from the map rather than present with an empty slice.
func Match(workspaces []Workspace, paths []string) map[string][]Workspace {
	byDir := make(map[string][]Workspace, len(workspaces))
	for _, ws := range workspaces {
		if ws.CurrentDirectory == "" {
			continue
		}
		key := canonical(ws.CurrentDirectory)
		byDir[key] = append(byDir[key], ws)
	}

	out := make(map[string][]Workspace, len(paths))
	for _, p := range paths {
		if hits := byDir[canonical(p)]; len(hits) > 0 {
			out[p] = hits
		}
	}
	return out
}

// Activate raises the cmux app. Callers treat failure as non-fatal: a switch
// that worked but did not raise the window is still a switch.
func Activate() error {
	cmd := exec.Command("osascript", "-e", `tell application "cmux" to activate`)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("activating cmux: %s", strings.TrimSpace(string(out)))
	}
	return nil
}
```

Add `"path/filepath"` to the imports.

- [ ] **Step 4: Make `cmuxCmd` stubbable and reimplement `FindByDirectory`**

Replace the existing `cmuxCmd` function and `FindByDirectory`:

```go
// cmuxCmd is a var so tests can stub the cmux binary.
var cmuxCmd = func(args ...string) *exec.Cmd {
	return exec.Command("cmux", args...)
}

// FindByDirectory returns the first workspace whose directory resolves to dir,
// or nil when none does. It goes through Match so the CLI gets the same
// symlink-resolving comparison the web UI does — a raw string compare here
// used to miss an existing workspace whenever either path ran through a
// symlink.
func FindByDirectory(dir string) (*Workspace, error) {
	workspaces, err := ListWorkspaces()
	if err != nil {
		return nil, err
	}
	hits := Match(workspaces, []string{dir})[dir]
	if len(hits) == 0 {
		return nil, nil
	}
	return &hits[0], nil
}
```

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/cmux/ -v`
Expected: PASS.

- [ ] **Step 6: Verify nothing else broke**

Run: `make test`
Expected: PASS — `cmd/root.go` still compiles against `FindByDirectory` and `CustomTitle`.

- [ ] **Step 7: Commit**

```bash
git add internal/cmux/cmux.go internal/cmux/match_test.go
git commit --signoff -m "feat(cmux): symlink-resolving workspace matching, title and colour fields"
```

---

## Task 2: cmux read API — availability, matches, groups, select

**Files:**
- Create: `internal/webui/cmux_api.go`, `internal/webui/cmux_api_test.go`
- Modify: `internal/webui/server.go:75-101` (route registration)

**Interfaces:**
- Consumes: `cmux.IsAvailable()`, `cmux.ListWorkspaces()`, `cmux.Match()`, `cmux.ListGroups()`, `cmux.SelectWorkspace(ref)`, `cmux.Activate()`, `cmux.NamedColors`, `(Workspace) DisplayTitle()`.
- Produces: `GET /api/cmux`, `GET /api/cmux-groups`, `POST /api/cmux/select`.

- [ ] **Step 1: Write the failing test**

Create `internal/webui/cmux_api_test.go`:

```go
package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCmuxUnavailableReturnsAvailableFalse(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleCmux(rec, httptest.NewRequest(http.MethodGet, "/api/cmux", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (a cmux failure must never 5xx)", rec.Code)
	}
	var got struct {
		Available bool `json:"available"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Available {
		t.Fatal("available = true with no cmux socket")
	}
}

func TestCmuxSelectRequiresRef(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/cmux/select", strings.NewReader(`{}`))
	s.handleCmuxSelect(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a missing ref", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/webui/ -run TestCmux -v`
Expected: FAIL — `s.handleCmux undefined`.

- [ ] **Step 3: Write the handlers**

Create `internal/webui/cmux_api.go`:

```go
package webui

import (
	"encoding/json"
	"net/http"

	"github.com/mturley/worktree/internal/cmux"
	"github.com/mturley/worktree/internal/registry"
)

type cmuxWorkspaceDTO struct {
	Ref      string `json:"ref"`
	Title    string `json:"title"`
	Color    string `json:"color,omitempty"` // hex, empty when unset
	Selected bool   `json:"selected"`
}

type cmuxResponse struct {
	Available bool                          `json:"available"`
	Matches   map[string][]cmuxWorkspaceDTO `json:"matches,omitempty"`
}

// handleCmux: GET /api/cmux
//
// Returns availability plus a path -> workspaces map keyed by exactly the
// paths the UI already holds, so the client does no path logic. Matching runs
// in Go because it resolves symlinks, which TypeScript cannot do.
//
// Every failure degrades to available:false rather than an error status: the
// section simply does not render, which is the same thing the UI does when
// cmux is not running at all. A 5xx here would break a page over a missing
// terminal multiplexer.
func (s *Server) handleCmux(w http.ResponseWriter, r *http.Request) {
	if !cmux.IsAvailable() {
		writeJSON(w, http.StatusOK, cmuxResponse{Available: false})
		return
	}
	workspaces, err := cmux.ListWorkspaces()
	if err != nil {
		writeJSON(w, http.StatusOK, cmuxResponse{Available: false})
		return
	}

	var paths []string
	if s.DB != nil {
		if entries, err := registry.List(s.DB); err == nil {
			for _, e := range entries {
				paths = append(paths, e.Path)
			}
		}
	}

	matches := make(map[string][]cmuxWorkspaceDTO)
	for path, hits := range cmux.Match(workspaces, paths) {
		dtos := make([]cmuxWorkspaceDTO, 0, len(hits))
		for _, ws := range hits {
			dto := cmuxWorkspaceDTO{
				Ref:      ws.Ref,
				Title:    ws.DisplayTitle(),
				Selected: ws.Selected,
			}
			if ws.CustomColor != nil {
				dto.Color = *ws.CustomColor
			}
			dtos = append(dtos, dto)
		}
		matches[path] = dtos
	}

	writeJSON(w, http.StatusOK, cmuxResponse{Available: true, Matches: matches})
}

type cmuxGroupDTO struct {
	Ref  string `json:"ref"`
	Name string `json:"name"`
}

type cmuxColorDTO struct {
	Name string `json:"name"`
	Hex  string `json:"hex"`
}

type cmuxGroupsResponse struct {
	Groups []cmuxGroupDTO `json:"groups"`
	Colors []cmuxColorDTO `json:"colors"`
}

// handleCmuxGroups: GET /api/cmux-groups
//
// Fetched only when a modal opens, which keeps the polled /api/cmux endpoint
// to a single exec. Colours come from cmux.NamedColors rather than a
// duplicated TS constant, so the swatches have one source of truth.
func (s *Server) handleCmuxGroups(w http.ResponseWriter, r *http.Request) {
	out := cmuxGroupsResponse{Groups: []cmuxGroupDTO{}, Colors: []cmuxColorDTO{}}
	for _, c := range cmux.NamedColors {
		out.Colors = append(out.Colors, cmuxColorDTO{Name: c.Name, Hex: c.Hex})
	}
	if cmux.IsAvailable() {
		if groups, err := cmux.ListGroups(); err == nil {
			for _, g := range groups {
				out.Groups = append(out.Groups, cmuxGroupDTO{Ref: g.Ref, Name: g.Name})
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type cmuxSelectRequest struct {
	Ref string `json:"ref"`
}

type cmuxActionResponse struct {
	OK    bool   `json:"ok"`
	Ref   string `json:"ref,omitempty"`
	Error string `json:"error,omitempty"`
}

// handleCmuxSelect: POST /api/cmux/select
//
// Always activates after a successful select: harmless when cmux is already
// frontmost, and essential when the click came from an external browser rather
// than a cmux browser pane. Activation failure is not a select failure.
func (s *Server) handleCmuxSelect(w http.ResponseWriter, r *http.Request) {
	var req cmuxSelectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Ref == "" {
		writeError(w, http.StatusBadRequest, "missing ref")
		return
	}
	if err := cmux.SelectWorkspace(req.Ref); err != nil {
		writeJSON(w, http.StatusOK, cmuxActionResponse{OK: false, Error: err.Error()})
		return
	}
	cmux.Activate()
	writeJSON(w, http.StatusOK, cmuxActionResponse{OK: true, Ref: req.Ref})
}
```

- [ ] **Step 4: Register the routes**

In `internal/webui/server.go`, after the `GET /api/worktree-info` line:

```go
	mux.HandleFunc("GET /api/cmux", s.handleCmux)
	mux.HandleFunc("GET /api/cmux-groups", s.handleCmuxGroups)
	mux.HandleFunc("POST /api/cmux/select", s.handleCmuxSelect)
```

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/webui/ -run TestCmux -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/webui/cmux_api.go internal/webui/cmux_api_test.go internal/webui/server.go
git commit --signoff -m "feat(webui): cmux availability, workspace matches, groups and select routes"
```

---

## Task 3: cmux section on both worktree cards

**Files:**
- Create: `ui/src/api/cmux.ts`, `ui/src/components/CmuxWorkspaceSection.tsx`, `ui/src/components/CmuxWorkspaceSection.test.tsx`
- Modify: `ui/src/api/client.ts` (add `cmux`, `cmuxSelect`), `ui/src/api/types.ts` (add DTOs), `ui/src/components/WorktreeCard.tsx`, `ui/src/components/WorktreeDetailCard.tsx`

**Interfaces:**
- Consumes: `GET /api/cmux`, `POST /api/cmux/select`.
- Produces: `useCmux()` returning `{ available, matches }`; `<CmuxWorkspaceSection path={string} branch={string} />`.

- [ ] **Step 1: Add the types and client methods**

In `ui/src/api/types.ts`:

```ts
export interface CmuxWorkspace {
  ref: string
  title: string
  color?: string
  selected: boolean
}

export interface CmuxResponse {
  available: boolean
  matches?: Record<string, CmuxWorkspace[]>
}
```

In `ui/src/api/client.ts`, inside the `api` object:

```ts
  cmux: () => fetchJSON<CmuxResponse>("/api/cmux"),
  cmuxSelect: (ref: string) =>
    fetchJSON<{ ok: boolean; error?: string }>("/api/cmux/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    }),
```

Add `CmuxResponse` to the existing type import from `./types`.

- [ ] **Step 2: Write the shared hook**

Create `ui/src/api/cmux.ts`:

```ts
import { useQuery } from "@tanstack/react-query"
import { api } from "./client"

/**
 * One shared query for every card on the page.
 *
 * The key is constant, so N worktree cards cost ONE `cmux workspace list` per
 * refetch rather than N. Refetched on an interval because cmux titles carry
 * live agent-status glyphs (e.g. "◐ handler-ratelimits") and do go stale.
 */
export function useCmux() {
  return useQuery({
    queryKey: ["cmux"],
    queryFn: () => api.cmux(),
    refetchInterval: 15_000,
  })
}
```

- [ ] **Step 3: Write the failing test**

Create `ui/src/components/CmuxWorkspaceSection.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { CmuxWorkspaceSection } from "./CmuxWorkspaceSection"
import { api } from "../api/client"

function renderSection(path = "/wt/a") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <CmuxWorkspaceSection path={path} branch="my-branch" />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

describe("CmuxWorkspaceSection", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("renders nothing when cmux is unavailable", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
    const { container } = renderSection()
    // Nothing ever appears — not a spinner, not an error.
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector("[data-cmux-section]")).toBeNull()
  })

  it("renders one row per matching workspace", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: {
        "/wt/a": [
          { ref: "workspace:1", title: "main", color: "#AD1457", selected: false },
          { ref: "workspace:2", title: "review", selected: false },
        ],
      },
    })
    renderSection()
    expect(await screen.findByText("main")).toBeInTheDocument()
    expect(await screen.findByText("review")).toBeInTheDocument()
    expect(await screen.findAllByRole("button", { name: /switch/i })).toHaveLength(2)
  })

  it("shows Current, not Switch, for the selected workspace", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/a": [{ ref: "workspace:1", title: "main", selected: true }] },
    })
    renderSection()
    expect(await screen.findByRole("button", { name: /current/i })).toBeDisabled()
  })

  it("offers Create when cmux is up but nothing matches", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({ available: true, matches: {} })
    renderSection()
    expect(await screen.findByText(/no cmux workspace/i)).toBeInTheDocument()
  })

  it("switches without navigating the card", async () => {
    vi.spyOn(api, "cmux").mockResolvedValue({
      available: true,
      matches: { "/wt/a": [{ ref: "workspace:1", title: "main", selected: false }] },
    })
    const select = vi.spyOn(api, "cmuxSelect").mockResolvedValue({ ok: true })
    const onCardClick = vi.fn()

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MantineProvider>
        <QueryClientProvider client={qc}>
          <div onClick={onCardClick}>
            <CmuxWorkspaceSection path="/wt/a" branch="b" />
          </div>
        </QueryClientProvider>
      </MantineProvider>,
    )

    await userEvent.click(await screen.findByRole("button", { name: /switch/i }))
    expect(select).toHaveBeenCalledWith("workspace:1")
    // The home card is one big navigation target; the button must not bubble.
    expect(onCardClick).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd ui && npx vitest run src/components/CmuxWorkspaceSection.test.tsx`
Expected: FAIL — cannot resolve `./CmuxWorkspaceSection`.

- [ ] **Step 5: Write the component**

Create `ui/src/components/CmuxWorkspaceSection.tsx`:

```tsx
import { Button, Group, Stack, Text } from "@mantine/core"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api/client"
import { useCmux } from "../api/cmux"
import type { CmuxWorkspace } from "../api/types"
import { CreateWorkspaceModal } from "./CreateWorkspaceModal"

/** Neutral bar for a workspace with no colour set, so rows stay aligned. */
const NO_COLOR = "var(--mantine-color-dark-4)"

function ColorBar({ color }: { color?: string }) {
  return (
    <div
      aria-hidden
      style={{
        width: 3,
        alignSelf: "stretch",
        minHeight: 18,
        borderRadius: 2,
        background: color || NO_COLOR,
        flex: "none",
      }}
    />
  )
}

/**
 * The cmux workspace section, rendered above the worktree title on both the
 * home list card and the detail card.
 *
 * Renders NOTHING when the server is not running inside cmux — the card must
 * look exactly as it did before this feature existed. "cmux is up but no
 * workspace matches this worktree" is a normal state (7 of 10 matched when
 * measured), so it gets a Create button rather than an error.
 */
export function CmuxWorkspaceSection({ path, branch }: { path: string; branch: string }) {
  const cmux = useCmux()
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)

  const select = useMutation({
    mutationFn: (ref: string) => api.cmuxSelect(ref),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cmux"] }),
  })

  if (!cmux.data?.available) return null

  const matches: CmuxWorkspace[] = cmux.data.matches?.[path] ?? []

  // These buttons live inside the home page's card, which is one big
  // navigation target. Without stopPropagation, switching also navigates.
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div data-cmux-section>
      <Stack gap={4}>
        {matches.length === 0 ? (
          <Group gap={8} wrap="nowrap" justify="space-between">
            <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
              <ColorBar />
              <Text size="xs" c="dimmed">No cmux workspace</Text>
            </Group>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={(e) => { stop(e); setCreateOpen(true) }}
            >
              Create
            </Button>
          </Group>
        ) : (
          matches.map((ws) => (
            <Group key={ws.ref} gap={8} wrap="nowrap" justify="space-between">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <ColorBar color={ws.color} />
                <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
                  {ws.title}
                </Text>
              </Group>
              <Button
                size="compact-xs"
                variant="subtle"
                disabled={ws.selected || select.isPending}
                onClick={(e) => { stop(e); select.mutate(ws.ref) }}
              >
                {ws.selected ? "Current" : "Switch"}
              </Button>
            </Group>
          ))
        )}
      </Stack>

      <CreateWorkspaceModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        path={path}
        branch={branch}
      />
    </div>
  )
}
```

- [ ] **Step 6: Wire it into both cards**

In `ui/src/components/WorktreeDetailCard.tsx`, inside `<Stack gap={8}>` and **before** the `<Group>` holding the name:

```tsx
        <CmuxWorkspaceSection path={w.path} branch={git?.branch || w.branch} />
```

Add the import. That card has no anchor wrapper, so nothing else is needed.

`WorktreeCard.tsx` needs a small restructure instead of a plain insertion. Today
the `interactive` props spread onto `<Paper>`, making the whole card a single
`<a>` whose `onClick` calls `preventDefault()` before navigating. Putting a
`<button>` inside that anchor is invalid HTML, and `stopPropagation` alone would
make it WORSE: the anchor's `onClick` would never run, so `preventDefault()`
would never run, and the browser would perform the native anchor navigation —
a full page reload. The card's own comment records the intent: "there is nothing
interactive nested inside it any more to conflict with."

So render the section as a sibling of the anchor, inside the Paper:

```tsx
  return (
    <Paper p="sm" withBorder>
      <CmuxWorkspaceSection path={w.path} branch={w.branch} />
      <Box {...interactive}>
        <Stack gap={6}>
          {/* ...existing card body, unchanged... */}
        </Stack>
      </Box>
    </Paper>
  )
```

`Box` accepts the `component: "a"` / `href` / `onClick` / `style` props exactly
as `Paper` did, so `interactive` moves across unchanged. When `clickable` is
false, `interactive` is `{}` and `Box` renders a plain `div`, as before. The
visual result is identical because the section still sits inside the Paper,
above the title.

- [ ] **Step 7: Run the tests**

Run: `cd ui && npm test`
Expected: PASS, including the existing `WorktreeCard`/`WorktreeDetailCard` suites.

- [ ] **Step 8: Commit**

```bash
git add ui/src/api/cmux.ts ui/src/api/client.ts ui/src/api/types.ts \
  ui/src/components/CmuxWorkspaceSection.tsx ui/src/components/CmuxWorkspaceSection.test.tsx \
  ui/src/components/WorktreeCard.tsx ui/src/components/WorktreeDetailCard.tsx
git commit --signoff -m "feat(ui): cmux workspace section with switch on both worktree cards"
```

---

## Task 4: create a cmux workspace from the card

**Files:**
- Modify: `internal/webui/cmux_api.go` (add `handleCmuxCreate`), `internal/webui/server.go`, `ui/src/api/client.ts`, `ui/src/api/types.ts`
- Create: `ui/src/components/CreateWorkspaceModal.tsx`, `ui/src/components/CreateWorkspaceModal.test.tsx`

**Interfaces:**
- Consumes: `cmux.BuildLayout(uiURL, urls)`, `cmux.NewWorkspace(NewWorkspaceOptions)`, `cmux.SetWorkspaceColor`, `cmux.PinBrowserTabs`, `cmux.FocusFirstBrowserTab`, `resources.Load`, `Server.Port`.
- Produces: `POST /api/cmux/create`; `<CreateWorkspaceModal opened onClose path branch />`.

- [ ] **Step 1: Write the failing test**

Append to `internal/webui/cmux_api_test.go`:

```go
func TestCmuxCreateRequiresPath(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/cmux/create", strings.NewReader(`{"name":"x"}`))
	s.handleCmuxCreate(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a missing path", rec.Code)
	}
}

func TestCmuxCreateUnavailableIsNotAnError(t *testing.T) {
	t.Setenv("CMUX_SOCKET_PATH", "")
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/cmux/create",
		strings.NewReader(`{"path":"/wt/a","name":"x"}`))
	s.handleCmuxCreate(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (cmux failures never 5xx)", rec.Code)
	}
	var got cmuxActionResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.OK {
		t.Fatal("ok = true with cmux unavailable")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/webui/ -run TestCmuxCreate -v`
Expected: FAIL — `s.handleCmuxCreate undefined`.

- [ ] **Step 3: Write the handler**

Append to `internal/webui/cmux_api.go` (add imports `fmt`, `github.com/mturley/worktree/internal/resources`):

```go
type cmuxCreateRequest struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	GroupRef string `json:"group_ref"`
	Color    string `json:"color"`
}

// handleCmuxCreate: POST /api/cmux/create
//
// Builds the same layout `worktree new` does, but from the worktree's
// resources AS THEY ARE NOW — usually better than at creation time, since
// resources get added later. The server knows its own port, so the pinned UI
// tab is easier here than in the CLI, where runningUIDetailURL has to probe
// for a listener.
func (s *Server) handleCmuxCreate(w http.ResponseWriter, r *http.Request) {
	var req cmuxCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "missing path")
		return
	}
	if !cmux.IsAvailable() {
		writeJSON(w, http.StatusOK, cmuxActionResponse{OK: false, Error: "cmux is not running"})
		return
	}

	var urls []string
	if s.DB != nil {
		if res, err := resources.Load(s.DB, req.Path); err == nil {
			for _, x := range resources.OfType(res, "pr") {
				if x.URL != "" {
					urls = append(urls, x.URL)
				}
			}
			for _, x := range resources.OfType(res, "jira") {
				if !x.Related && x.URL != "" {
					urls = append(urls, x.URL)
				}
			}
		}
	}

	uiURL := fmt.Sprintf("http://127.0.0.1:%d/worktree/%s", s.Port, url.PathEscape(req.Path))

	opts := cmux.NewWorkspaceOptions{
		Name:     req.Name,
		Cwd:      req.Path,
		Focus:    true,
		GroupRef: req.GroupRef,
		Layout:   cmux.BuildLayout(uiURL, urls),
	}
	ref, err := cmux.NewWorkspace(opts)
	if err != nil {
		writeJSON(w, http.StatusOK, cmuxActionResponse{OK: false, Error: err.Error()})
		return
	}

	// Everything past creation is best-effort: a workspace that exists but
	// missed its colour is still a usable workspace.
	if req.Color != "" {
		cmux.SetWorkspaceColor(ref, req.Color)
	}
	cmux.PinBrowserTabs(ref)
	cmux.FocusFirstBrowserTab(ref)
	cmux.Activate()

	writeJSON(w, http.StatusOK, cmuxActionResponse{OK: true, Ref: ref})
}
```

Register in `server.go`:

```go
	mux.HandleFunc("POST /api/cmux/create", s.handleCmuxCreate)
```

- [ ] **Step 4: Add the client methods and types**

In `ui/src/api/types.ts`:

```ts
export interface CmuxGroup { ref: string; name: string }
export interface CmuxColor { name: string; hex: string }
export interface CmuxGroupsResponse { groups: CmuxGroup[]; colors: CmuxColor[] }
```

In `ui/src/api/client.ts`:

```ts
  cmuxGroups: () => fetchJSON<CmuxGroupsResponse>("/api/cmux-groups"),
  cmuxCreate: (args: { path: string; name: string; group_ref?: string; color?: string }) =>
    fetchJSON<{ ok: boolean; ref?: string; error?: string }>("/api/cmux/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
```

- [ ] **Step 5: Write the modal test**

Create `ui/src/components/CreateWorkspaceModal.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { CreateWorkspaceModal } from "./CreateWorkspaceModal"
import { api } from "../api/client"

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <CreateWorkspaceModal opened onClose={() => {}} path="/wt/a" branch="my-branch" />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

describe("CreateWorkspaceModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, "cmuxGroups").mockResolvedValue({
      groups: [{ ref: "group:1", name: "Group 1" }],
      colors: [{ name: "Blue", hex: "#2980B9" }],
    })
  })

  it("defaults the name to 'wt <branch>'", async () => {
    renderModal()
    expect(await screen.findByDisplayValue("wt my-branch")).toBeInTheDocument()
  })

  it("creates with the entered name", async () => {
    const create = vi.spyOn(api, "cmuxCreate").mockResolvedValue({ ok: true, ref: "workspace:9" })
    renderModal()
    await screen.findByDisplayValue("wt my-branch")
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/wt/a", name: "wt my-branch" }),
    )
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd ui && npx vitest run src/components/CreateWorkspaceModal.test.tsx`
Expected: FAIL — cannot resolve `./CreateWorkspaceModal`.

- [ ] **Step 7: Write the modal**

Create `ui/src/components/CreateWorkspaceModal.tsx`:

```tsx
import { Button, Group, Modal, Select, Stack, TextInput, Tooltip } from "@mantine/core"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api } from "../api/client"

interface Props {
  opened: boolean
  onClose: () => void
  path: string
  branch: string
}

/**
 * Full parity with the CLI's workspace prompts: name, group, colour.
 *
 * Groups and colours are fetched only while the modal is open, keeping the
 * polled /api/cmux endpoint to a single exec. Colours come from the server
 * (cmux.NamedColors) rather than a duplicated TS list.
 */
export function CreateWorkspaceModal({ opened, onClose, path, branch }: Props) {
  const qc = useQueryClient()
  const [name, setName] = useState("")
  const [groupRef, setGroupRef] = useState<string | null>(null)
  const [color, setColor] = useState<string | null>(null)

  const meta = useQuery({
    queryKey: ["cmux-groups"],
    queryFn: () => api.cmuxGroups(),
    enabled: opened,
  })

  // Reset on every open so a cancelled attempt never leaks into the next one.
  useEffect(() => {
    if (opened) {
      setName(`wt ${branch}`)
      setGroupRef(null)
      setColor(null)
    }
  }, [opened, branch])

  const create = useMutation({
    mutationFn: () =>
      api.cmuxCreate({
        path,
        name,
        group_ref: groupRef ?? undefined,
        color: color ?? undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmux"] })
      onClose()
    },
  })

  return (
    <Modal opened={opened} onClose={onClose} title="Create cmux workspace" centered>
      <Stack gap="sm">
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Select
          label="Group"
          placeholder="(none)"
          clearable
          value={groupRef}
          onChange={setGroupRef}
          data={(meta.data?.groups ?? []).map((g) => ({ value: g.ref, label: g.name }))}
        />
        <Stack gap={4}>
          <Group gap={6} wrap="wrap">
            {(meta.data?.colors ?? []).map((c) => (
              <Tooltip key={c.name} label={c.name}>
                <button
                  type="button"
                  aria-label={c.name}
                  onClick={() => setColor(color === c.name ? null : c.name)}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: c.hex,
                    cursor: "pointer",
                    border: color === c.name
                      ? "2px solid var(--mantine-color-text)"
                      : "2px solid transparent",
                  }}
                />
              </Tooltip>
            ))}
          </Group>
        </Stack>
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={!name.trim()}
          >
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
```

- [ ] **Step 8: Run the tests**

Run: `go test ./internal/webui/ -run TestCmux -v && cd ui && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add internal/webui/cmux_api.go internal/webui/cmux_api_test.go internal/webui/server.go \
  ui/src/api/client.ts ui/src/api/types.ts \
  ui/src/components/CreateWorkspaceModal.tsx ui/src/components/CreateWorkspaceModal.test.tsx
git commit --signoff -m "feat: create a cmux workspace for a worktree from the web UI"
```

---

## Task 5: extract `internal/resourceurl`

**Files:**
- Create: `internal/resourceurl/resourceurl.go`, `internal/resourceurl/resourceurl_test.go`
- Modify: `internal/webui/inferresource.go` (delete, replaced by a thin call), `internal/webui/resource_mutate_api.go` (call site), `cmd/root.go` (use the shared pattern)
- Delete: `internal/webui/inferresource_test.go` after porting its cases

**Interfaces:**
- Produces: `resourceurl.Infer(rawURL string) (resType, id string, ok bool)`, `resourceurl.PRURLPattern *regexp.Regexp`.

- [ ] **Step 1: Write the failing test**

Create `internal/resourceurl/resourceurl_test.go`:

```go
package resourceurl

import "testing"

func TestInfer(t *testing.T) {
	cases := []struct {
		name, url, wantType, wantID string
		wantOK                      bool
	}{
		{"pr url", "https://github.com/o/r/pull/42", "pr", "o/r#42", true},
		{"jira url", "https://x.atlassian.net/browse/ABC-1", "jira", "ABC-1", true},
		{"unknown", "https://example.com/nope", "", "", false},
		{"empty", "", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gt, gi, ok := Infer(tc.url)
			if ok != tc.wantOK || gt != tc.wantType || gi != tc.wantID {
				t.Fatalf("Infer(%q) = (%q,%q,%v), want (%q,%q,%v)",
					tc.url, gt, gi, ok, tc.wantType, tc.wantID, tc.wantOK)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/resourceurl/`
Expected: FAIL — no such package.

- [ ] **Step 3: Write the package**

Create `internal/resourceurl/resourceurl.go` — the body moves verbatim from `internal/webui/inferresource.go`:

```go
// Package resourceurl maps a pasted URL to the worktree resource it names.
//
// It exists because three callers need the same answer — the CLI (`worktree
// resources add`), the web UI's add-resource handler, and the creation runner
// — and the previous arrangement had webui hand-copying cmd/root.go's PR
// pattern with a comment promising to keep them in sync. One detector, no
// promise to keep.
package resourceurl

import (
	"fmt"
	"regexp"
	"strconv"

	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/slackurl"
)

// PRURLPattern extracts owner/repo/number from a GitHub PR URL.
var PRURLPattern = regexp.MustCompile(`github\.com/([^/]+)/([^/]+)/pull/(\d+)`)

// Infer returns the resource type and id a URL names, or ok=false when the URL
// matches nothing known.
func Infer(rawURL string) (resType, id string, ok bool) {
	if m := PRURLPattern.FindStringSubmatch(rawURL); m != nil {
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

- [ ] **Step 4: Update the call sites**

Delete `internal/webui/inferresource.go` and `internal/webui/inferresource_test.go`. In `internal/webui/resource_mutate_api.go`, replace `inferResource(` with `resourceurl.Infer(` and add the import.

In `cmd/root.go`, delete the local `prURLPattern` declaration and replace its uses with `resourceurl.PRURLPattern`, adding the import.

- [ ] **Step 5: Run the tests**

Run: `make test`
Expected: PASS — nothing references `inferResource` or the old `prURLPattern`.

Confirm with: `grep -rn "inferResource\|prURLPattern" --include="*.go" .`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add internal/resourceurl/ internal/webui/resource_mutate_api.go cmd/root.go
git rm internal/webui/inferresource.go internal/webui/inferresource_test.go
git commit --signoff -m "refactor: extract resourceurl so one detector serves cmd and webui"
```

---

## Task 6: `worktree resources add` accepts a URL

**Files:**
- Modify: `cmd/resources.go:57-61` (the command), `cmd/resources.go:145-158` (`runResourcesAdd`)
- Test: `cmd/resources_test.go`

**Interfaces:**
- Consumes: `resourceurl.Infer`.
- Produces: `resolveResourceArgs(args []string) (resType, id, url string, err error)`.

- [ ] **Step 1: Write the failing test**

Append to `cmd/resources_test.go`:

```go
func TestResolveResourceArgs(t *testing.T) {
	cases := []struct {
		name                          string
		args                          []string
		wantType, wantID, wantURL     string
		wantErr                       bool
	}{
		{
			name: "url form infers type and id",
			args: []string{"https://github.com/o/r/pull/42"},
			wantType: "pr", wantID: "o/r#42", wantURL: "https://github.com/o/r/pull/42",
		},
		{
			name: "slack url form",
			args: []string{"https://x.slack.com/archives/C123/p1700000000000200"},
			wantType: "slack", wantID: "C123:1700000000.000200",
			wantURL: "https://x.slack.com/archives/C123/p1700000000000200",
		},
		{
			name: "explicit two-arg form still works",
			args: []string{"jira", "ABC-1"},
			wantType: "jira", wantID: "ABC-1",
		},
		{
			name:    "unrecognized single arg is an error, not a resource",
			args:    []string{"just-some-text"},
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gt, gi, gu, err := resolveResourceArgs(tc.args)
			if tc.wantErr {
				if err == nil {
					t.Fatal("want an error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if gt != tc.wantType || gi != tc.wantID || gu != tc.wantURL {
				t.Fatalf("= (%q,%q,%q), want (%q,%q,%q)",
					gt, gi, gu, tc.wantType, tc.wantID, tc.wantURL)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/ -run TestResolveResourceArgs -v`
Expected: FAIL — `undefined: resolveResourceArgs`.

- [ ] **Step 3: Implement**

In `cmd/resources.go`, change the command definition:

```go
var resourcesAddCmd = &cobra.Command{
	Use:   "add <url> | <type> <id>",
	Short: "Track a resource, by URL or by explicit type and id",
	Args:  cobra.RangeArgs(1, 2),
	RunE:  runResourcesAdd,
}
```

Add the helper and rewrite `runResourcesAdd`:

```go
// resolveResourceArgs accepts either one URL to infer from, or an explicit
// type and id. The URL form exists because a resource id like
// "C069KSM8T9N:1787257539.775119" is not something anyone derives by hand —
// which is exactly why `worktree add` used to accept Slack URLs.
func resolveResourceArgs(args []string) (resType, id, url string, err error) {
	if len(args) == 2 {
		return args[0], args[1], resURL, nil
	}
	t, i, ok := resourceurl.Infer(args[0])
	if !ok {
		return "", "", "", fmt.Errorf(
			"unrecognized resource URL: %s\n  Pass an explicit type and id instead: worktree resources add <type> <id>",
			args[0])
	}
	return t, i, args[0], nil
}

func runResourcesAdd(cmd *cobra.Command, args []string) error {
	resType, id, url, err := resolveResourceArgs(args)
	if err != nil {
		return err
	}
	wt, err := resourceWorktreePath()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		return err
	}
	defer conn.Close()
	return resources.Add(conn, wt, resources.Resource{
		Type: resType, ID: id, URL: url, Related: resRelated,
	})
}
```

Add `"github.com/mturley/worktree/internal/resourceurl"` to the imports.

- [ ] **Step 4: Run the tests**

Run: `go test ./cmd/ -run TestResolveResourceArgs -v && make test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/resources.go cmd/resources_test.go
git commit --signoff -m "feat(cli): worktree resources add accepts a URL"
```

---

## Task 7: narrow `worktree add` to creation

**Files:**
- Modify: `cmd/add.go:30-63` (`runAdd`)
- Test: `cmd/add_test.go` (create)

**Interfaces:**
- Consumes: `slackurl.Parse`, `resourceurl.Infer`.
- Produces: `classifyAddInput(arg string) (kind addKind, err error)` where `addKind` is one of `addBranch`, `addJira`, `addPRNumber`, `addPRURL`.

- [ ] **Step 1: Write the failing test**

Create `cmd/add_test.go`:

```go
package cmd

import (
	"strings"
	"testing"
)

func TestClassifyAddInputRejectsNonCreatingForms(t *testing.T) {
	// The bug this prevents: runAdd used to FALL THROUGH to handleBranch, so
	// removing the Slack branch without an explicit rejection would create a
	// branch literally named "https://...".
	cases := []struct {
		name, arg, wantIn string
	}{
		{
			name:   "slack url redirects to resources add",
			arg:    "https://x.slack.com/archives/C123/p1700000000000200",
			wantIn: "worktree resources add",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := classifyAddInput(tc.arg)
			if err == nil {
				t.Fatal("want a redirect error, got nil — this would create a branch named after the URL")
			}
			if !strings.Contains(err.Error(), tc.wantIn) {
				t.Fatalf("error %q does not name the right command (want %q)", err, tc.wantIn)
			}
		})
	}
}

func TestClassifyAddInputCreatingForms(t *testing.T) {
	cases := []struct {
		arg  string
		want addKind
	}{
		{"https://github.com/o/r/pull/42", addPRURL},
		{"https://x.atlassian.net/browse/ABC-1", addJira},
		{"42", addPRNumber},
		{"my-feature-branch", addBranch},
	}
	for _, tc := range cases {
		t.Run(tc.arg, func(t *testing.T) {
			got, err := classifyAddInput(tc.arg)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("classifyAddInput(%q) = %v, want %v", tc.arg, got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/ -run TestClassifyAddInput -v`
Expected: FAIL — `undefined: classifyAddInput`.

- [ ] **Step 3: Implement**

In `cmd/add.go`, add the classifier and rewrite `runAdd`:

```go
type addKind int

const (
	addBranch addKind = iota
	addJira
	addPRNumber
	addPRURL
)

// classifyAddInput decides which creation path an argument takes, and rejects
// the two forms that never created a worktree.
//
// The rejection is the point. runAdd used to fall through to handleBranch for
// anything it did not recognize, so simply dropping the Slack and path
// branches would silently create a branch named after the URL or path. Each
// removed form keeps its detection and names the command that replaced it.
func classifyAddInput(arg string) (addKind, error) {
	if resourceurl.PRURLPattern.MatchString(arg) {
		return addPRURL, nil
	}
	if jira.IsJiraURL(arg) {
		return addJira, nil
	}
	if _, _, ok := slackurl.Parse(arg); ok {
		return 0, fmt.Errorf(
			"Slack URLs are tracked as resources, not worktrees.\n  Try: worktree resources add %s", arg)
	}
	if _, err := strconv.Atoi(arg); err == nil {
		return addPRNumber, nil
	}
	if isExistingWorktreeDir(arg) {
		return 0, fmt.Errorf(
			"that path is an existing worktree.\n  Try: worktree info %s", arg)
	}
	return addBranch, nil
}

// isExistingWorktreeDir reports whether arg is a directory holding a .git file
// or directory — the check runAdd used to route to `worktree info`.
func isExistingWorktreeDir(arg string) bool {
	info, err := os.Stat(arg)
	if err != nil || !info.IsDir() {
		return false
	}
	gitPath := filepath.Join(arg, ".git")
	if _, err := os.Stat(gitPath); err == nil {
		return true
	}
	data, err := os.ReadFile(gitPath)
	return err == nil && strings.HasPrefix(string(data), "gitdir:")
}

func runAdd(cmd *cobra.Command, args []string) error {
	arg := args[0]
	kind, err := classifyAddInput(arg)
	if err != nil {
		return err
	}

	switch kind {
	case addPRURL:
		m := resourceurl.PRURLPattern.FindStringSubmatch(arg)
		number, _ := strconv.Atoi(m[3])
		return handlePR(m[1], m[2], number)
	case addJira:
		return handleJiraURL(arg)
	case addPRNumber:
		return handlePRNumber(arg)
	default:
		return handleBranch(arg)
	}
}
```

Update the command's `Use` and `Short`:

```go
var addCmd = &cobra.Command{
	Use:     "add <branch-name | PR-number | PR-URL | Jira-URL>",
	Short:   "Create a worktree",
	GroupID: "worktree",
	Args:    cobra.ExactArgs(1),
	RunE:    runAdd,
}
```

Adjust imports: `cmd/add.go` needs `fmt`, `os`, `path/filepath`, `strconv`, `strings`, `jira`, `slackurl`, `resourceurl`; drop `wdb` and `resources` if `handleSlackURL` is deleted.

- [ ] **Step 4: Delete `handleSlackURL`**

Remove `handleSlackURL` from `cmd/add.go:65-83` — `worktree resources add <url>` replaces it.

- [ ] **Step 5: Run the tests**

Run: `go test ./cmd/ -v && make test`
Expected: PASS.

- [ ] **Step 6: Verify by hand**

```bash
go build -o /tmp/wt-h . && /tmp/wt-h add 'https://x.slack.com/archives/C123/p1700000000000200'
```
Expected: the redirect error naming `worktree resources add`, and **no branch created**.

- [ ] **Step 7: Commit**

```bash
git add cmd/add.go cmd/add_test.go
git commit --signoff -m "feat(cli)!: worktree add only creates worktrees; slack and path forms redirect"
```

---

## Task 8: `internal/worktreenew` — the shared creation runner (branch and Jira paths)

**Files:**
- Create: `internal/worktreenew/worktreenew.go`, `internal/worktreenew/worktreenew_test.go`

**Interfaces:**
- Consumes: `gitutil.CreateBranchWorktree`, `gitutil.Pull`, `gitutil.MainRoot`, `ports.Allocate`, `registry.Register`, `env.KubeconfigPath`, `env.SeedKubeconfig`, `resources.Add`, `dotfiles.Discover`, `dotfiles.Copy`, `resourceurl.Infer`, `jira.IsJiraURL`, `jira.ParseJiraURL`.
- Produces: `StepKey` constants, `Status`, `Step`, `Options`, `ConfirmKey`, `Confirm`, `Result`, `Run(conn *sql.DB, cfg config.Config, opts Options, observe func(Step)) Result`.

- [ ] **Step 1: Write the failing test**

Create `internal/worktreenew/worktreenew_test.go`:

```go
package worktreenew

import (
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/mturley/worktree/internal/config"
)

// newRepo makes a temp git repo with one commit, and returns its root.
func newRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "T")
	run("commit", "--allow-empty", "-m", "init")
	return dir
}

func TestRunCreatesBranchWorktree(t *testing.T) {
	repo := newRepo(t)
	base := t.TempDir()
	cfg := config.Config{WorktreesBase: base}

	res := Run(nil, cfg, Options{Input: "my-feature", RepoRoot: repo}, nil)

	if res.Err != nil {
		t.Fatalf("unexpected error: %v", res.Err)
	}
	if res.Confirm != nil {
		t.Fatalf("unexpected confirmation: %#v", res.Confirm)
	}
	if res.Branch != "my-feature" {
		t.Fatalf("branch = %q, want my-feature", res.Branch)
	}
	if got := statusOf(res, StepCreateWorktree); got != StatusDone {
		t.Fatalf("create_worktree = %q, want done", got)
	}
}

func TestRunReplayIsSkippedNotFailed(t *testing.T) {
	// Statelessness depends on this: granting a confirmation re-POSTs the
	// whole request, so a second run over finished work must not report
	// failure.
	repo := newRepo(t)
	cfg := config.Config{WorktreesBase: t.TempDir()}
	opts := Options{Input: "my-feature", RepoRoot: repo}

	Run(nil, cfg, opts, nil)
	res := Run(nil, cfg, opts, nil)

	if res.Err != nil {
		t.Fatalf("replay errored: %v", res.Err)
	}
	if got := statusOf(res, StepCreateWorktree); got != StatusSkipped {
		t.Fatalf("replayed create_worktree = %q, want skipped", got)
	}
}

func TestRunRejectsUnknownRepoRoot(t *testing.T) {
	cfg := config.Config{WorktreesBase: t.TempDir()}
	res := Run(nil, cfg, Options{Input: "x", RepoRoot: filepath.Join(t.TempDir(), "nope")}, nil)
	if res.Err == nil {
		t.Fatal("want an error for a repo root that does not exist")
	}
}

func TestRunObserverSeesEveryStep(t *testing.T) {
	repo := newRepo(t)
	cfg := config.Config{WorktreesBase: t.TempDir()}

	var seen []StepKey
	Run(nil, cfg, Options{Input: "my-feature", RepoRoot: repo}, func(s Step) {
		seen = append(seen, s.Key)
	})

	if len(seen) == 0 {
		t.Fatal("observer never called")
	}
	if seen[0] != StepPull {
		t.Fatalf("first observed step = %q, want pull", seen[0])
	}
}

func statusOf(r Result, k StepKey) Status {
	for _, s := range r.Steps {
		if s.Key == k {
			return s.Status
		}
	}
	return ""
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/worktreenew/`
Expected: FAIL — no such package.

- [ ] **Step 3: Write the runner**

Create `internal/worktreenew/worktreenew.go`:

```go
// Package worktreenew runs the worktree creation sequence.
//
// It exists so the CLI and the web UI share one sequence rather than two
// copies, exactly as internal/worktreedel does for deletion. The steps used to
// live inline across cmd/root.go (handleBranch, handleJiraIssue, handlePR,
// finalizeWorktree); a second copy in the HTTP handler would drift silently,
// and the symptom — a web-created worktree that never allocated a port range —
// stays invisible until the range runs out.
//
// Every run is complete and idempotent. There is no server-side session: a
// confirmation is answered by replaying the whole request with the answer set,
// so each step must tolerate having already been done and report `skipped`
// rather than failing.
package worktreenew

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/dotfiles"
	"github.com/mturley/worktree/internal/env"
	"github.com/mturley/worktree/internal/gitutil"
	"github.com/mturley/worktree/internal/jira"
	"github.com/mturley/worktree/internal/ports"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/resources"
)

type StepKey string

const (
	StepPull           StepKey = "pull"
	StepCreateWorktree StepKey = "create_worktree"
	StepAllocatePorts  StepKey = "allocate_ports"
	StepRegister       StepKey = "register"
	StepKubeconfig     StepKey = "kubeconfig"
	StepResources      StepKey = "resources"
	StepDotfiles       StepKey = "dotfiles"
	StepCmuxWorkspace  StepKey = "cmux_workspace"
)

type Status string

const (
	StatusDone    Status = "done"
	StatusSkipped Status = "skipped"
	StatusFailed  Status = "failed"
	StatusPending Status = "pending"
)

type Step struct {
	Key    StepKey `json:"key"`
	Label  string  `json:"label"`
	Status Status  `json:"status"`
	Detail string  `json:"detail,omitempty"`
}

// ConfirmKey names a pending question. It is its own type rather than a
// StepKey because both questions arise inside create_worktree, so a step key
// could not tell them apart.
type ConfirmKey string

const (
	ConfirmReuseBranch ConfirmKey = "reuse_branch"
	ConfirmResetToPR   ConfirmKey = "reset_to_pr"
)

// Confirm carries what a caller needs in order to answer. LocalHead and
// RemoteHead are empty when the branch is already synced.
type Confirm struct {
	Key        ConfirmKey `json:"key"`
	Branch     string     `json:"branch"`
	LocalHead  string     `json:"local_head,omitempty"`
	RemoteHead string     `json:"remote_head,omitempty"`
}

type Options struct {
	Input        string // branch name, Jira key/URL, PR number, or PR URL
	RepoRoot     string
	Pull         bool
	CopyDotfiles bool

	// Answers carried on the replay.
	ReuseBranch bool
	ResetToPR   bool
}

type Result struct {
	Steps   []Step   `json:"steps"`
	Confirm *Confirm `json:"confirm"`
	Path    string   `json:"path,omitempty"`
	Branch  string   `json:"branch,omitempty"`
	Err     error    `json:"-"`
}

var labels = map[StepKey]string{
	StepPull:           "Pull latest",
	StepCreateWorktree: "Create worktree",
	StepAllocatePorts:  "Allocate port range",
	StepRegister:       "Register worktree",
	StepKubeconfig:     "Seed kubeconfig",
	StepResources:      "Track resources",
	StepDotfiles:       "Copy dotfiles",
	StepCmuxWorkspace:  "cmux workspace",
}

// order is the full sequence, used to fill in `pending` for steps a stopped
// run never reached — the stepper greys them rather than pretending they were
// skipped.
var order = []StepKey{
	StepPull, StepCreateWorktree, StepAllocatePorts, StepRegister,
	StepKubeconfig, StepResources, StepDotfiles,
}

type runner struct {
	conn    *sql.DB
	cfg     config.Config
	opts    Options
	observe func(Step)
	steps   []Step
}

func (r *runner) record(key StepKey, status Status, detail string) {
	s := Step{Key: key, Label: labels[key], Status: status, Detail: detail}
	r.steps = append(r.steps, s)
	if r.observe != nil {
		r.observe(s)
	}
}

// finish pads the step list with `pending` entries for everything the run
// never reached.
func (r *runner) finish() []Step {
	seen := make(map[StepKey]bool, len(r.steps))
	for _, s := range r.steps {
		seen[s.Key] = true
	}
	out := r.steps
	for _, k := range order {
		if !seen[k] {
			out = append(out, Step{Key: k, Label: labels[k], Status: StatusPending})
		}
	}
	return out
}

// Run executes the creation sequence, reporting each step to observe as it
// completes. observe may be nil.
func Run(conn *sql.DB, cfg config.Config, opts Options, observe func(Step)) Result {
	r := &runner{conn: conn, cfg: cfg, opts: opts, observe: observe}

	if info, err := os.Stat(opts.RepoRoot); err != nil || !info.IsDir() {
		return Result{Steps: r.finish(), Err: fmt.Errorf("repo root not found: %s", opts.RepoRoot)}
	}

	// Pull first, so the new worktree branches from current upstream.
	if opts.Pull {
		if err := gitutil.Pull(opts.RepoRoot); err != nil {
			// A failed pull is not fatal — the worktree is still creatable
			// from whatever the local clone has.
			r.record(StepPull, StatusFailed, err.Error())
		} else {
			r.record(StepPull, StatusDone, "")
		}
	} else {
		r.record(StepPull, StatusSkipped, "not requested")
	}

	branch, primary := resolveInput(opts.Input)

	existed := false
	if _, err := os.Stat(filepath.Join(cfg.WorktreesBase, repoDirName(opts.RepoRoot), branch)); err == nil {
		existed = true
	}

	created, err := gitutil.CreateBranchWorktree(opts.RepoRoot, cfg.WorktreesBase, branch)
	if err != nil {
		r.record(StepCreateWorktree, StatusFailed, err.Error())
		return Result{Steps: r.finish(), Err: err}
	}
	if existed || !created.Created {
		r.record(StepCreateWorktree, StatusSkipped, "already exists")
	} else {
		r.record(StepCreateWorktree, StatusDone, created.Path)
	}

	r.finalize(created, primary)

	return Result{Steps: r.finish(), Path: created.Path, Branch: created.Branch}
}

// resolveInput turns the polymorphic input into a branch name and, for a Jira
// issue, the resource to record as primary. PR inputs are handled by the
// caller before reaching here (see Task 9).
func resolveInput(input string) (branch string, primary *resources.Resource) {
	if jira.IsJiraURL(input) {
		if key, ok := jira.ParseJiraURL(input); ok {
			return strings.ToLower(key), &resources.Resource{Type: "jira", ID: key, URL: input}
		}
	}
	if key, ok := jira.ParseKey(input); ok {
		return strings.ToLower(key), &resources.Resource{Type: "jira", ID: key}
	}
	return input, nil
}

func repoDirName(repoRoot string) string {
	if main := gitutil.MainRoot(repoRoot); main != "" {
		return filepath.Base(main)
	}
	return filepath.Base(repoRoot)
}

// finalize runs the post-creation sequence. Every step here is best-effort:
// a failure is recorded and the run continues, because stopping would leave
// more mess than proceeding — the same choice worktreedel makes for cleanup.
func (r *runner) finalize(created gitutil.CreateResult, primary *resources.Resource) {
	mainRoot := gitutil.MainRoot(r.opts.RepoRoot)
	if mainRoot == "" {
		mainRoot = r.opts.RepoRoot
	}
	repoName := filepath.Base(mainRoot)
	wtName := filepath.Base(created.Path)

	if r.conn == nil {
		r.record(StepAllocatePorts, StatusSkipped, "no database")
		r.record(StepRegister, StatusSkipped, "no database")
	} else {
		if _, err := ports.Allocate(r.conn, wtName); err != nil {
			r.record(StepAllocatePorts, StatusFailed, err.Error())
		} else {
			r.record(StepAllocatePorts, StatusDone, "")
		}
		entry := registry.Entry{
			Path: created.Path, Repo: repoName, RepoRoot: mainRoot,
			Branch: created.Branch, CreatedAt: time.Now().UTC().Format(time.RFC3339),
		}
		if err := registry.Register(r.conn, entry); err != nil {
			r.record(StepRegister, StatusFailed, err.Error())
		} else {
			r.record(StepRegister, StatusDone, "")
		}
	}

	kubePath := env.KubeconfigPath(repoName, wtName)
	if _, err := os.Stat(kubePath); err == nil {
		r.record(StepKubeconfig, StatusSkipped, "already present")
	} else if err := env.SeedKubeconfig(kubePath); err != nil {
		r.record(StepKubeconfig, StatusFailed, err.Error())
	} else {
		r.record(StepKubeconfig, StatusDone, kubePath)
	}

	if primary == nil || r.conn == nil {
		r.record(StepResources, StatusSkipped, "nothing to track")
	} else if err := resources.Add(r.conn, created.Path, *primary); err != nil {
		r.record(StepResources, StatusFailed, err.Error())
	} else {
		r.record(StepResources, StatusDone, primary.ID)
	}

	if !r.opts.CopyDotfiles {
		r.record(StepDotfiles, StatusSkipped, "not requested")
		return
	}
	dfs, err := dotfiles.Discover(mainRoot)
	if err != nil || len(dfs) == 0 {
		r.record(StepDotfiles, StatusSkipped, "none found")
		return
	}
	var failed []string
	for _, df := range dfs {
		if err := dotfiles.Copy(df.Path, created.Path, df); err != nil {
			failed = append(failed, df.Name)
		}
	}
	if len(failed) > 0 {
		r.record(StepDotfiles, StatusFailed, "failed: "+strings.Join(failed, ", "))
	} else {
		r.record(StepDotfiles, StatusDone, fmt.Sprintf("%d copied", len(dfs)))
	}
}
```

- [ ] **Step 4: Add `jira.ParseKey`**

Verified absent as of 2026-08-27 (`internal/jira/detect.go` has `IsJiraURL` and
`ParseJiraURL` but no bare-key parser), so this is a new function, not an edit.
Add to `internal/jira/detect.go`, with a test in `internal/jira/detect_test.go`
covering `"RHOAIENG-123"` → ok, `"my-branch"` → not ok, and lowercase
`"abc-1"` → `"ABC-1"`:

```go
var keyPattern = regexp.MustCompile(`^([A-Z][A-Z0-9]+)-(\d+)$`)

// ParseKey reports whether s is a bare Jira issue key like "RHOAIENG-123".
func ParseKey(s string) (string, bool) {
	if keyPattern.MatchString(strings.ToUpper(s)) {
		return strings.ToUpper(s), true
	}
	return "", false
}
```

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/worktreenew/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/worktreenew/ internal/jira/
git commit --signoff -m "feat: shared worktreenew runner for the branch and Jira creation paths"
```

---

## Task 9: the PR path and its confirmations

**Files:**
- Modify: `internal/worktreenew/worktreenew.go`
- Test: `internal/worktreenew/pr_test.go` (create)

**Interfaces:**
- Consumes: `gitutil.CreatePRWorktree`, `gitutil.CreateWorktreeFromExistingBranch`, `gitutil.SetPRTracking`, `gitutil.ResetHard`, `gitutil.FindRemoteForRepo`, `gitutil.MatchesRemote`, `github.FetchPRByRepo`, `github.Slugify`.
- Produces: `Options.PR *PRInput`, `PRInput{Owner, Repo string; Number int}`, `parsePRInput(input, repoRoot string) (*PRInput, error)`.

- [ ] **Step 1: Write the failing test**

Create `internal/worktreenew/pr_test.go`:

```go
package worktreenew

import "testing"

func TestParsePRInputFromURL(t *testing.T) {
	got, err := parsePRInput("https://github.com/owner/repo/pull/42", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == nil || got.Owner != "owner" || got.Repo != "repo" || got.Number != 42 {
		t.Fatalf("= %#v, want owner/repo#42", got)
	}
}

func TestParsePRInputNonPRIsNil(t *testing.T) {
	got, err := parsePRInput("my-branch", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Fatalf("= %#v, want nil for a branch name", got)
	}
}

func TestConfirmReuseBranchStopsTheRun(t *testing.T) {
	// A pending confirmation must stop the run: later steps stay pending so
	// the stepper can grey them rather than claiming they were skipped.
	r := &runner{}
	res := Result{Steps: r.finish(), Confirm: &Confirm{Key: ConfirmReuseBranch, Branch: "b"}}

	if statusOf(res, StepAllocatePorts) != StatusPending {
		t.Fatalf("allocate_ports = %q, want pending while a confirmation is open",
			statusOf(res, StepAllocatePorts))
	}
}

func TestConfirmKeysAreDistinct(t *testing.T) {
	// Both questions arise inside create_worktree, which is why ConfirmKey is
	// its own type rather than a StepKey.
	if ConfirmReuseBranch == ConfirmResetToPR {
		t.Fatal("confirm keys must be distinguishable")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/worktreenew/ -run TestParsePRInput -v`
Expected: FAIL — `undefined: parsePRInput`.

- [ ] **Step 3: Implement the PR path**

Add to `internal/worktreenew/worktreenew.go`:

```go
// PRInput identifies a pull request to build a worktree from.
type PRInput struct {
	Owner  string
	Repo   string
	Number int
}

// parsePRInput recognizes a PR URL or a bare PR number. For a bare number the
// repo comes from repoRoot's remotes — the web UI passes an explicitly chosen
// repo, where the CLI used to depend on the current directory.
func parsePRInput(input, repoRoot string) (*PRInput, error) {
	if m := resourceurl.PRURLPattern.FindStringSubmatch(input); m != nil {
		n, _ := strconv.Atoi(m[3])
		return &PRInput{Owner: m[1], Repo: m[2], Number: n}, nil
	}
	n, err := strconv.Atoi(input)
	if err != nil {
		return nil, nil
	}
	if repoRoot == "" {
		return nil, fmt.Errorf("a repo is required to resolve PR #%d", n)
	}
	slug := gitutil.RepoSlug(repoRoot)
	parts := strings.SplitN(slug, "/", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("cannot determine repo owner/name from remotes of %s", repoRoot)
	}
	return &PRInput{Owner: parts[0], Repo: parts[1], Number: n}, nil
}

// runPR creates a worktree from a pull request, pausing for confirmation when
// git needs an answer. Both questions replay: the caller re-invokes Run with
// the matching Options flag set, and the sequence reaches the same point with
// the answer already in hand.
func (r *runner) runPR(pr *PRInput) (gitutil.CreateResult, *resources.Resource, *Confirm, error) {
	info, err := github.FetchPRByRepo(pr.Owner, pr.Repo, pr.Number)
	if err != nil {
		return gitutil.CreateResult{}, nil, nil, err
	}
	if !gitutil.MatchesRemote(r.opts.RepoRoot, pr.Owner, pr.Repo) {
		return gitutil.CreateResult{}, nil, nil,
			fmt.Errorf("%s is not a clone of %s/%s", r.opts.RepoRoot, pr.Owner, pr.Repo)
	}
	remote, err := gitutil.FindRemoteForRepo(r.opts.RepoRoot, pr.Owner, pr.Repo)
	if err != nil {
		return gitutil.CreateResult{}, nil, nil, err
	}

	res, err := gitutil.CreatePRWorktree(
		r.opts.RepoRoot, r.cfg.WorktreesBase, remote, pr.Number, info.HeadRef,
		github.Slugify(info.Title))
	if err != nil {
		return gitutil.CreateResult{}, nil, nil, err
	}

	switch res.Status {
	case gitutil.PRWorktreeBranchExists:
		if !r.opts.ReuseBranch {
			return gitutil.CreateResult{}, nil, &Confirm{
				Key: ConfirmReuseBranch, Branch: res.Branch,
				LocalHead: res.LocalHead, RemoteHead: res.RemoteHead,
			}, nil
		}
		if err := gitutil.CreateWorktreeFromExistingBranch(
			r.opts.RepoRoot, res.Path, res.Branch); err != nil {
			return gitutil.CreateResult{}, nil, nil, err
		}
		fallthrough
	case gitutil.PRWorktreeExistingDir:
		if res.LocalHead != "" && res.RemoteHead != "" && res.LocalHead != res.RemoteHead {
			if !r.opts.ResetToPR {
				return gitutil.CreateResult{}, nil, &Confirm{
					Key: ConfirmResetToPR, Branch: res.Branch,
					LocalHead: res.LocalHead, RemoteHead: res.RemoteHead,
				}, nil
			}
			if err := gitutil.ResetHard(res.Path, res.FetchRef); err != nil {
				return gitutil.CreateResult{}, nil, nil, err
			}
		}
	}

	if err := gitutil.SetPRTracking(r.opts.RepoRoot, res.Branch, remote, pr.Number); err != nil {
		// Tracking is a convenience, not the deliverable.
		r.record(StepCreateWorktree, StatusDone, "tracking not set: "+err.Error())
	}

	primary := &resources.Resource{
		Type: "pr",
		ID:   fmt.Sprintf("%s/%s#%d", pr.Owner, pr.Repo, pr.Number),
		URL:  info.URL,
	}
	return res.CreateResult, primary, nil, nil
}
```

Add imports: `strconv`, `github.com/mturley/worktree/internal/github`, `github.com/mturley/worktree/internal/resourceurl`.

- [ ] **Step 4: Route PR inputs through `Run`**

In `Run`, replace the `branch, primary := resolveInput(...)` block and what follows with:

```go
	pr, err := parsePRInput(opts.Input, opts.RepoRoot)
	if err != nil {
		return Result{Steps: r.finish(), Err: err}
	}

	var created gitutil.CreateResult
	var primary *resources.Resource

	if pr != nil {
		var confirm *Confirm
		created, primary, confirm, err = r.runPR(pr)
		if err != nil {
			r.record(StepCreateWorktree, StatusFailed, err.Error())
			return Result{Steps: r.finish(), Err: err}
		}
		if confirm != nil {
			// Stop: later steps stay pending so the stepper greys them.
			return Result{Steps: r.finish(), Confirm: confirm}
		}
		r.record(StepCreateWorktree, StatusDone, created.Path)
	} else {
		branch, p := resolveInput(opts.Input)
		primary = p
		existed := false
		if _, statErr := os.Stat(filepath.Join(
			cfg.WorktreesBase, repoDirName(opts.RepoRoot), branch)); statErr == nil {
			existed = true
		}
		created, err = gitutil.CreateBranchWorktree(opts.RepoRoot, cfg.WorktreesBase, branch)
		if err != nil {
			r.record(StepCreateWorktree, StatusFailed, err.Error())
			return Result{Steps: r.finish(), Err: err}
		}
		if existed || !created.Created {
			r.record(StepCreateWorktree, StatusSkipped, "already exists")
		} else {
			r.record(StepCreateWorktree, StatusDone, created.Path)
		}
	}

	r.finalize(created, primary)
	return Result{Steps: r.finish(), Path: created.Path, Branch: created.Branch}
```

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/worktreenew/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/worktreenew/
git commit --signoff -m "feat(worktreenew): PR creation path with replayable confirmations"
```

---

## Task 10: drive the CLI from the runner

**Files:**
- Modify: `cmd/root.go` (`handleBranch`, `handleJiraIssue`, `handlePR`, `finalizeWorktree`)

**Interfaces:**
- Consumes: `worktreenew.Run`, `worktreenew.Options`, `worktreenew.Step`, `worktreenew.Confirm`.

- [ ] **Step 1: Replace `handleBranch` with a driver**

In `cmd/root.go`:

```go
// runCreate drives the shared creation runner, keeping the CLI's existing
// output. Confirmations are answered by re-running with the flag set — the
// same replay the web UI performs, so both surfaces exercise one code path.
func runCreate(input, repoRoot string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	conn, err := wdb.Open()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to open worktree db: %v\n", err)
	} else {
		defer conn.Close()
	}

	opts := worktreenew.Options{
		Input:    input,
		RepoRoot: repoRoot,
		Pull:     ui.ConfirmDefault("git pull before creating worktree?", true),
	}

	for {
		res := worktreenew.Run(conn, cfg, opts, func(s worktreenew.Step) {
			switch s.Status {
			case worktreenew.StatusDone:
				fmt.Printf("  %s %s\n", ui.Green("✓"), s.Label)
			case worktreenew.StatusFailed:
				fmt.Fprintf(os.Stderr, "  %s %s: %s\n", ui.Yellow("!"), s.Label, s.Detail)
			}
		})
		if res.Err != nil {
			return res.Err
		}
		if res.Confirm == nil {
			fmt.Printf("\n%s Worktree ready at %s\n", ui.Green("✓"), ui.ShortPath(res.Path))
			return offerCmuxAfterCreate(conn, cfg, res)
		}

		c := res.Confirm
		switch c.Key {
		case worktreenew.ConfirmReuseBranch:
			fmt.Printf("  Branch %s already exists\n", ui.Yellow(c.Branch))
			if !ui.Confirm("  Reuse this branch?") {
				fmt.Println("Aborted.")
				return nil
			}
			opts.ReuseBranch = true
		case worktreenew.ConfirmResetToPR:
			fmt.Printf("  %s Local (%s) differs from PR latest (%s)\n",
				ui.Yellow("!"), shortSHA(c.LocalHead), shortSHA(c.RemoteHead))
			if !ui.Confirm("  Reset to the PR's latest commit?") {
				// Declining is NOT an abort. By this point gitutil has already
				// created the worktree directory, so returning here would strand
				// it: on disk, unregistered, holding no port range, invisible to
				// the tool. Set DeclineReset and loop, so the runner skips the
				// reset and carries on to finalize — the worktree is perfectly
				// usable at its current commit.
				opts.DeclineReset = true
				continue
			}
			opts.ResetToPR = true
		}
	}
}

func handleBranch(branchName string) error {
	repoRoot, err := findRepoRoot()
	if err != nil {
		return fmt.Errorf("not in a git repo: %w", err)
	}
	return runCreate(branchName, repoRoot)
}
```

Rename the existing `openCmuxWorkspace` wrapper to `offerCmuxAfterCreate(conn, cfg, res worktreenew.Result)`, taking the path and branch from `res` instead of a `gitutil.CreateResult`.

- [ ] **Step 2: Point the other handlers at it**

```go
func handleJiraIssue(key, url string) error {
	repoRoot, err := findRepoRoot()
	if err != nil {
		return fmt.Errorf("not in a git repo: %w", err)
	}
	if url == "" {
		url = jira.IssueURL(jiraHostFromWatcherConfig(), key)
	}
	return runCreate(url, repoRoot)
}

func handlePR(owner, repo string, number int) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	repoRoot, err := findRepoForPR(cfg, owner, repo)
	if err != nil {
		return err
	}
	return runCreate(fmt.Sprintf("https://github.com/%s/%s/pull/%d", owner, repo, number), repoRoot)
}
```

Delete `finalizeWorktree`, `offerPull`, and `offerPRSync` — the runner owns all three now. Delete `offerDotfiles` only if nothing else calls it (`grep -n offerDotfiles cmd/`).

- [ ] **Step 3: Run the tests**

Run: `make test`
Expected: PASS.

- [ ] **Step 4: Smoke-test the CLI end to end**

```bash
export XDG_DATA_HOME=$(mktemp -d) XDG_CONFIG_HOME=$(mktemp -d)
go build -o /tmp/wt-h .
cd /tmp && git init -b main smoke && cd smoke \
  && git commit --allow-empty -m init \
  && /tmp/wt-h add smoke-branch
/tmp/wt-h list
```
Expected: the worktree is created, registered, and listed with a port range.

- [ ] **Step 5: Commit**

```bash
git add cmd/root.go
git commit --signoff -m "refactor(cli): drive worktree creation from the shared runner"
```

---

## Task 11: creation HTTP API

**Files:**
- Create: `internal/webui/worktree_create_api.go`, `internal/webui/worktree_create_api_test.go`
- Modify: `internal/webui/server.go`

**Interfaces:**
- Produces: `POST /api/worktrees/create`, `GET /api/repos`, `GET /api/repo-dotfiles`.

- [ ] **Step 1: Write the failing test**

Create `internal/webui/worktree_create_api_test.go`:

```go
package webui

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateWorktreeRequiresInputAndRepo(t *testing.T) {
	s := &Server{}
	for _, body := range []string{`{}`, `{"input":"x"}`, `{"repo_root":"/r"}`} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/worktrees/create", strings.NewReader(body))
		s.handleCreateWorktree(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, rec.Code)
		}
	}
}

func TestCreateWorktreeRejectsSlackURL(t *testing.T) {
	// The same rejection the CLI makes: never create a branch named after a
	// URL that was only ever meant to be a resource.
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/worktrees/create", strings.NewReader(
		`{"input":"https://x.slack.com/archives/C123/p1700000000000200","repo_root":"/r"}`))
	s.handleCreateWorktree(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a Slack URL", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "resource") {
		t.Fatalf("error should explain it is a resource, got %s", rec.Body.String())
	}
}

func TestCreateWorktreeFailureIs200WithOKFalse(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/worktrees/create", strings.NewReader(
		`{"input":"my-branch","repo_root":"/definitely/not/a/repo"}`))
	s.handleCreateWorktree(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 so the modal can show partial steps", rec.Code)
	}
	var got createWorktreeResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.OK {
		t.Fatal("ok = true for a nonexistent repo root")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/webui/ -run TestCreateWorktree -v`
Expected: FAIL — `s.handleCreateWorktree undefined`.

- [ ] **Step 3: Write the handlers**

Create `internal/webui/worktree_create_api.go`:

```go
package webui

import (
	"encoding/json"
	"net/http"
	"sort"

	"github.com/mturley/worktree/internal/config"
	"github.com/mturley/worktree/internal/dotfiles"
	"github.com/mturley/worktree/internal/registry"
	"github.com/mturley/worktree/internal/slackurl"
	"github.com/mturley/worktree/internal/worktreenew"
)

type createWorktreeRequest struct {
	Input        string `json:"input"`
	RepoRoot     string `json:"repo_root"`
	Pull         bool   `json:"pull"`
	CopyDotfiles bool   `json:"copy_dotfiles"`
	ReuseBranch  bool   `json:"reuse_branch"`
	ResetToPR    bool   `json:"reset_to_pr"`
	// DeclineReset is "the user was asked to reset and said no", which is a
	// different thing from ResetToPR being false ("not asked yet"). Without
	// it the client cannot decline: re-posting would raise the same question
	// forever, and closing the modal would strand a worktree git has already
	// created — on disk, unregistered, holding no port range.
	DeclineReset bool `json:"decline_reset"`
}

type createWorktreeResponse struct {
	OK      bool                 `json:"ok"`
	Confirm *worktreenew.Confirm `json:"confirm"`
	Steps   []worktreenew.Step   `json:"steps"`
	Path    string               `json:"path,omitempty"`
	Branch  string               `json:"branch,omitempty"`
	Error   string               `json:"error,omitempty"`
}

// handleCreateWorktree: POST /api/worktrees/create
//
// A pending confirmation comes back as 200 with a non-null `confirm`, never an
// error status: "git wants an answer" and "the create broke" are the one
// distinction the flow rests on. A hard failure is also 200 with ok:false, so
// the modal renders the partial step list instead of an error page.
//
// There is no server-side session. The client answers by re-POSTing the whole
// request with the matching flag set, and the runner replays from the top.
func (s *Server) handleCreateWorktree(w http.ResponseWriter, r *http.Request) {
	var req createWorktreeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if req.Input == "" {
		writeError(w, http.StatusBadRequest, "missing input")
		return
	}
	if req.RepoRoot == "" {
		writeError(w, http.StatusBadRequest, "missing repo_root")
		return
	}
	// Mirror the CLI's rejection so neither surface can create a branch named
	// after a URL that only ever named a resource.
	if _, _, ok := slackurl.Parse(req.Input); ok {
		writeError(w, http.StatusBadRequest,
			"Slack threads are tracked as a resource, not a worktree — add it from the worktree's resource list")
		return
	}

	cfg, err := config.Load()
	if err != nil {
		writeJSON(w, http.StatusOK, createWorktreeResponse{
			OK: false, Steps: []worktreenew.Step{}, Error: err.Error(),
		})
		return
	}

	res := worktreenew.Run(s.DB, cfg, worktreenew.Options{
		Input:        req.Input,
		RepoRoot:     req.RepoRoot,
		Pull:         req.Pull,
		CopyDotfiles: req.CopyDotfiles,
		ReuseBranch:  req.ReuseBranch,
		ResetToPR:    req.ResetToPR,
		DeclineReset: req.DeclineReset,
	}, nil)

	out := createWorktreeResponse{
		OK:      res.Err == nil,
		Confirm: res.Confirm,
		Steps:   res.Steps,
		Path:    res.Path,
		Branch:  res.Branch,
	}
	if res.Err != nil {
		out.Error = res.Err.Error()
	}
	writeJSON(w, http.StatusOK, out)
}

type repoDTO struct {
	Name     string `json:"name"`
	RepoRoot string `json:"repo_root"`
}

// handleRepos: GET /api/repos
//
// The CLI takes the repo from the current directory; a server has none, so the
// list comes from the registry. Sorted by each repo's most recently created
// worktree, so the repo you are actually working in leads the list.
//
// Known limitation: a repo with no registered worktrees does not appear. Its
// first worktree is still created from the CLI.
func (s *Server) handleRepos(w http.ResponseWriter, r *http.Request) {
	out := []repoDTO{}
	if s.DB == nil {
		writeJSON(w, http.StatusOK, out)
		return
	}
	entries, err := registry.List(s.DB)
	if err != nil {
		writeJSON(w, http.StatusOK, out)
		return
	}

	newest := map[string]string{}
	name := map[string]string{}
	for _, e := range entries {
		if e.RepoRoot == "" {
			continue
		}
		if e.CreatedAt > newest[e.RepoRoot] {
			newest[e.RepoRoot] = e.CreatedAt
		}
		name[e.RepoRoot] = e.Repo
	}
	for root := range newest {
		out = append(out, repoDTO{Name: name[root], RepoRoot: root})
	}
	sort.Slice(out, func(i, j int) bool {
		return newest[out[i].RepoRoot] > newest[out[j].RepoRoot]
	})
	writeJSON(w, http.StatusOK, out)
}

// handleRepoDotfiles: GET /api/repo-dotfiles?repo_root=...
//
// Feeds the modal's dotfiles checkbox, which lists what it would copy.
// Unchecked by default: copying .env files nobody asked for is exactly the
// surprise the CLI's prompt exists to prevent.
func (s *Server) handleRepoDotfiles(w http.ResponseWriter, r *http.Request) {
	root := r.URL.Query().Get("repo_root")
	if root == "" {
		writeError(w, http.StatusBadRequest, "missing repo_root")
		return
	}
	names := []string{}
	if dfs, err := dotfiles.Discover(root); err == nil {
		for _, d := range dfs {
			names = append(names, d.Name)
		}
	}
	writeJSON(w, http.StatusOK, names)
}
```

Register in `server.go`:

```go
	mux.HandleFunc("POST /api/worktrees/create", s.handleCreateWorktree)
	mux.HandleFunc("GET /api/repos", s.handleRepos)
	mux.HandleFunc("GET /api/repo-dotfiles", s.handleRepoDotfiles)
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/webui/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/webui/worktree_create_api.go internal/webui/worktree_create_api_test.go internal/webui/server.go
git commit --signoff -m "feat(webui): worktree creation endpoint with replayable confirmations"
```

---

## Task 12: the New worktree modal

**Files:**
- Create: `ui/src/components/NewWorktreeModal.tsx`, `ui/src/components/NewWorktreeModal.test.tsx`
- Modify: `ui/src/api/client.ts`, `ui/src/api/types.ts`, `ui/src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: `POST /api/worktrees/create`, `GET /api/repos`, `GET /api/repo-dotfiles`, `GET /api/cmux`, `GET /api/cmux-groups`, `POST /api/cmux/create`.

- [ ] **Step 1: Add types and client methods**

`ui/src/api/types.ts`:

```ts
export interface Repo { name: string; repo_root: string }

export interface CreateConfirm {
  key: "reuse_branch" | "reset_to_pr"
  branch: string
  local_head?: string
  remote_head?: string
}

export interface CreateStep {
  key: string
  label: string
  status: "done" | "skipped" | "failed" | "pending"
  detail?: string
}

export interface CreateWorktreeResponse {
  ok: boolean
  confirm: CreateConfirm | null
  steps: CreateStep[]
  path?: string
  branch?: string
  error?: string
}
```

`ui/src/api/client.ts`:

```ts
  repos: () => fetchJSON<Repo[]>("/api/repos"),
  repoDotfiles: (repoRoot: string) =>
    fetchJSON<string[]>(`/api/repo-dotfiles?repo_root=${encodeURIComponent(repoRoot)}`),
  createWorktree: (args: {
    input: string
    repo_root: string
    pull: boolean
    copy_dotfiles: boolean
    reuse_branch?: boolean
    reset_to_pr?: boolean
    decline_reset?: boolean
  }) =>
    fetchJSON<CreateWorktreeResponse>("/api/worktrees/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
```

- [ ] **Step 2: Write the failing test**

Create `ui/src/components/NewWorktreeModal.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { NewWorktreeModal } from "./NewWorktreeModal"
import { api } from "../api/client"

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <NewWorktreeModal opened onClose={() => {}} />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

describe("NewWorktreeModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, "repos").mockResolvedValue([
      { name: "worktree", repo_root: "/git/worktree" },
      { name: "other", repo_root: "/git/other" },
    ])
    vi.spyOn(api, "repoDotfiles").mockResolvedValue([".env.local"])
    vi.spyOn(api, "cmux").mockResolvedValue({ available: false })
  })

  it("defaults to the first (most recent) repo", async () => {
    renderModal()
    expect(await screen.findByDisplayValue("worktree")).toBeInTheDocument()
  })

  it("checks pull by default and leaves dotfiles unchecked", async () => {
    renderModal()
    expect(await screen.findByRole("checkbox", { name: /git pull/i })).toBeChecked()
    expect(await screen.findByRole("checkbox", { name: /dotfiles/i })).not.toBeChecked()
  })

  it("hides the cmux fields when cmux is unavailable", async () => {
    renderModal()
    await screen.findByDisplayValue("worktree")
    expect(screen.queryByLabelText(/workspace name/i)).toBeNull()
  })

  it("re-posts with reuse_branch when the confirmation is accepted", async () => {
    const create = vi.spyOn(api, "createWorktree")
      .mockResolvedValueOnce({
        ok: true, steps: [],
        confirm: { key: "reuse_branch", branch: "review/pr-1" },
      })
      .mockResolvedValueOnce({ ok: true, steps: [], confirm: null, path: "/wt/x" })

    renderModal()
    await screen.findByDisplayValue("worktree")
    await userEvent.type(screen.getByLabelText(/branch, pr, or issue/i), "42")
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))

    await screen.findByText(/already exists/i)
    await userEvent.click(screen.getByRole("button", { name: /reuse/i }))

    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ reuse_branch: true }),
    )
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ui && npx vitest run src/components/NewWorktreeModal.test.tsx`
Expected: FAIL — cannot resolve `./NewWorktreeModal`.

- [ ] **Step 4: Write the modal**

Create `ui/src/components/NewWorktreeModal.tsx`:

```tsx
import {
  Alert, Button, Checkbox, Divider, Group, Modal, Select, Stack, Text, TextInput, Timeline,
} from "@mantine/core"
import { IconCheck, IconX, IconMinus, IconPoint } from "@tabler/icons-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { useLocation } from "wouter"
import { api } from "../api/client"
import { useCmux } from "../api/cmux"
import type { CreateConfirm, CreateStep } from "../api/types"

function StepIcon({ status }: { status: CreateStep["status"] }) {
  if (status === "done") return <IconCheck size={12} />
  if (status === "failed") return <IconX size={12} />
  if (status === "skipped") return <IconMinus size={12} />
  return <IconPoint size={12} />
}

/**
 * Create a worktree, taking the same inputs as `worktree add`.
 *
 * Confirmations replay: when the server returns a pending `confirm`, the whole
 * request is re-posted with the matching flag set. There is no session to
 * orphan, which is why every step tolerates having already run.
 */
export function NewWorktreeModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const cmux = useCmux()

  const [input, setInput] = useState("")
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [pull, setPull] = useState(true)
  const [copyDotfiles, setCopyDotfiles] = useState(false)
  const [wsName, setWsName] = useState("")
  const [wsGroup, setWsGroup] = useState<string | null>(null)
  const [steps, setSteps] = useState<CreateStep[]>([])
  const [confirm, setConfirm] = useState<CreateConfirm | null>(null)
  const [error, setError] = useState("")
  const [donePath, setDonePath] = useState("")

  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api.repos(), enabled: opened })
  const dotfiles = useQuery({
    queryKey: ["repo-dotfiles", repoRoot],
    queryFn: () => api.repoDotfiles(repoRoot!),
    enabled: opened && !!repoRoot,
  })
  const cmuxMeta = useQuery({
    queryKey: ["cmux-groups"],
    queryFn: () => api.cmuxGroups(),
    enabled: opened && !!cmux.data?.available,
  })

  // Reset on open, and default to the most recent repo (the list is already
  // sorted newest-first by the server).
  useEffect(() => {
    if (!opened) return
    setInput(""); setPull(true); setCopyDotfiles(false)
    setSteps([]); setConfirm(null); setError(""); setDonePath("")
    setWsName(""); setWsGroup(null)
  }, [opened])

  useEffect(() => {
    if (opened && repos.data?.length && !repoRoot) setRepoRoot(repos.data[0].repo_root)
  }, [opened, repos.data, repoRoot])

  const create = useMutation({
    mutationFn: (answers: { reuse_branch?: boolean; reset_to_pr?: boolean }) =>
      api.createWorktree({
        input: input.trim(),
        repo_root: repoRoot!,
        pull,
        copy_dotfiles: copyDotfiles,
        ...answers,
      }),
    onSuccess: async (res) => {
      setSteps(res.steps)
      setConfirm(res.confirm)
      setError(res.error ?? "")
      if (res.confirm || !res.ok || !res.path) return

      if (cmux.data?.available && wsName.trim()) {
        // A workspace failure never invalidates the worktree that was created.
        await api.cmuxCreate({
          path: res.path, name: wsName.trim(), group_ref: wsGroup ?? undefined,
        }).catch(() => {})
      }
      setDonePath(res.path)
      qc.invalidateQueries({ queryKey: ["worktrees"] })
      qc.invalidateQueries({ queryKey: ["cmux"] })
    },
  })

  const answers = { reuse_branch: false, reset_to_pr: false }

  return (
    <Modal opened={opened} onClose={onClose} title="New worktree" centered>
      <Stack gap="sm">
        <TextInput
          label="Branch, PR, or issue"
          description="A branch name, PR number or URL, or a Jira issue URL"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          disabled={create.isPending || !!donePath}
        />
        <Select
          label="Repo"
          value={repoRoot}
          onChange={setRepoRoot}
          disabled={create.isPending || !!donePath}
          data={(repos.data ?? []).map((r) => ({ value: r.repo_root, label: r.name }))}
        />
        <Checkbox
          label="git pull first"
          checked={pull}
          onChange={(e) => setPull(e.currentTarget.checked)}
          disabled={create.isPending || !!donePath}
        />
        {(dotfiles.data?.length ?? 0) > 0 && (
          <Checkbox
            label={`copy ${dotfiles.data!.length} gitignored dotfiles`}
            description={dotfiles.data!.join(", ")}
            checked={copyDotfiles}
            onChange={(e) => setCopyDotfiles(e.currentTarget.checked)}
            disabled={create.isPending || !!donePath}
          />
        )}

        {cmux.data?.available && (
          <>
            <Divider label="cmux" labelPosition="left" />
            <TextInput
              label="Workspace name"
              placeholder="leave empty to skip creating a workspace"
              value={wsName}
              onChange={(e) => setWsName(e.currentTarget.value)}
              disabled={create.isPending || !!donePath}
            />
            <Select
              label="Group"
              placeholder="(none)"
              clearable
              value={wsGroup}
              onChange={setWsGroup}
              disabled={create.isPending || !!donePath}
              data={(cmuxMeta.data?.groups ?? []).map((g) => ({ value: g.ref, label: g.name }))}
            />
          </>
        )}

        {steps.length > 0 && (
          <Timeline active={steps.filter((s) => s.status !== "pending").length - 1} bulletSize={20}>
            {steps.map((s) => (
              <Timeline.Item key={s.key} bullet={<StepIcon status={s.status} />} title={s.label}>
                {s.detail && <Text size="xs" c="dimmed">{s.detail}</Text>}
              </Timeline.Item>
            ))}
          </Timeline>
        )}

        {confirm && (
          <Alert color="yellow" title={confirm.key === "reuse_branch" ? "Branch already exists" : "Local differs from the PR"}>
            <Stack gap="xs">
              <Text size="sm">
                {confirm.key === "reuse_branch"
                  ? `Branch ${confirm.branch} already exists.`
                  : `Local (${confirm.local_head?.slice(0, 8)}) differs from the PR's latest (${confirm.remote_head?.slice(0, 8)}).`}
              </Text>
              <Group justify="flex-end">
                {/* Declining the RESET is not a cancel. By this point git has
                    already created the worktree, so closing the modal would
                    strand it — on disk, unregistered, holding no ports. Re-post
                    with decline_reset so the runner skips the reset and
                    finishes. Declining the BRANCH REUSE is a genuine cancel:
                    nothing has been created yet. */}
                {confirm.key === "reset_to_pr" ? (
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => create.mutate({ ...answers, reuse_branch: true, decline_reset: true })}
                  >
                    Keep current commit
                  </Button>
                ) : (
                  <Button size="xs" variant="subtle" onClick={() => { setConfirm(null); onClose() }}>
                    Cancel
                  </Button>
                )}
                <Button
                  size="xs"
                  onClick={() =>
                    create.mutate(
                      confirm.key === "reuse_branch"
                        ? { ...answers, reuse_branch: true }
                        : { ...answers, reuse_branch: true, reset_to_pr: true },
                    )
                  }
                >
                  {confirm.key === "reuse_branch" ? "Reuse branch" : "Reset to PR"}
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}

        {error && <Alert color="red">{error}</Alert>}

        <Group justify="flex-end">
          {donePath ? (
            <Button onClick={() => { onClose(); navigate(`/worktree/${encodeURIComponent(donePath)}`) }}>
              OK
            </Button>
          ) : (
            <>
              <Button variant="subtle" onClick={onClose}>Cancel</Button>
              <Button
                onClick={() => create.mutate(answers)}
                loading={create.isPending}
                disabled={!input.trim() || !repoRoot || !!confirm}
              >
                Create
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}
```

- [ ] **Step 5: Add the button to the home page**

In `ui/src/pages/HomePage.tsx`, add state and a button beside the existing header controls:

```tsx
const [newOpen, setNewOpen] = useState(false)
// ...
<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setNewOpen(true)}>
  New worktree
</Button>
<NewWorktreeModal opened={newOpen} onClose={() => setNewOpen(false)} />
```

- [ ] **Step 6: Run the tests**

Run: `cd ui && npm test && npx tsc -b`
Expected: PASS, and a clean type check.

- [ ] **Step 7: Commit**

```bash
git add ui/src/api/client.ts ui/src/api/types.ts \
  ui/src/components/NewWorktreeModal.tsx ui/src/components/NewWorktreeModal.test.tsx \
  ui/src/pages/HomePage.tsx
git commit --signoff -m "feat(ui): create a worktree from the home page"
```

---

## Task 13: documentation

**Files:**
- Modify: `docs/web-ui-architecture.md`, `.claude/CLAUDE.md`, `docs/ui-feature-roadmap.md`

- [ ] **Step 1: Document the new routes**

In `docs/web-ui-architecture.md`, add to the routes table:

```markdown
| `GET /api/cmux` | cmux availability + a path→workspaces map, matched server-side (symlink-resolving). Polled ~15s by one shared query. |
| `GET /api/cmux-groups` | workspace groups + `cmux.NamedColors`, fetched only when a modal opens |
| `POST /api/cmux/select` | select a workspace, then always `osascript` activate |
| `POST /api/cmux/create` | create a workspace with `cmux.BuildLayout` from current resources |
| `POST /api/worktrees/create` | run `worktreenew`; a pending question is 200 + `confirm`, never an error status |
| `GET /api/repos` | registry repos, newest worktree first |
| `GET /api/repo-dotfiles` | gitignored dotfiles a repo would copy |
```

Add a "cmux integration" section recording: matching happens in Go because it resolves symlinks; `matches` is keyed by the caller's path; every cmux failure degrades to `available:false` and never a 5xx; the card section renders nothing when unavailable.

- [ ] **Step 2: Update the package list**

In `.claude/CLAUDE.md`, under `internal/`:

```markdown
  - `cmux` — cmux CLI wrapper: workspace list/create/select, layout building,
    and `Match` (path→workspace, canonicalizing `Abs → EvalSymlinks → Clean`
    once per side). `cmuxCmd` is a var so tests can stub exec.
  - `resourceurl` — the single URL→(type, id) detector, shared by `cmd`,
    `webui`, and `worktreenew`. Replaces webui's `inferResource`, which
    hand-copied `cmd/root.go`'s PR pattern.
  - `worktreenew` — the shared worktree creation runner (CLI + web), mirroring
    `worktreedel`. Every run is idempotent; confirmations are answered by
    replaying the whole request.
```

Also note the `worktree add` narrowing: it now only creates worktrees; Slack URLs go to `worktree resources add <url>` and paths to `worktree info <path>`.

- [ ] **Step 3: Mark Phase H done**

In `docs/ui-feature-roadmap.md`, change the Phase H heading to `## Phase H — DONE (2026-08-27)`, keeping the pointer to the spec.

- [ ] **Step 4: Full verification**

Run: `make test && cd ui && npm test && npx tsc -b`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add docs/web-ui-architecture.md .claude/CLAUDE.md docs/ui-feature-roadmap.md
git commit --signoff -m "docs: record Phase H cmux integration and worktree creation"
```

---

## Self-Review Notes

**Spec coverage:** H1 → Tasks 1-4. H2 → Tasks 8-12. H2a → Tasks 5-7. Testing section → covered per task. The spec's "reject Slack URLs and paths" appears in both Task 7 (CLI) and Task 11 (HTTP), deliberately: two surfaces, two enforcement points.

**Known plan risks, called out for implementers:**

1. **Task 9's `fallthrough`** in `runPR`'s type switch runs the `PRWorktreeExistingDir` body after `PRWorktreeBranchExists`. That is intentional (an existing branch, once its worktree is created, needs the same sync check), but Go's `fallthrough` in a `switch` on a value is easy to get wrong — verify with a test that a reused branch behind the PR still raises `ConfirmResetToPR`.
2. **Task 10 deletes `finalizeWorktree`**, which today also calls `detectAndSaveJiraIssues`. That call is NOT in the runner. Either port it into `finalize` as part of `StepResources` or keep it in the CLI driver — do not silently drop it. Check `grep -n detectAndSaveJiraIssues cmd/` before deleting anything.
3. **Task 11's `handleRepos`** compares `CreatedAt` strings; that is correct only because they are RFC3339 UTC, which sorts lexically. If any row has a different format the ordering degrades silently rather than erroring.
