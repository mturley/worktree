# CLI search and Slack thread reading — design

## Intent

Mike asks agents about his work in loose terms: "find the Slack thread that
discussed RHAISTRAT-304", "what's the thread from Andrew yesterday", "which PR
was the one about deployment status events". Today an agent can only answer
by listing everything (`resources list --all`, `activity --since …`) and
reading it, which is slow and fills its context.

The web UI's search bar already answers these questions from the local
database. This work gives the CLI, and so the `worktree` agent skill, the same
search, plus a way to read one Slack thread in full from the cache.

The reason for the shape: **save the agent's context and stay fast.** Search
returns short hits, never whole message bodies. A Slack thread is listed as a
short summary first; its messages are read only after the user confirms. Nothing
contacts Slack, GitHub or Jira: the cache now holds every message of a followed
thread (watcher v0.31.0+: `slack_thread_root` for the first message,
`slack_reply` for the rest, full text, backfilled on follow), so reading from it
is both complete and faster than a live fetch.

## Goals

- `worktree search <query>` returns what the search bar would: worktrees,
  resources, tasks and activity across all worktrees; resources and activity
  when scoped to one worktree. Same matching rules as the UI.
- `worktree slack thread <ref>` identifies one followed thread (by URL,
  `slack:<id>`, or its custom name / cached title) and prints a summary;
  `--messages` adds every message in order.
- The `worktree` skill uses them: a loose question becomes a few searches, the
  agent lists candidate threads (or PRs, issues, worktrees) with their summary,
  asks which one was meant, and reads a thread's messages only when asked.
- Questions like these (the acceptance examples) are answerable:
  - Slack: "Find the Slack thread that discussed RHAISTRAT-304", "What's the
    thread from Andrew yesterday?", "Read me the InferencePool RBAC thread",
    "Did anyone answer my question about aggregate roles?"
  - GitHub: "Which PR was the one about deployment status events?", "What did
    Emily say in review on the model registry PR?", "Find the PR where CI kept
    failing on the serving tests"
  - Jira: "What's the Jira for the InferencePool RBAC bug?", "Did anyone update
    RHOAIENG-82482 this week?"
  - Across: "Everything about RHAISTRAT-304", "What did Andrew say anywhere
    today?", "Which worktree am I using for the llmisvc work?", "Find my task
    about updating the docs"

## Non-goals

- No live calls to Slack, GitHub or Jira from either command.
- No new matching features (phrases, operators, fuzzy matching, FTS). The UI
  has none; the skill compensates by having the agent try a few term variations.
- The web UI's matching stays client-side in `ui/src/lib/search.ts`; the only
  UI change is the dropdown's "Include archived" toggle (below).
- The home page's Resources tab and the task panel's own archived toggle are
  unchanged.
- Not a replacement for `attention` ("what needs me") or `activity --since`
  (topic-less "what happened").
- Resources not followed by any worktree (now or, with `--archived`, before)
  are out of reach; the skill says so and offers to follow one.

## Anti-goals

- Reading a thread's messages without the user's go-ahead. The skill must list
  and ask first, even when only one thread matched.
- Search output that carries full message bodies. A loose query must stay small.
- Any write: neither command marks anything read, and neither is a "write" for
  the skill.
- Go and TypeScript matching drifting apart, so CLI and UI answer the same
  query differently.

## Approaches

- **A. A new `worktree search` command plus `worktree slack thread` (chosen).**
  One call mirrors the search bar's grouped answer; a second shows one thread.
  Easiest for an agent to reason about: it doesn't have to pick and merge
  commands.
- B. `--search` on the existing commands (`list`, `resources list --all`,
  `activity`, `tasks list`) plus a full-body flag on `activity --resource`.
  Fewer commands, but every question takes three or four calls the agent has
  to merge, and the output looks nothing like the UI's. Rejected.
- C. Slack only (`slack find` / `slack read`) now, general search later.
  Smaller, but drops the general search Mike asked for and would write the
  matching twice. Rejected.

## Design

### Shared server methods (`internal/webui`)

Per the read-command rule, both commands are thin wrappers over `Server`
methods that the CLI's `headlessServer` calls; no read logic lives in `cmd/`.

- **Go port of the UI's matching.** `matchWorktree`, `matchResource`,
  `matchTask`, `rankText`, `rankResource`, `rankTask` and the resource field
  list (`resourceFields`) from `ui/src/lib/search.ts` become Go, next to the
  existing `matchEvent`/`snippet`/`parseSearchTerms` in `search.go`. Same field
  order, same "why" (`field`, `snippet`, and the `via` key for a worktree that
  matched through a resource), same `MATCH_WORKTREES_VIA_RESOURCES` behavior.
- **Parity fixture.** One JSON file of cases (item + query → expected match
  field/snippet or no match, and rank) is run by a Go test and a vitest test, so
  the two implementations cannot drift silently. Each side's code comments name
  its twin, as `slackplain.go` and `mrkdwnPlain.ts` already do.
- **`Server.Search(SearchQuery) (SearchResult, error)`.** Inputs: query
  string, optional worktree path, sources, since, unread-only, archived,
  humans-only, event types, and per-group limits. It:
  - parses terms with `parseSearchTerms` (an empty query is an error: search
    needs at least one term);
  - activity: `Server.Timeline` with the terms and filters (so titles are
    rebuilt by `slackEventTitle` and `match` is filled exactly as the UI's
    feeds get them). The search/archived/humans-only fields of `TimelineQuery`
    are unexported today and get exported (or set through a constructor);
  - resources: `AllResources` (global) or `WorktreeResources` (scoped),
    filtered by `matchResource`, ranked by `rankResource`, honoring the
    source filter and `--unread`. With `--archived` (global only), also
    every resource that only tombstoned `worktree:` subscriptions point to
    (followed before, by no worktree now; `task:` holds don't count), from a
    new loader returning the same `AllResource` shape with `archived: true`
    and the worktrees that last followed it. `slack thread` name resolution
    uses the same loader;
  - worktrees (global only): `WorktreeSummaries` + each worktree's resources
    + cmux workspace titles when cmux is reachable (`cmux.IsAvailable`, read
    only; without cmux the workspace field is just absent);
  - tasks (global only): the tasks the home page's task panel would list,
    `matchTask`, ranked open before done as `buildSuggestions` does.
  The event part already exists; the rest mirrors `buildSuggestions` in
  `ui/src/components/search/suggestions.ts`, with larger limits.
- **`Server.SlackThread(ref) (SlackThreadSummary, error)`** and
  **`Server.SlackThreadMessages(id) ([]SlackMessage, error)`**:
  - Summary: channel name, custom name, custom description, cached title,
    URL, author and start time (from the `slack_thread_root` event, falling
    back to the cached state's `author`/`created_ts` when a thread has no root
    event), last updated, reply count, unread flag (from the existing Slack
    unread mirror), the worktrees following it (archived when none), and an
    excerpt of the first message (~200 runes, cut with the existing `snippet`
    style at a word boundary).
  - Messages: the thread's `slack_thread_root` and `slack_reply` events,
    oldest first by `external_ts`, each with author, author ID, Slack ts, send
    time, and body with the leading `"<author>: "` stripped (a Go twin of
    `slackMessageText` in `ui/src/lib/slackEvent.ts`). Bodies stay Slack
    mrkdwn — converting to plain text would turn `<url|label>` into `label` and
    hide the URLs people search for. `watch_started` and `watcher_error` are
    not messages.
  - Never marks anything read; works for archived threads.
  - **Incomplete history (my call).** Threads followed before watcher v0.31.0
    may lack a `slack_thread_root` event (1 of 106 in Mike's DB today; none has
    fewer `slack_reply` events than its cached `reply_count`). When the root
    event is missing, the messages list synthesizes the root from
    `watch_started`'s body (which holds the root's text) with the cached
    `author` and `created_ts`, marked `"synthesized": true`. The summary
    carries `"replies_cached"` next to `"reply_count"`, and `"complete": false`
    when fewer replies are cached than Slack reported, so the agent can say
    the thread may be missing messages. No catch-up run is part of this work.

### `worktree search <query…>`

```
worktree search <terms…> [--worktree .] [--source github|jira|slack|tasks]…
                [--since 24h|7d|RFC3339] [--unread] [--archived] [--humans-only]
                [--type <event type or prefix*>]… [--limit N] [--json]
```

- Terms are the remaining args joined with spaces (quoting is optional).
- Without `--worktree`: groups `worktrees`, `resources`, `tasks`, `events`.
  With `--worktree <path>` (`.` = current): `resources` and `events` only,
  never reaching outside that worktree — the UI's worktree-page scope.
- Filters mirror the UI's toggles: `--source` (the source toggles),
  `--type` (event-type filter, `ci_*` prefixes allowed), `--unread` (Unreads
  only), `--humans-only`, `--archived` (Include archived: archived events,
  archived resources and archived tasks — the same reach as the dropdown's
  toggle; global scope only). `--since` has no UI
  counterpart and exists so an agent can turn "yesterday" into a filter; it
  narrows events only.
- **How filters reach each group (my call, mirroring the home page).**
  `--source` takes `github`, `jira`, `slack`, `tasks` and `links`, mapping to
  the internal types `pr`, `jira`, `slack`, `task`, `link`. It narrows events,
  resources and worktrees as the UI's source toggles do (a worktree matched
  through a resource only counts resources of a chosen source). The tasks
  group appears only when `--source` is absent or includes `tasks`;
  `--source tasks` alone gives tasks and task events. `--unread` narrows as
  "Unreads only" does on the home page: unread events, resources with unread
  events, worktrees with unread activity, and it drops the tasks group.
- **Tasks group (my call).** Open and done tasks both (done ranked after open,
  as `buildSuggestions` does) — someone asking "find my task about X" may mean
  a finished one. Archived tasks only with `--archived`. This is
  `tasks.Filter{IncludeCompleted: true, IncludeArchived: <--archived>}`,
  independent of the UI panel's per-user toggles.
- Default limits: 10 worktrees, 10 resources, 10 tasks, 20 events. `--limit N`
  sets the events limit; the others stay at 10 (builder may add per-group
  flags if it falls out naturally).
- Each hit carries its match (`field`, `snippet`, and `via` for a worktree
  matched through a resource). An event hit carries its id, ts, source, type,
  rebuilt title, author, unread flag, match, and its resource (type, id, URL,
  custom name, title) — **no body**. A resource hit carries the same
  resource fields `resources list --all --json` prints, minus long text, plus
  the worktrees following it. A worktree hit carries path, branch, repo.
- JSON: `{"schema_version": 1, "query": …, "terms": [...], "scope": "all" |
  "<worktree path>", "worktrees": [...], "resources": [...], "tasks": [...],
  "events": [...]}` (scoped output omits worktrees/tasks).
- Human output: one heading per non-empty group, one line per hit with its
  "why" dimmed (through `internal/ui`), nothing when piped beyond plain text.
- Exit 1 when every group is empty (nothing found is a real answer, like
  `attention`); exit 2 on errors, including an empty query.

### `worktree slack thread <ref>`

```
worktree slack thread <url | slack:<channel>:<ts> | name> [--messages] [--json]
```

- `slack` is a new command group (room for later Slack read commands).
- Ref resolution: a Slack URL (`internal/slackurl`/`resourceurl`) or
  `slack:<id>`; otherwise a name matched case-insensitively against custom
  names and cached titles of every Slack thread any worktree follows or
  followed — an exact match wins, else a unique substring match. None: exit 1.
- **Several matches (my call).** Print the candidates to **stdout** —
  JSON `{"schema_version": 1, "ambiguous": true, "candidates": [<summary
  without excerpt>…]}`, or one human line each — then exit 2 with
  `ambiguous: N threads match "<name>"` on stderr. This needs a typed error
  that `cmd/root.go`'s `exitCode` maps to 2 without re-printing the
  candidates. The skill treats this as a candidate list, not a failure.
- Default output is the summary only. `--messages` adds `messages[]`.
- Human output:

  ```
  #forum-openshift-ai-serving · started by Mike Turley Nov 18 · updated Nov 19 · 3 replies
  "InferencePool RBAC" (custom name) · followed by odh-dashboard/llmisvc-rbac
  > Is it expected that my user doesn't have permission to list InferencePools…
  ```

  With `--messages`, each message follows as `<author> · <time>` and its body.
- JSON: `{"schema_version": 1, "thread": {…summary…}, "messages": [...]}`
  (`messages` only with `--messages`).

### Agent skill (`internal/agentskill/skills/worktree/SKILL.md`)

A new "Finding things" section:

1. For a loose question, run `worktree search … --json` two or three times
   with different term sets: keys/URL fragments, people's names, topic words;
   map "yesterday"/"this week" to `--since`, "in Slack"/"PR"/"Jira" to
   `--source`, "here"/"this worktree" to `--worktree .`. Terms are ANDed
   substrings, so prefer one or two distinctive terms over a sentence. Try
   `--archived` if nothing turns up.
2. Group event hits by their resource; merge with resource hits.
3. For Slack, run `worktree slack thread <ref> --json` (summary only) for each
   candidate and list them: channel, custom name/title, author, first message,
   started, updated. Ask which one was meant and offer to read it.
4. Only after the user says to, run `--messages` and answer from the messages.
   Never run `--messages` speculatively, even with a single candidate.
5. For a PR/Jira/worktree hit, give the link and offer the existing
   drill-downs (`activity --resource`, `info`).
6. If nothing matches, say the cache only covers followed resources and offer
   `worktree resources add <url>` (a write: ask first).

Also add an entry to "Drill-downs" pointing at search, and mention the new
"Thread started …" / "Message from …" event titles where the skill describes
Slack activity, if it does.

### Web UI: "Include archived" in the search dropdown

- The home page's "Include archived" becomes one piece of page state (lifted
  out of `ActivityPanel`'s local `useState`, still not persisted across
  reloads) that both the Activity panel's `ArchivedToggle` and a new toggle in
  the search dropdown read and write. Flipping either flips both.
- With it on, the dropdown shows, besides the archived events it already gets
  from the feed:
  - archived resources, from a new `archived=true` parameter on the
    all-resources endpoint, served by the same loader as the CLI's
    `--archived`, marked "archived" in the row; picking one opens it
    read-only the way an archived event does, with the existing "follow in a
    worktree" path available;
  - archived tasks (the dropdown's own task fetch includes archived ones),
    without changing the task panel, which keeps its separate toggle.
- Home page only. The worktree page's search never leaves its worktree and
  gets no toggle.
- `docs/web-ui-architecture.md` "Search" documents the shared state and the
  endpoint parameter.

### Registration and docs

- Both commands go in `skillReadCommands` (`cmd/agent_help_test.go`).
- `docs/web-ui-architecture.md` "Search" gets a short "CLI" subsection naming
  `Server.Search`, the Go matchers and the parity fixture.
- The plan's **last step** updates `README.md` to feature this capability,
  using the acceptance examples above. The README is being rewritten in
  another session, so that step reads the README as it is then and adapts to
  it; nothing earlier in the plan touches the README.

## Left to the builder

- Package layout of the Go matchers (inside `search.go` or a new file).
- Exact human-output formatting beyond the sketch, and colors.
- Whether `--limit` also scales the non-event groups.
- How the parity fixture is located by both test runners.
- Test fixtures: use `testgit` templates and parallel tests per the repo's
  Go test rules.
