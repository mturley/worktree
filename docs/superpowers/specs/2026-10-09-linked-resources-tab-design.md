# Linked Resources tab — design

Date: 2026-10-09
Status: approved in brainstorming, pending written-spec review

## Goal

When a PR, Jira issue, or Slack thread is selected on the worktree detail page,
show the resources it links to — other PRs, Jira issues, Slack threads, and
plain links — in a new **Linked Resources** tab beside the existing Activity
feed (or Thread view), with one-click Follow / Open / Copy-link actions on each.
The aim is to make the web of related work around a resource navigable and
followable from inside worktree, without leaving for GitHub/Jira/Slack.

## Scope

| Resource type | Tabs | Linked Resources sections |
|---|---|---|
| GitHub PR | Activity \| Linked Resources | Linked in description; Referenced by Jira |
| Jira issue | Activity \| Linked Resources | Git Pull Request; Linked in description; Hierarchy; Linked work items |
| Slack thread | Thread \| Linked Resources | Linked in thread |
| Link | (no tabs — unchanged) | — |

Out of scope: polling linked resources, emitting events when links change,
GitHub issues as a resource type, Jira remote links / development panel.

## Verified Jira data model (redhat.atlassian.net, Jira Cloud)

Verified against real issues (RHOAIENG-96640, RHOAIENG-96533, RHAISTRAT-1988,
RHOAIENG-62835, RHOAIENG-99662, CCSTOOLS-1354):

- **Hierarchy is unified on the `parent` field** at every level. The parent
  object carries `key`, `fields.summary`, `fields.status`, and
  `fields.issuetype` including `hierarchyLevel`: Outcome/Initiative 3 →
  Feature 2 → Epic 1 → Story/Task/Bug 0 → Sub-task −1. Parents can be in other
  projects (RHOAIENG epic → RHAISTRAT feature).
- Legacy `customfield_10014` (Epic Link) mirrors `parent` when present;
  `customfield_10018` (Parent Link) is null. Neither is needed.
- **Children** of any issue (including sub-tasks of a Task) come from JQL
  `parent = KEY`. A Task's `subtasks` array lists the same sub-tasks and is
  free with the issue fetch.
- **`issuelinks`**: each entry has `type {name, inward, outward}` and exactly
  one of `inwardIssue` / `outwardIssue` (with key, summary, status, issuetype).
  The label to show is `type.outward` when `outwardIssue` is set, else
  `type.inward` (e.g. "clones", "is related to", "is blocked by").
- **Git Pull Request** (`customfield_10875`, configured as
  `git_pull_request` in `~/.config/watcher/config.yaml` `custom_fields`) is an
  ADF document whose PR URLs appear as `inlineCard` nodes (`attrs.url`); may
  also appear as `link` marks or plain text.
- **Description** (REST v3) is ADF; links appear as `inlineCard` /
  `blockCard` (`attrs.url`), text nodes with a `link` mark (`marks[].attrs.href`),
  or bare URLs in text.

## Architecture

On-demand fetch (not polled), assembled by worktree from new watcher-library
functions, cached briefly in memory.

```
UI select resource ──► GET /api/linked-resources?type=&id=
                          │ (2-min TTL cache, single-flight)
                          ▼
                  internal/linked  (pure assembler, interfaces for sources)
                    ├─ jira:   watcher jira.Client.FetchLinkGraph / SearchSummaries
                    ├─ pr:     watcher github.FetchPRSummaries  + local DB reverse lookup
                    ├─ slack:  watcher slack.Client.Replies + slack.ExtractURLs
                    └─ links:  internal/linkmeta (only when resolve_links=1)
```

### Deviations decided during planning

- Jira's `/search/jql` returns no total, so capped nodes carry `more: { url }` only and render "More on Jira…" (no count).
- The item favicon field is `favicon` (matching `ResourceDTO`), not `favicon_url`.

### Watcher library changes (`~/git/watcher`, work on `main`, release a new minor tag)

**`jira` package**

- `func (c *Client) FetchLinkGraph(key, gitPRFieldID string) (*LinkGraph, error)`
  — one `GET /rest/api/3/issue/{key}?fields=summary,issuetype,status,parent,subtasks,issuelinks,description[,<gitPRFieldID>]`,
  then follows `parent` upward (one GET per hop, `fields=summary,issuetype,status,parent`),
  max 6 hops, stopping on a cycle. Returns:
  ```go
  type IssueSummary struct {
      Key, Summary, Status, StatusCategory, IssueType, IssueTypeIconURL string
      HierarchyLevel int
  }
  type IssueLink struct { Label string; Issue IssueSummary } // Label = outward/inward phrase
  type LinkGraph struct {
      Issue          IssueSummary
      Ancestors      []IssueSummary // nearest parent first
      Subtasks       []IssueSummary
      Links          []IssueLink    // in Jira's order
      DescriptionURLs []string      // from description ADF, in order, deduped
      GitPRURLs      []string       // from gitPRFieldID ADF; nil when field ID empty
  }
  ```
- `func (c *Client) SearchSummaries(jql string, max int) ([]IssueSummary, int /*total*/, error)`
  — one `/rest/api/3/search/jql` call with the same summary fields. Used for
  children, siblings, lazy node expansion, and batch `key in (...)` resolution.
- `func ExtractADFURLs(doc interface{}) []string` — exported, shared by
  description and Git PR field; handles `inlineCard`, `blockCard`, `link`
  marks, and bare `https?://` URLs in text nodes.
- Poller: when `custom_fields.git_pull_request` is configured,
  `buildJiraStateJSON` additionally caches `git_pull_request_urls: []string`
  (via `ExtractADFURLs`). The raw custom-field value continues to be cached
  under its configured name as today.

**`github` package**

- `func FetchPRSummaries(token string, refs []PRRef, apiURL ...string) (map[PRRef]PRSummary, error)`
  — one GraphQL query with one alias per PR (`repository(owner,name){pullRequest(number){...}}`),
  returning `PRSummary{Title, State, IsDraft, Merged, Body, URL}`. Missing/
  inaccessible PRs are absent from the map (not an error).

**`slack` package**

- `func ExtractURLs(m Message) []string` — URLs from rich_text `link`
  elements, mrkdwn `<url|label>` / `<url>` in `Text` (skipping `<@U…>`,
  `<#C…>`, `<!…>`), and attachments' `FromURL` / `TitleLink`. In order,
  deduped. Update `docs/reverse-engineering/slack-web-api.md` if anything
  new is learned about payload shapes.

All new functions get table tests with **synthetic, sanitized** fixtures.

### worktree changes

**Config plumbing.** `internal/webui/poller.go` (and `cmd/watcher.go`) pass
`wconfig.JiraCustomFields()` from `~/.config/watcher/config.yaml` into
`wjira.JiraAuth.CustomFields` (today they pass the auth-file value, which is
empty), so cached Jira state gains `git_pull_request_urls`.

**`internal/linked`** (new) — pure assembler. Sources are interfaces
(`JiraSource`, `PRSource`, `SlackSource`, `LinkResolver`, `JiraStateIndex`)
so it is unit-testable without network. Responsibilities:

- Classify each URL with `resourceurl.InferAny` → `pr` / `jira` / `slack` / `link`.
- Dedupe by (type, id); drop self-references.
- Batch-resolve: Jira keys via one `SearchSummaries("key in (...)")`, PRs via
  one `FetchPRSummaries`, Slack threads via `Replies` (cap 20, concurrency 4),
  plain links via `linkmeta` (cap 20, concurrency 4, only when
  `resolve_links=1`).
- Build sections:
  - **Jira**
    1. `git_pr` "Git Pull Request" — `GitPRURLs`; omitted if empty or field unconfigured.
    2. `description` "Linked in description" — `DescriptionURLs`.
    3. `hierarchy` "Hierarchy" — tree: ancestors (root first) → the current
       issue's parent's children (siblings, via `parent = <parent>`, max 50) →
       the current issue → its children (`parent = KEY`, max 50; merges with
       `Subtasks`). If there is no parent, the tree is the issue plus its
       children. Siblings and ancestors' other children are `has_children:
       unknown` and expand lazily; nodes beyond the 50 cap produce a
       `more: {count, url}` row linking to the JQL search on Jira.
    4. `links` "Linked work items" — `Links` grouped by `Label`, groups in
       first-seen order.
  - **PR**
    1. `description` "Linked in description" — URLs from the PR body
       (markdown links, autolinks, bare URLs; HTML comments stripped).
    2. `referenced_by` "Referenced by Jira" — Jira issues in worktree's own
       `watcher_resource_state` whose cached `git_pull_request_urls` contains
       this PR's URL (normalized: lowercase host, no trailing slash, no
       `/files` etc. suffix). Local DB only — no Jira search. Omitted if empty.
  - **Slack**
    1. `thread` "Linked in thread" — `ExtractURLs` over every message, in
       order of first appearance.

**HTTP API** (`internal/webui/linked_api.go`), behind the existing session
auth / host guard / forgery guard:

- `GET /api/linked-resources?type=pr|jira|slack&id=…[&resolve_links=1][&refresh=1]`
- `GET /api/linked-resources/children?key=JIRA-KEY` → `{items: TreeNode[], more?}`

Response DTO:

```ts
interface LinkedResourcesDTO {
  fetched_at: string
  count: number            // distinct linked items across sections, excl. the current issue
  sections: LinkedSection[]
}
interface LinkedSection {
  kind: "git_pr" | "description" | "hierarchy" | "links" | "referenced_by" | "thread"
  title: string
  error?: string
  items?: LinkedItem[]                         // flat sections
  groups?: { label: string; items: LinkedItem[] }[] // "links"
  tree?: TreeNode[]                            // "hierarchy" (roots)
}
interface LinkedItem {
  type: "pr" | "jira" | "slack" | "link"
  id: string
  url: string
  resolved: boolean       // false → render key/URL + "couldn't load details"
  title?: string
  // pr
  state?: string; is_draft?: boolean; repo?: string; number?: number
  // jira
  status?: string; status_category?: string; issue_type?: string; issue_type_icon_url?: string
  // slack
  channel_name?: string; excerpt?: string
  // link
  domain?: string; favicon_url?: string
}
interface TreeNode extends LinkedItem {
  current?: boolean
  expanded: boolean           // server's initial expansion (ancestors + current branch)
  has_children: boolean | null // null = unknown, expand lazily
  children?: TreeNode[]
  more?: { count: number; url: string }
}
```

**Caching.** In-memory TTL map in the server: 2 minutes, keyed
`(type, id, resolve_links)`, with single-flight. `refresh=1` bypasses and
replaces. `linkmeta` results cached per URL for 30 minutes. Children endpoint
cached 2 minutes per key.

**Errors.** Each section carries an optional `error`; a failing source only
breaks its own section. A service that is not configured hides its sections
(Git PR section also hidden when the field ID is unconfigured). Unresolvable
items (404/no permission) are returned with `resolved: false`. A whole-request
failure → HTTP 5xx → the tab shows an error + Retry and the label drops the count.

## UI

**Tabs.** Mantine `Tabs` replace the "Activity" title in `TimelineBody`
(`ResourceDetailPane.tsx`) and are added between the card and `ThreadView` in
`SlackThreadPane.tsx`. Labels: `Activity` / `Thread` and
`Linked Resources (N)` (no count while loading or on error). Default is always
Activity/Thread; tab state is local and resets when the selected resource
changes (component keyed on resource). The Activity-only controls (Mark N
read, refresh watchers, "Updated 3m ago") render only on the Activity tab; the
Linked tab puts "Fetched 1m ago" + a refresh icon (`refresh=1`) in that slot.
The Slack Thread panel uses `keepMounted` so the composer draft, scroll
position, and unread-divider positioning survive tab switches.

**Data hook.** `useLinkedResources(type, id, {resolveLinks})` (TanStack
Query, key `["linked", type, id, resolveLinks]`). Fired with
`resolveLinks: false` on selection (drives the count); the tab, when first
opened, switches to `resolveLinks: true`, rendering the unresolved data as
placeholder until it arrives.

**Components** (new, under `ui/src/components/linked/`):

- `LinkedResourcesPanel` — sections, empty state ("No linked resources
  found"), per-section error alerts, whole-request error + Retry.
- `LinkedSection` — `Title order={6}` heading + rows / groups / tree.
- `LinkedResourceRow` — one line, wrapping on narrow:
  `[icon] [key] Title… [status] [actions]`. Builds a `ResourceDTO`-shaped
  object so `ResourceStatusIcon` and the key formatting from
  `ResourceTypeLine` are reused (PR: state icon + `owner/repo#123`; Jira:
  proxied issue-type icon + `Story KEY` + status; Slack: message icon +
  `Thread in #channel` + excerpt; link: favicon + title + domain).
  Unresolved items show key/URL + dimmed "couldn't load details".
- `HierarchyTree` — indented (~20px/level) list with chevrons; ancestors and
  the current branch expanded; collapsed nodes lazily load via the children
  endpoint. The current issue has a left accent bar + tint + "this issue"
  marker and no Follow button.
- `LinkedResourceActions` — button group:
  - **Follow** → `AddResourceModal` with `initialUrl` and `defaultRelated`.
    If the (type, id) is already among this worktree's resources (from the
    existing `["resources", path]` query), the button is **View in worktree**,
    which calls `onSelectResource({type, id})`.
  - **Open** → new-tab link. If `useResourceCmuxTab` finds an existing cmux
    tab (PR/Jira only), **Switch to tab** + chevron menu "Open (new tab)",
    sharing the switch logic with `ResourceActions` (extract the existing
    `ExistingTabButtons` switch handler into a shared hook rather than
    copying). Slack rows: "Open in Slack".
  - **Copy link** — `CopyLinkIcon` with the same "Copied!" tooltip.
    (Extract the copy handler from `ResourceActions` into a shared hook.)

**Plumbing.** `ResourceDetailPane` gains `onSelectResource`, passed from
`WorktreeDetailPage`'s `select`, and forwards it to the Linked tab.

## Testing

- **watcher:** table tests for `ExtractADFURLs`, `FetchLinkGraph` (parent
  walk, cycle stop, hop cap, issuelink label normalization, sub-tasks),
  `SearchSummaries`, `FetchPRSummaries` alias batching + missing PRs,
  `slack.ExtractURLs`, and `git_pull_request_urls` in cached state. Synthetic
  fixtures only.
- **worktree `internal/linked`:** per-type section building, URL
  classification, dedupe, self-reference drop, caps + `more`, reverse lookup,
  per-section errors, unresolved items — using fake sources.
- **worktree API:** auth required, cache hit/refresh bypass, children endpoint,
  bad params → 400.
- **UI (vitest):** tab switching and default; count label; Activity-only
  controls hidden on Linked tab; Slack Thread panel stays mounted; Follow ↔
  View in worktree; Open ↔ Switch to tab; copy; tree lazy expansion; section
  error and empty states.
- **Manual end-to-end** against RHOAIENG-96640 (Git PR field, epic → feature
  chain), RHOAIENG-62835 (Task with sub-tasks), RHOAIENG-96533 (Related
  links), a PR with Jira links in its body, and a Slack thread containing PR,
  Jira, and Slack links.

## Docs

- `docs/web-ui-architecture.md`: new "Linked resources" section (routes, DTO,
  caching, components).
- `.claude/CLAUDE.md`: add `internal/linked` to the package list.
- watcher repo docs for the new exported functions; Slack RE doc if anything
  new is learned.
