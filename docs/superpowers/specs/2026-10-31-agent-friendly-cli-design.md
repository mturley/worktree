# Agent-friendly CLI

Date: 2026-10-31

## Intent

A coworker wants to use worktree by asking an AI agent (Claude Code, pi,
Codex, or any other) about it, instead of clicking through the web UI. Mike
doesn't have this need himself, so the design has to work for someone who
doesn't know worktree's internals and asks the agent in plain words.

The main question is **"give me a quick summary of what's going on and what
deserves my attention."** That combines unread items, recent activity, and
things that need action, ordered by Jira priority (critical first). Other
questions should also be answerable without special help:

- hygiene: "which worktrees can I delete?", "what's gone stale?"
- cross-referencing: "where is RHOAIENG-123?", "what's on port 4050?"
- picking work back up: "where did I leave off here?"
- acting on things, when the user asks for it

Today the CLI can't answer most of these. It has no timeline, no cached
resource state, only a global unread count, and plain-text output (with
ANSI codes even when piped) for `list`, `info`, `ports` and `jira`. An agent
ends up parsing colored text, querying `worktree.db` with `sqlite3`, or
logging into the web API.

## Goals

1. An agent can answer "what deserves my attention?" with one command plus
   a few drill-downs.
2. Every read command has stable, versioned JSON output.
3. An installable skill teaches any agent how to use the CLI well.
4. The agent can tell when the data is stale and tell the user why.

## Non-goals

- An MCP server. It may come later, built on the same read functions. The
  CLI with `--json` works with any agent and with scripts.
- AI summarization inside worktree. The agent does the reasoning (see
  "Splitting facts from judgment").
- New poll sources or watchers.

## Anti-goals (a failure even if it works)

- **An agent writes to the database without explicit permission from the
  user.** That includes marking items read, changing tasks, adding or
  removing resources, and editing notes. The skill must say so plainly, and
  no read command may have a write side effect.
- A read command quietly contacts a service that is turned off
  (`watchers.<service>: false`). The "a disabled service is never
  contacted" rule applies to the CLI exactly as it does to the web UI.
- Slack threads get marked read. The CLI never calls
  `subscriptions.thread.mark`.
- Facts get worked out by the agent from raw events. Anything that can be
  derived deterministically, like CI failing or a review being requested,
  is computed in Go, where it can be tested.

## Splitting facts from judgment

Decided with Mike: **the CLI produces facts, the agent makes judgments.**

- **CLI:** collects candidates, computes the signals behind each one, and
  returns them in a simple fixed order, so an agent that just reads top to
  bottom still gets something sensible.
- **Agent** (taught by the skill): reads the event text the CLI points to,
  decides whether it really needs a response, groups related items (a PR
  and its Jira issue), adjusts to how the question was phrased, and writes
  the summary.

## Commands

### `worktree status`

Answers "how fresh is the data?" without the server.

- Whether `worktree ui` is running: probe the configured listener, the same
  check `cmd/ui.go` uses to detect "already running".
- For each service: enabled or disabled, last successful poll, and last
  error. Read from `watcher_poller_status`, plus per-resource
  `last_success` where that helps.
- `--json`.

The skill runs this first. If the UI isn't running, or the last successful
poll is old, the agent says so ("this is from 3 hours ago; start `worktree
ui` so the watchers poll") **and still answers from the cached data**.
Builder's call: the threshold for "old" (I'd suggest 3× the poll interval,
or 15 minutes).

### `worktree attention`

The main command. Returns one item per resource that has unread events or
at least one signal, for the selected scope (by default every worktree; with
`--worktree`, or when run inside a worktree with no flag, that worktree
only; builder's call which default is more useful, and I lean toward all
worktrees).

Each item includes:

- resource type, id, URL, and custom name
- the worktrees that follow it, and its linked tasks (id, title, state,
  priority, due date)
- cached state: Jira priority, status and assignee; PR state, review
  decision, CI status, and whether you're the author
- unread count, and the timestamp of the newest unread event
- `signals`: a list of named, deterministic reasons, for example
  - `review_requested`: your review is requested on someone else's PR
  - `changes_requested`: on your PR
  - `ci_failing`: on your PR
  - `assigned_to_you`: Jira, newly assigned or currently assigned and
    unread
  - `mentioned`: you're mentioned in an unread event
  - `blocker_resolved`: a task blocker on this resource resolved
  - `task_due_soon`: a linked open task due within N days
  - `stale_draft`: your draft review comments are waiting on this PR
- the newest few unread events (up to 5), with author, time, type and
  short text, so the agent can judge without a second call

Fixed order: Jira priority, then number of signals, then newest activity.
A PR takes the highest priority of its linked Jira issues; an item with no
priority sorts after every prioritised one.

Priority names differ between Jira instances (Red Hat's is Blocker /
Critical / Major / Normal / Minor / Undefined), so ranking by hard-coded
names is wrong. *My call:* the watcher library fetches the instance's own
priority order once (`GET /rest/api/2/priority` returns them highest
first), caches each issue's priority rank next to its name in
`watcher_resource_state`, and `attention` sorts by that rank. Names Jira
calls "Undefined" or similar still get a rank from the list; that's fine,
because it's Jira's order. This is library work (cross-repo).

Items with no unread events and no signals are left out. Exit code 1 when
the list is empty.

**Library work:** some signals may not be derivable from the current cache
(review requested from you, mentions). Where a signal needs data the watcher
doesn't cache, add it to the watcher library and re-pin, following the
cross-repo process in `CLAUDE.md`. Don't work around it here. If a signal
turns out to be expensive, it's fine to ship it later than the others.

### `worktree activity`

The drill-down: the timeline straight from `watcher_events`, without the
server.

- Filters: `--worktree`, `--resource <url|type:id>`, `--since <duration
  or RFC 3339 time>`, `--unread`, `--source github|jira|slack`, `--limit`
  (default 50).
- Follows the same rules as the web timelines: only `worktree:`
  subscribers, `selfid.NotMineSQL` for unread, tombstone handling.
- Text mode prints one line per event. `--json` gives full events.

### `--json` on every read command

`list`, `info`, `ports`, `jira`, `status`, `attention`, `activity`, `unread`,
`resources list`, `tasks list/show`, and every new read command below.

- Every JSON output is an object with `schema_version` (an integer,
  starting at 1) and named fields. Never a bare array.
- `resources list --json` and `tasks list --json` currently return bare
  arrays, so they change shape. agent-handler's
  `worktreeinterop/cli.go` parses `resources list --json`; update it in
  the same piece of work. No backward compatibility is needed (see the
  "library changes welcome" preference).
- `list --json` includes, per worktree: name, path, repo, branch, open in
  cmux or not, unread count, primary resources with their cached state, git
  ahead/behind/dirty, and the time of the latest activity. That makes
  hygiene questions a single filter.
- `info` (text and `--json`) shows the cached resource state from the DB.
  It never contacts a service. Today's `--local` flag is declared but never
  read, so it is removed. There is no `--refresh`: polling from the CLI would
  write watcher tables (breaking "no read has a write side effect") and race
  `worktree ui`'s poll loop. *(Builder check; my call.)*
- `resources list` gains `--all`, covering resources across all worktrees
  (the CLI version of `/api/all-resources`), and includes cached state and
  unread count.

### Colors

No ANSI codes when stdout isn't a terminal. `NO_COLOR` is always honored.
Applies to every command, through `internal/ui`.

### Unread by scope, and bulk mark-read

- `unread --json --by worktree|resource` gives per-scope counts. Without
  `--by`, the existing `{"unread", "count"}` shape stays (plus
  `schema_version`), because the menu bar app reads it. Update the app's
  parser in the same change if the shape changes.
- `resources mark-read` gains `--worktree <path>` and `--all`. The help text
  explains that the read cursor is per resource and shared, so marking read
  from one worktree marks it read everywhere.
- Slack threads are skipped by mark-read, and the command says so. Their
  read state is Slack's own.

### New read commands

- `worktree notes show [--worktree]` and `notes set` (set is a write;
  see "Writes").
- `worktree review-comments list [--worktree]`: your draft comments on the
  diff, with their resolved position (`current` / `moved` / `outdated`).
- `worktree pr-threads list [--worktree | --resource]`: the open PR's
  review threads. This contacts GitHub live (the web UI doesn't cache
  them), so it is refused when the GitHub watcher is off and says why.
- `worktree linked <resource>`: the linked resources. Also contacts
  services live; each source is skipped when its watcher is off.
- `worktree ports --listening`: what's actually listening, attributed to
  worktrees (`internal/listeners`), alongside the allocations.

These are thin wrappers over packages that already exist (`notes`,
`reviewcomments`, `prcomments`, `linked`, `listeners`). Shared logic that
lives in `internal/webui` today moves to where both the CLI and the web UI
can use it, not copied.

### Exit codes

- 0: success.
- 1: "nothing found", for `attention` and `activity --unread` when the
  result is empty.
- `unread` keeps exiting 0 when nothing is unread: the menu bar app
  (`internal/macapp/app/UnreadWatch.swift`) treats any non-zero exit as a
  failure, and the JSON already says `"unread": false`. *(Builder check;
  my call.)*
- 2 or higher: an error.

### Writes, and `--as-agent`

- `--as-agent` becomes a root-level persistent flag. It is recorded on task
  events, as today, and also on resource writes (add, remove, mark-read,
  set-name, unwatch) and on `notes set`, wherever there is an event or
  audit column to put it in. Builder's call where no such column exists:
  add one, or accept the flag and do nothing with it.
- The skill tells the agent to always pass `--as-agent` on writes, and to
  make **no write at all** without the user's explicit permission.

## The skill

A cross-agent skill: a folder with a `SKILL.md` (frontmatter `name:
worktree`, and a `description` that triggers on questions about worktrees,
PRs, Jira issues, Slack threads, tasks or "what needs my attention"). It
lives in this repo (for example `skills/worktree/SKILL.md`) and is embedded
into the binary.

Installation (decided with Mike: it's a skill to install, not an
`AGENTS.md` line):

- `worktree setup` offers to install it at `~/.agents/skills/worktree/`,
  the shared location.
- It then offers to symlink it into the skill directory of each agent that
  doesn't read `~/.agents/skills` itself and whose config directory exists.
  Claude Code (`~/.claude/skills/`) is the known one. **Builder: confirm
  current paths for Claude Code, Codex and pi before building.** On this
  machine `~/.agents/skills` and `~/.codex/skills` exist and
  `~/.pi/agent/skills` does not.
- On `worktree update` or setup re-runs, it updates the installed copy only
  when the embedded content changed (same hash approach as the menu bar
  app), and never overwrites a copy the user edited without asking.

Content (short, aimed at an agent):

1. Run `worktree status --json` first. If the UI isn't running or the data
   is stale, tell the user to start `worktree ui`, then answer from the
   cache anyway.
2. For "what's going on / what needs me": `worktree attention --json`.
   Read the events it includes, judge which actually need a response,
   group related items, lead with critical priority, and keep it short.
3. Drill-downs: `activity`, `resources list --all`, `tasks list/show`,
   `info`, `list`, with a few concrete recipes (hygiene, "where is X",
   "where did I leave off").
4. Always use `--json`. For `attention` and `activity --unread`, exit
   code 1 means "nothing found", not an error.
5. **Never write without explicit permission from the user.** Writes are
   `mark-read`, every `tasks` mutation, `resources add/remove/unwatch/
   set-name`, `notes set`. Always pass `--as-agent`.
6. Read state is shared with the web UI. Marking something read changes
   what the user sees there.

`worktree agent-help` prints the same text, for an agent without the skill
installed.

## Constraints

- Everything reads from worktree's own DB without the server, except
  `pr-threads` and `linked`, which contact services live and respect the
  watcher toggles.
- Watcher library changes follow the cross-repo process in `CLAUDE.md`.
- Tests follow the repo's Go test rules: `t.Parallel()` by default,
  `testgit` fixtures, `TestMain` where needed.
- JSON field names are snake_case and stable. A shape change bumps
  `schema_version`.

## Left to the builder

- Command and flag spelling, beyond what's named above.
- The text-mode layout of new commands.
- How signals are computed and named, beyond the list above.
- The staleness threshold.
- Order of delivery. I'd suggest: colors and the JSON envelope first, then
  `status`, `activity`, `attention`, the skill, and finally the remaining
  read commands and unread scopes.
