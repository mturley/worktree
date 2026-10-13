# cmux tab peek — design

Date: 2026-10-13
Status: implemented

## Problem

The worktree detail page's cmux tab lists every tab in the worktree's cmux
workspaces (`PaneDiagram` → `TabRow`), but a row only says a tab's title and,
on hover, its URL. To see what a terminal is doing, or which page a browser tab
is on, you have to switch cmux to it — which moves your view away from the page
you were on.

agent-handler solves the same problem for sessions: hovering its Switch button
(`ui/src/components/PeekPreview.tsx`) opens a hover card showing the session's
terminal, captured with `cmux capture-pane` and refetched every 5s while hovered.

## Goal

Hovering a tab row in the cmux tab opens a hover card that peeks at that tab's
content without focusing it:

- **terminal** tabs — the screen text, refreshed every 5s while the card is open
- **browser** tabs — a screenshot of the page, taken once per hover
- **markdown** tabs — the rendered file, read once per hover

Desktop only. Success: you can tell what any tab holds by hovering it, and
nothing about cmux's focus or your disk changes as a result.

## Feasibility (verified against cmux 0.65.0)

All of the below work on tabs that are not selected in their pane and in
workspaces other than the focused one, and none of them moves cmux focus
(checked with `cmux identify` before and after).

| Type | Command | Result |
|---|---|---|
| terminal | `cmux read-screen --workspace W --surface S --scrollback --lines N` | Plain text (no ANSI). Fast. |
| browser | `cmux browser --surface S screenshot --out <path>` | A real render of the page's current state; ~1.3s, ~200KB PNG at 1280×863. |
| markdown | `cmux read-selection --workspace W --surface S --json` | Returns `file_path` even when `has_selection` is false. |

`read-screen` on a browser or markdown surface fails with `invalid_params:
Surface is not a terminal`; `cmux browser … get` on a markdown surface fails
with `Surface is not a browser`. Neither `tree --json`, `list-pane-surfaces`
nor `surface-health` exposes a markdown surface's file path — its `url` is null
and its title is the bare filename.

**Caveat:** cmux's CLI contract documents `file_path` only for selections. That
`read-selection` returns it with no selection is observed behavior, not a
promise; if it disappears, markdown peek degrades to "unsupported" (below).

## Backend

### Route

`GET /api/cmux/peek?id=<workspace id>&surface=<surface ref>` in
`internal/webui/cmux_tabs.go`, registered beside the other `/api/cmux/*` routes
in `server.go`. Like every `/api/` route it requires a login session.

1. Validate exactly as `handleCmuxFocusTab` does: `validWorkspaceID`,
   `surfaceRefRe`, then `cmuxUnavailable`.
2. Look the tab up server-side: `ops.tree(id)` then `FindTab(surface)`. The
   client's idea of the tab type is never trusted, and a surface not in that
   workspace is a 404. This costs one `cmux tree` per peek; acceptable, since
   the cmux tab already polls `tree` every 5s while open.
3. Dispatch on `TreeTab.Type`.

### Response

```go
type cmuxPeekResponse struct {
	Type        string `json:"type"`                  // the tab's type, from cmux
	Text        string `json:"text,omitempty"`        // terminal
	Image       string `json:"image,omitempty"`       // browser: data:image/png;base64,…
	Markdown    string `json:"markdown,omitempty"`    // markdown
	Path        string `json:"path,omitempty"`        // markdown: the file shown
	Unsupported bool   `json:"unsupported,omitempty"` // nothing to peek at
}
```

A cmux failure (the tab closed mid-request, a screenshot timing out) is
`writeError(w, http.StatusBadGateway, <cmux error text>)`. Not
`respondCmuxAction`: that answers 200 with `ok:false`, the shape for POST
actions, whereas this is a data GET the UI's `fetchJSON` should see fail.

### Per type

New functions on the `cmuxTabOps` seam, with real implementations in
`internal/cmux` (new file `peek.go`):

- **`peekTerminal(id, surface) (string, error)`** —
  `cmux read-screen --workspace id --surface surface --scrollback --lines 200`,
  trailing newlines trimmed.
- **`peekBrowser(id, surface) ([]byte, error)`** — see "Screenshot files".
  The handler base64-encodes the bytes into a `data:image/png` URL.
- **`markdownPath(id, surface) (string, error)`** —
  `cmux read-selection --workspace id --surface surface --json`, returning
  `file_path` (empty when absent). The handler then reads the file itself,
  only if all of these hold, and otherwise answers `unsupported`:
  - the path is absolute and its extension is `.md` or `.markdown`
    (case-insensitive);
  - `os.Stat` says it is a regular file of at most 512 KiB.

  (Revised after the final review: the checks apply to the file actually
  read. Symlinks are resolved first and the extension checked on the
  target; the file is opened once, non-blocking, checked through its own
  descriptor, and read through a 512 KiB + 1 limit.)

  These guards matter because the UI is reachable remotely (phone over HTTPS):
  the path comes from cmux, not the request, but the server should still only
  ever hand back Markdown files of sane size.
- **Any other type** (cmux passes types through unvalidated) →
  `{type, unsupported: true}` without calling cmux.

### Screenshot files

No screenshot outlives the request that took it.

- Screenshots go to a dedicated directory,
  `filepath.Join(os.TempDir(), "worktree-cmux-peek")`, created 0700, each at
  its own uniquely named file (`os.CreateTemp`, `surface-N-*.png`).
- The file is removed once read, or once cmux fails. So the steady state is
  an empty directory.
- Unique names mean overlapping screenshots — two hovers on one tab, or two
  `worktree ui` processes (e.g. `make dev` beside the installed one) sharing
  the directory — never touch each other's file, and no per-surface state
  (locks) is kept.
- `worktree ui` sweeps the directory at startup, removing only files older
  than a minute (`peekStaleAfter`, well past the 10s command timeout): it
  catches what a crash left behind without deleting a screenshot another
  running process is mid-way through.

(Revised after the final review. The first version used a fixed per-surface
path guarded by a per-surface mutex and cleared the whole directory at
startup, which let two processes collide and never pruned its lock map.)

## Frontend

### `TabRow` (`ui/src/components/PaneDiagram.tsx`)

- The existing `Tooltip` (title + URL) is replaced by a Mantine `HoverCard`
  whose header shows the same title and URL, followed by the peek body.
- Open/close is driven by `useHoverMenu` (`ui/src/lib/useHoverMenu.ts`),
  instantiated once in `PaneDiagram` and passed down, exactly as
  `ResourceList` uses it: at most one card open at a time, `openDelay` 400ms,
  `closeDelay` ~300ms, and `disabled` while a tab drag is active — so starting
  a drag closes any open card. `PaneDiagram` already tracks drag start/end for
  `onDragActiveChange`.
- **Desktop only:** when `useMediaQuery("(hover: none)")` matches, no card is
  rendered and the row behaves as today minus the tooltip. (Touch devices did
  not get a useful hover tooltip anyway.)

### `useCmuxPeek` (`ui/src/api/cmuxPeek.ts`)

`useCmuxPeek(workspaceId, tab, enabled)` wraps `useQuery` around a new
`api.cmuxPeek(id, surface)` in `client.ts`:

- `enabled` is the card's `opened`, so nothing is fetched until a card opens.
- **terminal:** `refetchInterval: 5000` while enabled.
- **browser / markdown:** no refetch, `gcTime: 0` and `staleTime: 0`, so every
  open fetches fresh and a closed card drops its image from memory.
- Query key `["cmux-peek", workspaceId, tab.ref]`.

### Card body

- Loading: a small `Loader`. Error: the error text in red, inline.
- **terminal:** a dark monospace `<pre>` (`max-height: 50vh`, scrolls), pinned
  to the bottom on each new capture, like handler's.
- **browser:** `<img>` at the card's width, `alt` = tab title.
- **markdown:** `<NotesMarkdown text={markdown} />` (no `onToggleTask`, so
  checkboxes are inert) in a scrolling box, with `path` in the header.
  Relative image links in the file will not resolve; acceptable for a peek.
- **unsupported:** header only, plus "No preview for this tab".
- Card width ~min(720px, 90vw).

## Testing

Go (`internal/webui/cmux_tabs_test.go`, via the `cmuxTabs` seam):

- terminal, browser and markdown each return the right response shape
- a surface absent from the workspace's tree → 404; invalid id/surface → 400
- unknown tab type → `unsupported` without calling a peek function
- markdown guards: wrong extension, relative path, directory, over 512 KiB,
  missing `file_path` → `unsupported`

Go (`internal/cmux/peek_test.go`, via the `cmuxCmd` stub):

- argument lists for `read-screen`, `browser screenshot` and `read-selection`
- `read-selection` JSON with and without `file_path`
- screenshot cleanup: a stale file at the surface's path is removed before the
  call, and the new file is removed after its bytes are read
- startup sweep empties the directory

UI (vitest):

- `TabRow` does not call `api.cmuxPeek` until its card opens
- each type renders its body (pre / img / markdown / unsupported)
- a drag in progress keeps cards closed

## Docs

- `docs/web-ui-architecture.md`: a "cmux tab peek" section — the route, the
  per-type commands, the screenshot file lifecycle, and the fetch cadence.
- The same doc records the undocumented `read-selection` `file_path` behavior
  and that `read-screen` refuses non-terminal surfaces.

## Out of scope

- Touch/tap-to-peek.
- Refreshing browser or markdown peeks while open.
- Caching screenshots across hovers.
- Peeking other surface types cmux may add (agent sessions, simulators,
  diffs) — they show as unsupported until someone adds a branch for them.
