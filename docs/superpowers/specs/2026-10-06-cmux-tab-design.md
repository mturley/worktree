# cmux tab in the worktree details card — design

Date: 2026-10-06
Branch: `cmux-tab`
Mockup: `.superpowers/brainstorm/33712-1791319334/content/cmux-tab-diagram-v6.html` (local, untracked)

## Goal

When `worktree ui` runs inside cmux, the worktree detail page's details card
(`WorktreeDetailCard`) gets a third tab, **cmux**, after Notes and
Environment. For each cmux workspace matching the worktree it shows, and lets
you act on:

- the workspace **title** (editable) and **colour** (editable);
- a **mini layout diagram** of the workspace's split panes, drawn in their
  real arrangement, with each pane's tabs listed inside it;
- per tab: click to **switch cmux to it**, ✕ to **close it**.

Outside cmux the card looks exactly as it does today (Notes, Environment).

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Pane presentation | Mini layout diagram, tabs inline (not a flat list or split tree; no hover cards) |
| Tabs shown per pane | Up to 10 |
| Which 10 | Start at the top; only if the selected tab is past the 10th, centre the window on it (clamped to the end) |
| Overflow | "Show N more tabs" link in place of the hidden group, above and/or below, so cmux's order is kept; expands in place; "Show fewer" collapses |
| Expansion lifetime | Resets whenever the cmux panel remounts (switching card tabs, navigating) |
| Tab position | Notes, Environment, **cmux** |
| No matching workspace | Tab still shows: "No cmux workspace" + the existing Create button |
| Several matching workspaces | One header + diagram per workspace, stacked |
| Pinned tabs | Not shown: cmux 0.64 exposes no per-tab pinned state (checked `tree`, `list-pane-surfaces`, `rpc surface.list`/`pane.surfaces`, `docs api`) |
| Close confirmation | Terminal tabs confirm first; browser tabs close immediately |
| Stale refs (TOCTOU) | Close sends the tab's type + title; server re-reads `tree` and refuses as `stale` unless ref, type and glyph-normalised title still match; UI refetches and the user retries. Switch is unguarded |
| Freshness | Poll every 5s while the panel is mounted and the page visible; refetch after every action |
| URL display | Tooltip (Mantine `Tooltip`, not the native `title`, which cmux's browser does not show) with title + URL |

## cmux facts this relies on

Verified against cmux 0.64.25:

- `cmux tree --json --workspace <id>` returns
  `windows[].workspaces[]` with `id`, `layout` (recursive:
  `{pane: {ref}}` or `{direction: "horizontal"|"vertical", split: <0..1>,
  children: [a, b]}`) and `panes[]` (`ref`, `focused`, `surfaces[]` with
  `ref`, `title`, `type` (`terminal`/`browser`), `url` (null for
  terminals), `selected_in_pane`).
- `cmux focus-panel --panel <surface-ref> --workspace <id>` focuses a tab
  (prints `OK surface:N workspace:N`).
- `cmux close-surface --surface <ref> --workspace <id>` closes a tab.
- `cmux workspace-action --workspace <id> --action rename --title <t>` /
  `--action clear-name` (back to cmux's automatic title).
- `cmux workspace-action --workspace <id> --action set-color --color <name|#hex>`
  / `--action clear-color`.
- Workspace commands accept the UUID `id`. Writes use it rather than
  `workspace:N`, which `internal/cmux` already documents as the less stable
  handle.

Live-tested with Mike on 2026-10-06 (workspace "Breakdown: Runtime Library
(1988)", 2 panes, 19 tabs):

- **Switch:** `workspace select <uuid>` → `focus-panel --panel surface:N
  --workspace <uuid>` → osascript activate selected the right workspace,
  pane and tab; `identify` and `tree`'s `active` both confirmed it.
- **Close:** `close-surface --surface surface:213 --workspace <uuid>` closed
  exactly that tab (the other 18 untouched), but printed
  `OK surface:224 workspace:8` — the echoed ref is NOT the closed one. Never
  parse refs out of `OK …` output; confirm with a fresh `tree`.
- **Tab types are open-ended:** besides `terminal` and `browser` there is
  `markdown` (cmux's markdown viewer). The UI needs an icon per known type
  and a generic fallback.
- **Browser tabs can have `url: null`** (seen on not-yet-loaded tabs), so
  "no URL" is not terminal-only.
- `tree` surfaces have no UUID, only `ref`; tab writes use the ref, scoped by
  the workspace UUID.

## Backend

### `internal/cmux`

New types and functions (all through the `cmuxCmd` seam, so tests stub the
binary):

```go
type LayoutNode struct {
    Pane      string        // pane ref when this is a leaf
    Direction string        // "horizontal" | "vertical" when a split
    Split     float64       // first child's share, 0..1
    Children  []LayoutNode  // exactly two when a split
}

type TreeTab struct {
    Ref      string // surface:N
    Title    string
    Type     string // "terminal" | "browser" | "markdown" | others, passed through
    URL      string // empty when cmux reports null (terminals, unloaded browser tabs)
    Selected bool   // selected_in_pane
}

type TreePane struct {
    Ref     string
    Focused bool
    Tabs    []TreeTab
}

type WorkspaceTree struct {
    Layout LayoutNode
    Panes  []TreePane
}

func Tree(workspaceID string) (*WorkspaceTree, error)
func FocusTab(workspaceID, surfaceRef string) error   // focus-panel
func CloseTab(workspaceID, surfaceRef string) error   // close-surface (unguarded; the handler guards)
func ClearWorkspaceName(workspaceID string) error     // workspace-action clear-name
func ClearWorkspaceColor(workspaceID string) error    // workspace-action clear-color
```

`RenameWorkspace` and `SetWorkspaceColor` already exist and are reused.

`Tree` parses defensively: a layout node that is neither a pane nor a
two-child split, or a split ratio outside 0..1, is an error rather than a
guess; unknown surface types pass through as-is. The workspace is looked up
in `windows[].workspaces[]` by `id`; not found is an error.

### `internal/webui` routes

All POSTs reply `{ok, error?}` (the existing `cmuxActionResponse`), with HTTP
200 for cmux-level failures and 400 for malformed requests, matching
`/api/cmux/select`. They go through the existing route table, so the session
and request-forgery guards apply unchanged.

| Method | Path | Input | Behaviour |
|---|---|---|---|
| GET | `/api/cmux/tree` | `path` (required) | `{available, workspaces: [{id, ref, title, color, selected, layout, panes}]}`. Matches the path with `cmux.Match` exactly like `/api/cmux`; one `cmux tree` per matched workspace. Not available / list failure → `{available: false}`. A per-workspace tree failure drops that workspace's `layout`/`panes` and sets `error` on it, rather than failing the request. |
| POST | `/api/cmux/rename` | `{id, title}` | trimmed `title` empty → `clear-name`, else `rename` |
| POST | `/api/cmux/color` | `{id, color}` | empty → `clear-color`; else must be a `cmux.NamedColors` name or `#RRGGBB`, else 400; `set-color` |
| POST | `/api/cmux/focus-tab` | `{id, surface}` | select workspace → `focus-panel` → `cmux.Activate()` (activation failure is not an action failure, as in select) |
| POST | `/api/cmux/close-tab` | `{id, surface, type, title}` | re-reads `cmux tree`; closes only if the ref still exists with the same type and a matching title (see "Close guard"), else `{ok: false, stale: true, error}` |

`surface` must match `^surface:\d+$` (400 otherwise), so a request can never
smuggle another argument shape into the exec.

### Close guard (TOCTOU)

Tab refs come from a poll up to 5s old, and closing is destructive, so a
close carries what the user saw — the tab's `type` and `title` — and the
server re-checks it immediately before acting:

1. `cmux.Tree(id)`; find the surface by `ref` across all panes.
2. Not found → stale. Different `type` → stale.
3. Compare titles after `normalizeTitle`: strip leading runes that are
   `unicode.IsSymbol` or `unicode.IsSpace`. That removes cmux's animated
   agent-status glyphs (`◐ cmux-stuff` ≡ `◑ cmux-stuff`) and emoji prefixes
   (`🚧`), but keeps brackets/parentheses (`(5) worktree`,
   `[RHAISTRAT-1988] …`), which are punctuation, not symbols. Mismatch →
   stale.
4. Match → `close-surface`.

Stale replies `{ok: false, stale: true, error: "That tab changed since the
list loaded. Check it and try again."}` (HTTP 200, like other cmux-level
failures). The UI shows the error inline and refetches the tree at once, so
the retry acts on fresh data. A residual race between step 1 and step 4
remains (milliseconds rather than up to 5s); cmux has no compare-and-close
primitive to close it fully. A browser title that legitimately changes (an
unread count `(5)` → `(6)`) is also reported stale; that costs one retry.

Switching tabs is not guarded: landing on the wrong tab is harmless and
undone by clicking again.

JSON shape of `layout` mirrors `LayoutNode` in snake_case:
`{pane}` or `{direction, split, children}`. `panes[]`:
`{ref, focused, tabs: [{ref, title, type, url?, selected}]}`.

## Frontend

### Card tabs (`WorktreeDetailCard`)

- Order: Notes (default), Environment (when it has variables), cmux (when
  `useCmux().data?.available`).
- If the selected tab disappears (env emptied, cmux gone), fall back to Notes
  — the existing `activeTab` fallback generalises.
- Only the cmux `Tabs.Panel` gets `keepMounted={false}`, so it unmounts when
  hidden: that is what resets expanded groups and stops its polling. Notes
  and Environment keep the default, so their existing tests are unaffected.

### `api/cmuxTree.ts`

`useCmuxTree(path, enabled)` — React Query, key `["cmux-tree", path]`,
`refetchInterval: 5_000`, `refetchIntervalInBackground: false`. Mutations for
rename / color / focus-tab / close-tab invalidate `["cmux-tree", path]` and
`["cmux"]` (so the page header's workspace title and colour update too).

### `components/CmuxPanel.tsx`

- No workspaces → dimmed "No cmux workspace" + the existing
  `CreateWorkspaceModal` button (same as `CmuxWorkspaceSection`).
- Per workspace: `CmuxWorkspaceHeader`-style row:
  - colour dot → `Popover` with the `cmux-groups` named swatches (fetched
    lazily, as the create modal does), a `#RRGGBB` input, and Clear;
  - title + ✎ → inline `TextInput`; Enter saves, Esc cancels; empty saves
    `clear-name`.
- Then `<PaneDiagram>`.
- A close sends the row's `type` and `title` along with its ref; a `stale`
  reply shows its message and refetches the tree immediately.
- A failed action shows a small red line under the workspace header until the
  next successful action; no optimistic updates (the 5s poll + refetch is the
  truth).

### `components/PaneDiagram.tsx`

- Recursive render of `layout`: a split is a flex row (`horizontal`) or
  column (`vertical`); children get `flex-grow` = `split` / `1 - split`.
  Height is natural (content-driven), not the real ratio.
- Leaf pane: bordered box, faint blue outline when `focused`.
- Tabs via `windowTabs(tabs, 10)`; hidden groups render as
  `Show N more tabs` buttons in place; expanded groups render their tabs plus
  `Show fewer` where the link was (top of a "before" group, bottom of an
  "after" group). Expansion state: a `Set<"pane:side">` in the panel's
  component state.
- Tab row: kind icon (terminal / browser / markdown, generic icon for any
  other type), title (ellipsis), selected tab bold; Mantine `Tooltip` (open
  delay ~400ms) with title, plus URL only when present (browser tabs may
  have none); click →
  focus-tab; hover reveals ✕ → close-tab, terminals via a small confirm
  `Popover` ("Close terminal "make dev"?").

### `lib/windowTabs.ts`

Pure function:

```ts
windowTabs<T extends { selected: boolean }>(tabs: T[], visible: number):
  { before: T[]; shown: T[]; after: T[] }
```

- `tabs.length <= visible` → everything shown.
- Selected index `< visible` (or none selected) → `shown = tabs[0..visible)`.
- Otherwise `start = min(sel - floor((visible-1)/2), len - visible)`.

## Docs

- `docs/web-ui-architecture.md`: add the five routes to the routes table and
  a short "cmux tab" section (data flow, polling, why UUIDs, why no pinned
  state).

## Testing

- **Go:** `cmux.Tree` parsing against a sanitized fixture (synthetic titles,
  no real URLs) including a nested split, a terminal (`url: null`), a
  browser tab with `url: null`, a `markdown` tab and a malformed layout; command construction for the new write functions via the
  `cmuxCmd` stub; handlers: availability fallback, per-workspace error,
  input validation (bad `surface`, bad colour, missing `id`), and dispatch
  of empty title/colour to the clear actions. Close guard: closes on exact
  match and on glyph-only difference (`◐ x` vs `◑ x`); refuses as stale (and
  never calls `close-surface`) on missing ref, type change, real title change
  and `(5)`→`(6)`; `normalizeTitle` table test.
- **Vitest:** `windowTabs` table tests (≤10, selected early, selected past
  10, selected last, none selected); `PaneDiagram` expand / Show fewer;
  panel remount collapses; terminal close confirms, browser close does not;
  rename (Enter/Esc/empty) and colour calls; the cmux card tab appears only
  when cmux is available and sits after Environment.
- **Manual (with Mike's OK, since it changes his cmux state):** switch to a
  tab in another pane, close a throwaway browser tab, rename and recolour a
  scratch workspace.

## Out of scope

- Pinned-tab display (blocked on cmux).
- Creating panes/tabs, moving tabs, or resizing splits from the UI.
- Any change to the home page's `CmuxWorkspaceSection` or the page header.
