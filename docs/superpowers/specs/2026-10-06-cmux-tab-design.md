# cmux tab in the worktree details card — design

Date: 2026-10-06
Branch: `cmux-tab`
Mockup: `.superpowers/brainstorm/33712-1791319334/content/cmux-tab-diagram-v6.html` (local, untracked)

Tabs can also be dragged to reorder them within a pane, or dropped into
another pane in the diagram to move them there.

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
| Drag and drop | Tabs drag to reorder within a pane and drop into another pane to move there; guarded like close (dragged tab AND anchor); optimistic in the UI. Moving selects the moved tab and focuses its pane (cmux does this regardless of `--focus false`); accepted |
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

Reorder/move, probed in a throwaway workspace (created with `--focus false`,
closed afterwards):

- `reorder-surface --surface X --workspace W --index n`: within X's pane; `n`
  is X's FINAL index (moving index 0 to `--index 3` lands it at 3); an index
  past the end clamps to last.
- `reorder-surface … --before Y` / `--after Y`: works within the pane; an
  anchor in another pane fails with
  `invalid_params: Anchor surface must be in the same pane`.
- `move-surface --surface X --workspace W --pane P --before Y` (or
  `--after Y`, `--index n`): moves X into pane P at that spot. With only
  `--after Y` (no `--pane`) it lands in Y's pane.
- Moving a pane's last tab out closes the pane and collapses the layout (a
  horizontal split became a single leaf).
- Both commands select the moved tab and focus its pane within the
  workspace, even with `--focus false`. The active workspace (what Mike is
  looking at) does not change.
- Unknown surface → `invalid_params: Missing or invalid surface_id`, no
  change. Refs survive reorders and moves.
- **Reads can lag writes.** A `tree` immediately after a move still showed
  the old layout once (the next read was right), and `workspace list`
  briefly showed a just-closed workspace. The UI must not let an immediate
  re-read undo an optimistic move.

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

// TabPosition says where a reordered/moved tab lands: before or after an
// anchor tab, or (both empty) at the end of the target pane.
type TabPosition struct {
    Before string // surface ref
    After  string // surface ref
}

// ReorderTab: reorder-surface within the tab's own pane
// (--before/--after, or --index 9999 for the end — cmux clamps).
func ReorderTab(workspaceID, surfaceRef string, pos TabPosition) error
// MoveTab: move-surface --pane into another pane, same positioning.
func MoveTab(workspaceID, surfaceRef, paneRef string, pos TabPosition) error
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

| POST | `/api/cmux/move-tab` | `{id, surface, type, title, pane, anchor?: {surface, type, title, position: "before"\|"after"}}` | re-reads `cmux tree`, guards the dragged tab and the anchor (see "Move"), then `ReorderTab` (same pane) or `MoveTab` (other pane) |

`surface` (and `anchor.surface`) must match `^surface:\d+$`, and `pane` must
match `^pane:\d+$` (400 otherwise), so a request can never smuggle another
argument shape into the exec.

### Move

A drop names the dragged tab, the target `pane`, and optionally an anchor:
the visible tab it was dropped before/after. No anchor means "end of the
target pane" (dropped on empty pane space, or on an empty pane). Anchors, not
indexes, because an index computed from a poll up to 5s old points at
whatever has since moved into that slot; an anchor is verified.

1. `cmux.Tree(id)`. Guard the dragged tab exactly like close (ref exists,
   same type, glyph-normalised title). With an anchor, guard it the same
   way, and the target pane is the anchor's pane (must equal `pane`, else
   stale). Without an anchor, `pane` must exist, else stale. Anchor equal to
   the dragged tab → 400.
2. Target pane is the dragged tab's own pane → `ReorderTab`, else
   `MoveTab(… pane …)`.
3. Stale → `{ok: false, stale: true, error}`, nothing moved.

cmux then selects the moved tab and focuses its pane; that is accepted
(documented, and mirrored by the optimistic update below).

### Close guard (TOCTOU)

Tab refs come from a poll up to 5s old, and closing is destructive, so a
close carries what the user saw — the tab's `type` and `title` — and the
server re-checks it immediately before acting:

1. `cmux.Tree(id)`; find the surface by `ref` across all panes.
2. Not found → stale. Different `type` → stale.
3. Compare titles after `normalizeTitle`: strip leading AND trailing runes
   that are `unicode.IsSymbol`, `unicode.IsSpace`, or in `unicode.Mn`/`Cf`
   (variation selectors, ZWJ). That removes cmux's animated agent-status
   glyphs (`◐ cmux-stuff` ≡ `◑ cmux-stuff`), emoji status prefixes, and
   trailing statuses like pi's (`pi - x:🚧` ≡ `pi - x:✅`), but keeps
   brackets/parentheses (`(5) worktree`, `[RHAISTRAT-1988] …`), which are
   punctuation, not symbols. Mismatch → stale.
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
- `Tabs` gets `keepMounted={false}` and the Notes and Environment panels opt
  back in with `keepMounted` (Mantine's per-panel prop can only force a panel
  to STAY mounted), so only the cmux panel unmounts when hidden: that is what
  resets expanded groups and stops its polling. Notes and Environment behave
  as before, so their existing tests are unaffected.

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

### Drag and drop (`PaneDiagram`)

- `@dnd-kit` (already a dependency, used for resource card ordering): one
  `DndContext` per workspace diagram, one `SortableContext` per pane over its
  VISIBLE tab rows, and each pane box is also a droppable (id `pane:N`) for
  drops on empty space. Hidden groups are not drop targets; expand them
  first. Dragging starts after a small pointer distance so a click still
  switches tabs.
- On drop, `dropTarget()` (pure, in `lib/cmuxMove.ts`) computes
  `{pane, anchor?}`, following dnd-kit sortable's own semantics so the
  result matches the preview the user saw:
  - over a tab in the SAME pane: dragged from above it → `after` it; from
    below → `before` it (arrayMove);
  - over a tab in ANOTHER pane: `before` it (takes its slot);
  - over a pane box (empty space, or an empty pane) → no anchor (end).
  Dropping on itself, or a same-pane drop that leaves the order unchanged,
  sends nothing.
- **Optimistic:** `lib/cmuxMove.ts` `applyMove(workspace, move)` (pure)
  returns the workspace with the tab moved, selected in its new pane, that
  pane focused, and a pane left empty removed with its split collapsed —
  matching what cmux does. The panel writes it into the `["cmux-tree",
  path]` cache (after `cancelQueries`), sends the request, and:
  - on `ok`: waits a ~1s settle delay, then invalidates (so the lagging
    read cmux was seen to give cannot snap the tab back);
  - on failure or `stale`: invalidates at once (rollback to cmux's truth)
    and shows the error.
  The 5s poll is paused (`enabled: false`) while a move is in flight.

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
  and `(5)`→`(6)`; `normalizeTitle` table test. Move: same-pane anchor →
  `reorder-surface` args; other-pane anchor → `move-surface --pane` args; no
  anchor → `--index 9999`; stale on dragged-tab mismatch, anchor mismatch,
  anchor in a different pane than `pane`, unknown `pane`; 400 on anchor ==
  dragged, bad `pane`/`position`.
- **Vitest (moves):** `applyMove` table tests (reorder within a pane, move to
  another pane before/after an anchor, move to end, moving a pane's last tab
  collapses its split, moved tab becomes selected and its pane focused);
  drop computation for before/after/pane; optimistic cache write, settle
  delay before refetch on success, immediate rollback refetch on `stale`.
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
- Creating panes/tabs, splitting a pane by dropping on its edge, moving tabs
  to another workspace, or resizing splits from the UI.
- Dropping into a collapsed "Show N more tabs" range.
- Any change to the home page's `CmuxWorkspaceSection` or the page header.
