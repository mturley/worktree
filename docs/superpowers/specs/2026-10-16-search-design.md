# Search — design

Date: 2026-10-16
Status: approved in brainstorming, pending spec review

## Goal

One search box that finds anything worktree has cached — worktrees, cmux
workspaces, notes, resources (keys, titles, custom names/descriptions,
people, statuses, labels) and activity events — without adding a parallel
set of result views to maintain.

## Decision: search is a filter, not a results page

Search **live-filters the page you are on**. There is no `/search` route.

- Home page: the query narrows the worktree list, the Activity feed and the
  Resources tab at once, combined (AND) with the existing source, event
  type, unread-only and archived filters.
- Worktree page: the query narrows that worktree's resource list, its
  activity feed and a selected resource's feed. It never reaches outside
  the worktree.

Rejected: a dedicated results page. It would re-implement worktree cards,
event rows and the resource action group (`AllResourceRow` already has
Details / open-or-switch / copy link), and drift from them. Its one
advantage, cross-type ranking, is covered by the typeahead dropdown.

## Layout

### Home page header (new, home page only)

A full-width header above both columns: logo · search bar · Unread only ·
Follow cmux · Settings cog (far right). These move **out** of the column
toolbars. The left column toolbar keeps the sort control and "New
worktree"; the right column's tab bar keeps its per-tab controls (refresh,
watcher log, archived / Resources sort and count).

Narrow: the header holds logo · search · Settings; Unread only and Follow
cmux wrap onto a second header row. The page's tabs (Worktrees | Activity |
Resources) stay below it.

### Worktree page

Its existing header stays. The search bar sits immediately after the "Open
in editor" button — beside the titles when wide; on narrow, in the toolbar
row right after the editor button.

### While a query is active

- Tabs show a match count badge (home: Activity, Resources; narrow also
  Worktrees). Activity's count is "N+" when more pages exist.
- A pane with no matches says `Nothing matches "<q>"`.
- Matched terms are highlighted (`<mark>`) in titles.
- A dimmed "why it matched" line appears under an item whose match is not
  visible in its title, e.g. `notes: "…switch to the OAuth sidecar…"`,
  `assignee: mturley`, `via RHOAIENG-41210`.

### Search bar behaviour

- `/` focuses it (when focus is not in an input). A ✕ button clears it.
- Esc in the bar clears the query; a second Esc blurs it.
- Esc anywhere on the page also clears an active query, **unless** the Esc
  belongs to something else: a modal, popover, menu or the dropdown is open,
  or focus is in another text input (e.g. the Slack composer, notes
  editor). Those keep their own Esc behaviour and the query stays. One
  document-level `keydown` listener in `SearchBar` implements this; it
  ignores events already `defaultPrevented`.
- The query lives in the URL as `?q=` on both pages, so Back and reload keep
  it. Updates use history replace while typing (not one entry per
  keystroke).

### Typeahead dropdown

Shown while the bar is focused and the query is non-empty. Grouped:
Worktrees (top 3), Resources (top 5), Activity (top 3). ↑/↓ move, Enter or
click navigates; Enter with no row highlighted just closes the dropdown
(the page is already filtered).

Navigation matches the rest of the UI:

- Worktree → `/worktree/<path>`.
- Resource → its first worktree with `?resource=<key>` (home page); select
  it in place (worktree page).
- Event → as `selectResourceInFirstWorktree` does from the global timeline,
  carrying the event in history state so its details modal opens.

On the worktree page the dropdown only offers that worktree's resources and
events (no Worktrees group).

The Activity group is the first 3 events of the page's own (already
search-filtered) feed — no extra request.

The dropdown is a single component (`SearchSuggestions`) mounted by
`SearchBar`; it is an experiment and must be removable by deleting that
component and its mount.

Rank within a group: exact key/ID match, then title starts with a term,
then title contains a term, then any other field. Ties keep the page's
current order (events: newest first).

## Matching rules

- Case-insensitive. Whitespace splits the query into terms. **Every term
  must match** somewhere on the item; different terms may match different
  fields. No phrases or operators in v1.
- Leading/trailing whitespace is ignored; an all-whitespace query is no
  query.

| Item | Fields (priority order for the "why" line) |
|---|---|
| Worktree | branch, repo, worktree name (last path segment), cmux workspace name(s), notes, **then any of its resources' fields** (shown as `via <key>`) |
| Resource | key/ID (PR `owner/repo#N`, `#N`; Jira key; link URL; Slack channel), title, custom name, custom description, assignee, author, reporter, status, labels, link description |

Notes on fields: the cmux response carries only workspace titles, not
descriptions; with "sync to cmux" on the description mirrors the notes,
which are searched anyway. `reporter` (a name) is in the cached Jira state
but not on `resourceDTO` today; it is added as `reporter` (omitempty).
| Event | title, body, author, then its resource's ID, custom name, cached title (shown as `via <key>`) |

Worktrees do **not** match through their events (one comment would pull in
most worktrees). Resources do **not** match through their events. Matching
worktrees through their resources is kept for now and will be reviewed in
use; it must be a single switch to turn off (one call in `matchWorktree`).

Worktree and resource matching run in the browser over data already loaded
(`/api/worktrees`, `/api/all-resources`, the worktree's resources). Event
matching runs on the server, because only the first page of events is
loaded.

## Backend

### `q` on the timeline endpoints

`GET /api/timeline` and `GET /api/worktree-timeline` accept `q`. The
handler parses it into terms with the same rules as the frontend and
appends, per term, one parenthesised OR group ANDed to the existing WHERE:

```
( e.title LIKE ? ESCAPE '\' OR e.body LIKE ? ESCAPE '\' OR e.author LIKE ? ESCAPE '\'
  OR er.resource_id LIKE ? ESCAPE '\' OR m.custom_name LIKE ? ESCAPE '\'
  OR json_extract(rs.state_json, '$.title') LIKE ? ESCAPE '\' )
```

joining `watcher_resource_meta m` and `watcher_resource_state rs` on the
event's resource (LEFT JOIN). Terms are escaped for `%`, `_` and `\` and
wrapped in `%…%`. SQLite `LIKE` is ASCII case-insensitive, which is
acceptable for v1. The parsing and SQL fragment builder live in
`internal/webui/search.go`, with the escaping helper, so both handlers share
them. `q` combines with `archived`, `unread_only`, `resource_types`,
`event_types`, `before` and `limit` unchanged; pagination still works.

No index in v1. Current scale is ~6k events / ~44 MB of bodies. If a query
is measurably slow (target: < 150 ms for the first page on that data), a
follow-up adds an FTS5 index in worktree's own schema; that is out of scope
here.

### `match` on `TimelineEvent`

When `q` is set, each returned event carries
`match: {field, snippet}` — the highest-priority field (in the order above)
containing any term, and a snippet of about 60 runes around the hit,
cut at word boundaries with `…` marking cuts (same convention as linked
resources' context). Computed in Go after the query, not in SQL. Absent
when `q` is empty.

### Notes for search

`worktreeSummary.notes` is only sent when "Show notes on home page" is on,
so it can't be searched. Add `notes_search string` (omitempty): the raw
note text whenever it is non-blank, regardless of that setting. `notes`
keeps its current meaning and rendering. Worktree-page search uses the
notes it already loads.

## Frontend

- `lib/search.ts` (pure): `parseQuery(q) → string[]`;
  `matchWorktree(w, cmuxWorkspaces, terms)`, `matchResource(r, terms)` →
  `null | {field, snippet, viaKey?}`; `rankSuggestion`; `snippet` (same
  60-rune word-boundary rule as the server).
- `hooks/useSearchQuery`: `?q=` read/write (replace while typing), returns
  `{q, setQ, terms, debouncedQ}`; `debouncedQ` (250 ms) feeds the timeline
  hooks so the server is asked once typing pauses; browser-side filtering
  uses `terms` immediately.
- `components/search/SearchBar` (input, `/` and Esc handling, ✕),
  `SearchSuggestions` (dropdown), `MatchWhy` (dimmed line),
  `Highlight` (marks terms in a string).
- `components/HomeHeader`: the new home header.
- `useGlobalTimeline` / worktree timeline hooks gain an optional `q` in
  their params and query key.
- Home page: worktree list filter applies `matchWorktree` after the
  existing unread/source filters; Resources tab applies `matchResource`
  inside `lib/resourceListFilter.ts`'s pipeline. Worktree page: the
  resource list applies `matchResource`.
- Highlighting reads the active terms from a `SearchContext` provided by
  each page, so `ResourceTitle`, `WorktreeCard`'s name and focus lines and
  `EventRow`'s title wrap their text in `SearchHighlight` with no prop
  plumbing. With no terms (or no provider) rendering is unchanged.
- "Why" lines: `WorktreeCard` and `AllResourceRow` compute their own match
  from the context (pure `lib/search.ts` calls); `EventRow` renders the
  server's `match`.

## Error handling and edge cases

- Worktree page: the selected resource stays in the list even when it does
  not match, so typing never deselects it (the page's stale-selection
  effect would otherwise clear it).

- Timeline request with `q` fails → the feed shows its existing error
  state; browser-side panes still filter.
- cmux unavailable or disabled → worktrees match without workspace fields.
- Resources never polled (no cached state) → match on key/ID and custom
  name/description only.
- A query that matches a resource followed by several worktrees → the
  resource appears once on the Resources tab; every following worktree
  matches via it.
- Clearing the query restores the unfiltered page exactly (no lingering
  counts, highlights or scroll jumps beyond what a filter change already
  does).
- User switches worktree pages with `?q=` set → the query does not carry
  over (it is part of that page's URL only).

## Testing

- Go: table tests for `search.go` (term parsing, escaping `%`/`_`/`\`, the
  SQL fragment); handler tests for `q` on both endpoints — multi-term AND
  across fields, resource-ID and custom-name and cached-title joins,
  combination with `archived`/`unread_only`/type filters, pagination with
  `before`, `match` field and snippet; `notes_search` present regardless of
  the home-notes setting.
- Vitest: `lib/search.ts` (field priority, `via` matches, multi-field AND,
  snippets, empty query); `useSearchQuery` (URL sync, debounce);
  `SearchSuggestions` (grouping, caps, keyboard nav, navigation targets on
  both pages); `HomeHeader` (controls moved, narrow wrap); home and worktree
  pages filter and show counts / empty text.
- Docs: a "Search" section in `docs/web-ui-architecture.md` (routes, `q`,
  `match`, `notes_search`, matching rules, where the dropdown lives).

## Out of scope (v1)

FTS5 index; ranked full results; query syntax (phrases, `is:`, `type:`);
searching Slack message text not already stored as events; searching from
the CLI.
