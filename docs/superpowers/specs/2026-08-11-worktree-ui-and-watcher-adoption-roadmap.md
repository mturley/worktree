# Worktree UI + Watcher Adoption — Multi-Phase Roadmap

**Status:** Roadmap / brainstorm output (2026-08-11). Not an implementation plan — each phase gets its own detailed plan (writing-plans) at execution time. This doc captures the phase order, the decisions behind it, and per-phase scope so the sequence survives across sessions.

**Author context:** produced with Claude in a session that had deep context on the cross-repo watcher/handler work (watcher library v0.2.4, agent-handler v0.1.1). See the memory note `watcher-ui-roadmap` for the pointer.

## Goal

A web UI (Mantine) for the `worktree` CLI with: a **worktree list + global timeline** view (like agent-handler's global UI), and a **worktree detail view** with the worktree's resource list, a timeline scoped to that worktree's watched resources, and tabs to view the **Slack threads** watched by the worktree (UI folded in from the `slack-mini` project). Along the way: worktree adopts the `github.com/mturley/watcher` library and moves resource tracking from the `.worktree-resources` file into the watcher database; `slack-mini` is folded into `worktree` and its repo archived; Slack threads become a watcher-supported resource type so Slack messages appear in worktree timeline views; and agent-handler is updated to drive worktree via the worktree CLI (auto-watch primary resources at session registration; propagate `/watch`/`/unwatch`). Finally, agent-handler itself gains Slack threads as a watched resource type.

## Repos involved

- **worktree** — `github.com/mturley/worktree` (Go, no DB today; file/git-state based). Owns `.worktree-resources` in `internal/resources/resources.go`. Has `internal/{github,jira,discovery,ui,...}`; `internal/ui/ui.go` is a placeholder. **Hub of this effort.**
- **slack-mini** — `github.com/mturley/slack-mini` (Go + React 18/Vite UI in `ui/`; `internal/{server,slackapi,watcher,cli,config}`). Live-fetches Slack (no DB). Its `internal/watcher` is its OWN concept (NOT the mturley/watcher library; it diverged from an early extractible attempt) — **rename it when folding in.** NOTE: a reply feature is actively being added; fold-in must wait until that lands.
- **watcher** — `github.com/mturley/watcher` (Go SQLite library, v0.2.4). Resource types today: `pr`, `jira`. Owns `watcher_*` tables + timeline events + pollers (`github`, `jira`).
- **agent-handler** — `github.com/mturley/agent-handler` (v0.1.1). Consumes watcher. Reads `.worktree-resources` at ~5 seams (register.go, statusline.go, user_prompt_submit.go, subscribe.go, unsubscribe.go, db/subscriptions.go).

## Key architectural decisions (locked in brainstorm 2026-08-11)

1. **Hybrid Slack data model.** The unified worktree **timeline** shows Slack via lightweight watcher events (new reply → timeline entry). The Slack-thread **detail tab** keeps slack-mini's live-fetch API for full fidelity (reactions, edits, live reply). Two data paths, intentionally.
2. **Foundation-first ordering**, but **NO backwards-compat anywhere.** worktree has no users besides the author; `.worktree-resources` was only ever the author's own worktree↔handler integration. So: no `.worktree-resources` compat export, and phases do NOT need to land together. Handler may keep reading a file worktree no longer writes — harmless dead functionality until handler's worktree-CLI support lands. **This decoupling is the big simplifier: every phase is independently shippable.**
3. **Slack fold-in before slack-timeline.** Get the Slack tab (live-fetch + reply feature) into worktree first; add the watcher Slack resource type + poller (timeline half of the hybrid) as a later additive phase.
4. **Worktree UI:** new `ui/` mirroring handler's *Go-embed + Vite* delivery model (embed.go, a `worktree ui`/server command, SSE timeline), but using **Mantine** (not handler's shadcn/ui). Free to diverge from handler's frontend patterns; React 19 + Vite target. Port slack-mini's Slack components into it.
5. **Capture:** this spec doc + a memory pointer.

## worktree Resource model (already well-aligned)

`internal/resources/resources.go` today: `Resource{ Type string; ID string; URL string; Related bool }`, where `Related` (the `~ ` prefix) already encodes **primary vs related** — exactly the distinction handler needs for "which resources are primary for auto-watching." Maps cleanly onto watcher's `Resource{Type,ID,URL}` + a subscription flag. Primary = `!Related`.

## Cross-cutting architecture decisions (brainstorm 2026-08-11, part 2)

These span multiple phases; decided up-front to avoid retrofits. Each phase's own plan implements its slice.

### CC-1. Poller ownership & DB topology — separate DBs, poll in the UI server (no scheduler)
- **worktree gets its OWN watcher DB**, separate from handler's `~/.agent-handler/data/handler.db`. Not a shared DB (that would mean worktree reading handler's DB — awkward ownership, handler owns session/event/dismissal tables). 
- **The library's `ConsumerRegistry` (`consumers: {name: {db}}` in `~/.config/watcher/auth.yaml`, with `RegisterConsumer`/`Consumers()`) exists but its poll fan-out is NOT built** — it's currently a stub. worktree should still **register itself** in the ConsumerRegistry at setup (cheap, forward-looking) but otherwise keep its own DB + polling.
- **Double-polling is accepted.** The same PR watched by both handler and worktree gets polled twice — an efficiency cost, not a correctness bug, and negligible at current (single-user) scale. Unifying pollers via ConsumerRegistry fan-out (poll each unique resource once, write to every subscribing consumer DB) remains a POSSIBLE future phase but may never pay off; do NOT build it now and do NOT block the roadmap on it.
- **No scheduler for worktree (KEY simplification):** unlike handler (which exposes inboxes to other interfaces and so needs launchd/cron background polling), **worktree has NO external consumer of its events** — the timeline is only ever viewed in the worktree UI itself. So **polling runs inside the worktree UI server process** (poll on an interval while the server is up; refresh-on-view is fine too). It is acceptable that worktree's DB is not updated when the UI server isn't running. → worktree does NOT need handler's `scheduler.go`/launchd/cron model. Drops real scope from P1/P2.

### CC-2. worktree → handler CLI contract (design in P1, consumed in P5)
The JSON CLI surface handler binds to. Lock the shape in P1 so P5 is a thin shim:
- `worktree resources list [--worktree <path>] --json` → `[{ "type": "pr|jira|slack", "id": "...", "url": "...", "primary": true|false }]`. `primary = !Related`. Handler P5 auto-watches `primary:true` at registration.
- `worktree resources add <type> <id> [--url <url>] [--related]` → for handler `/watch` propagation (add a resource to the worktree).
- `worktree resources unwatch <type> <id>` → **soft**-unsubscribe as unsubscribed-by-user (maps to watcher lib `UserUnsubscribe`), for handler `/unwatch` propagation. **Distinct from a hard `remove`.**
- Conventions: default to cwd's worktree; `--json` for machine callers; non-zero exit + stderr when not in a worktree / CLI unavailable (handler treats that as "no worktree integration," proceeds normally).
- The two contract essentials: **primary/related is a first-class field**, and **soft `unwatch` (user tombstone) ≠ hard `remove`**.

### CC-3. Slack resource identity & timeline events (shapes P4)
- **Resource identity:** a Slack *thread* = `{channel_id, thread_ts}` (thread_ts = parent message ts, stable). Encode as `Type:"slack"`, `ID:"<channel_id>:<thread_ts>"`, `URL` = Slack permalink. Parallels pr/jira.
- **Timeline events:** each **new reply after the cursor** → one `watcher_event` (author, text snippet, ts). **Cursor caveat:** Slack `ts` are epoch-second strings (e.g. `1699...`), NOT RFC3339 — the poller's cursor/comparison logic must handle Slack ts format, unlike the github/jira pollers which use RFC3339. The thread ROOT message → cached `resource_state` (title/summary); replies → events.
- **Fetch reuse:** the P4 poller wraps slack-mini's `slackapi` client (folded into worktree in P3) as its fetch layer — avoid two Slack-parsing implementations. Open: whether slackapi lives in the library or worktree feeds messages to a library poll function; decide at P4.

### CC-4. Consumer model (confirmed, no library change)
worktree is simply a new **subscriber prefix** (`worktree:<canonical-worktree-path>`, parallel to handler's `handler:session:<id>`) plus a ConsumerRegistry entry (CC-1). Verified the library needs no changes to support a second consumer this way.

## Persistence consolidation (brainstorm 2026-08-11, part 3)

Introducing the DB (Phase 1) is the moment to consolidate worktree's on-disk state. Deciding test: **who reads it, and when?** worktree-only readers → DB; readers outside worktree (shell, git) → file or a shellenv-style bridge.

| Data (today) | Decision | Rationale |
|---|---|---|
| Port allocations (`.port-ranges`, global name→slot map) | **→ DB (worktree-owned table), in Phase 1** | Relational w/ a uniqueness constraint; the flat file has a parse→mutate→rewrite race on concurrent allocate. DB gives atomic allocate + `UNIQUE(slot)`. worktree-only reader. Allocated range still reaches the shell via the env bridge (a projection, not a reason to keep the file). |
| Resources (`.worktree-resources`) | → DB (watcher_subscriptions), Phase 1 | Original driver. |
| `.worktree-env` (export lines sourced by shell) | **DB is source of truth; project via a `shellenv`-style command** (see PC-1) | Shell can't query SQLite → need a bridge, not a raw DB read. |
| `.git/info/exclude` worktree-managed block | **REMOVE entirely (Phase 1)** | Verified it manages exactly `.worktree-env` + `.worktree-resources` (`internal/gitutil/exclude.go` `managedEntries`). Both files are going away, so the exclude block has nothing left to exclude. Drop `AddExcludes`/`RemoveExcludes` and their call sites. |
| `~/.config/worktree/config.yaml` | Stays a file | User-editable config; file is correct. BUT drop the `search:` (discovery roots/depth/prune) section — see PC-2. |
| Discovery (scan filesystem for worktrees) | **Pivot: DB is the registry** — see PC-2 | worktree only manages worktrees IT created. |
| dotfiles copy | No change | File-copy op, no state. |

### PC-1. `.worktree-env` → shellenv command (with a fast-cold-start note)
- Replace the sourced `.worktree-env` file with a command that prints `export …` lines computed live from the DB (à la `brew shellenv`); shellrc does `eval "$(worktree env)"` on `cd` into a worktree (migrate the existing shellrc block that currently `source`s the file). Vars: `WORKTREE_PORTS`, `WORKTREE_TITLE`, `WORKTREE_PATH`, `KUBECONFIG` (KUBECONFIG points at a seeded file that stays on disk; only the path is env data).
- Must be **cheap and silent** outside a worktree (safe to eval anywhere), like `brew shellenv`.
- **IMPORTANT (author): fast cold start matters** — the main `worktree` binary will bloat once the web UI is embedded, and this runs on every `cd`. Strongly consider a **separate tiny `worktree-env` binary** (no UI deps) that only reads the DB and prints exports, invoked by the shellrc eval. Possibly an over-optimization, but flagged as important; evaluate at the PC-1/Phase-1 planning (measure the full binary's cold start first).

### PC-2. Discovery pivot — DB registry, not filesystem scan
- **Today:** `discovery.Discover(cfg.Search.Roots, Depth, Prune)` scans the filesystem and adopts ANY git worktrees it finds (used by `list`, `cleanup`, `prune`). 
- **New model (author decision):** the DB is the source of truth for worktrees this tool manages. worktree only manages worktrees IT created (recorded in the DB at creation). **Stop scanning for / showing unrelated worktrees.** `list` reads the DB. Drop the `search:` config section (roots/depth/prune) from `config.yaml`.
- **Retain a reconcile/cleanup command:** detect (a) folders under the worktrees base that are NOT in the DB (orphans → offer to delete) and (b) DB rows whose worktree files are gone (stale → clean up). This replaces the old scan-based `cleanup`/`prune` with a DB-vs-disk reconcile.
- Ripple: `discovery.go`'s scan (`Discover`/`findGitRepos`) is largely removed; `IsInsideWorktree` (live git check for "am I in a worktree right now") is still useful — keep it. `list`/`cleanup`/`prune` cmds are reworked around the DB.

### Follow-up noted (not scoped here)
- worktree's `config.yaml` has its own `jira: {host,email,token,projects}` block, duplicating creds destined for `~/.config/watcher/auth.yaml`. Once worktree adopts the watcher library, consider sourcing Jira (and GitHub) creds from the shared watcher auth config instead of worktree's config.yaml (keep worktree-specific bits like `projects`/`editor`/`worktrees_base` in config.yaml). A consolidation nicety; revisit during Phase 1 or later, don't expand P1 scope for it now.

## Phases

Each phase is independently shippable (decision #2). Detailed writing-plans authored per phase at execution time. Execute subagent-driven with reviews (as with prior phases). Suggested subscriber identity for worktree-as-consumer: `worktree:<canonical-worktree-path>` (parallel to handler's `handler:session:<id>`); confirm at Phase 1 design.

### Phase 1 — worktree adopts the watcher library + a DB; resources move to the DB
- Add `modernc.org/sqlite` + depend on `github.com/mturley/watcher`; call `wdb.Migrate` on open. Decide the DB location (e.g. `~/.worktree/worktree.db` or per-user). worktree becomes a watcher *consumer* (its own subscriber namespace).
- Reimplement `internal/resources` over `watcher_subscriptions` (preserve primary/related via a flag; primary = `!Related`). **Stop writing `.worktree-resources`.** (No compat export — decision #2.)
- worktree gains pr/jira polling via the library pollers (`wgithub`/`wjira`) so it has its own timeline data (`watcher_events`) independent of handler. **Polling is invoked in-process (no launchd/cron) — see CC-1.** In P1 this can be a `worktree watcher run`-style one-shot for testing; the interval polling loop lands with the UI server in P2. Register worktree in the library ConsumerRegistry (CC-1).
- Provide the JSON CLI surface per **CC-2** (`worktree resources list --json`, `add`, soft `unwatch` vs hard `remove`) — design/build the contract here even though handler adopts it in Phase 5.
- **Persistence consolidation folded into P1 (see the section above):** (a) move port allocations from `.port-ranges` into a worktree-owned DB table (PC table; atomic allocate + unique slot); (b) replace `.worktree-env` with the `shellenv`-style command + shellrc migration (PC-1; evaluate the separate `worktree-env` binary); (c) remove `.git/info/exclude` management entirely (nothing left to exclude); (d) pivot discovery to the DB registry — `list` reads the DB, drop filesystem scan + the `search:` config section, keep `IsInsideWorktree`, add a DB-vs-disk reconcile/cleanup command (PC-2).
- Deliverable: worktree tracks resources AND port allocations in its own DB (source of truth); `worktree env` shellenv command replaces `.worktree-env`; no more `.git/info/exclude` munging; `list`/`cleanup` are DB-backed; exposes the CC-2 CLI. This is a larger P1 than "just adopt watcher" — the P1 plan may split into sub-tasks (watcher-resources, ports, env/shellenv, discovery/cleanup) but it's one coherent DB-adoption effort.

### Phase 2 — worktree Mantine UI shell (worktree list + global timeline + detail, pr/jira)
- New `ui/` (Vite + Mantine + React 19), Go-embedded, served by a `worktree ui` (and/or server) command mirroring handler's delivery model (embed.go, SSE for live timeline). **The UI server owns the polling loop (CC-1):** it polls the worktree's watched resources on an interval while running (and/or on view), writing events to the worktree DB. No background scheduler; DB going stale while the server is down is acceptable.
- Views: (a) worktree LIST + GLOBAL timeline (all worktrees' events), (b) worktree DETAIL = resource list + timeline scoped to that worktree's watched resources. pr/jira only in this phase.
- Deliverable: usable worktree web UI for pr/jira. (Mirrors handler's global/detail UX; Mantine styling.)

### Phase 3 — fold slack-mini into worktree (Slack tab, live-fetch) + archive slack-mini
- **Precondition: slack-mini's reply feature is finished.**
- Move slack-mini's Go (`internal/{slackapi,server,config,cli}`) and UI (Slack-thread components incl. reply) into worktree. RENAME slack-mini's `internal/watcher` (diverged concept; avoid confusion with the library).
- **Slack setup/token acquisition:** slack-mini has a setup process that helps the user acquire Slack API tokens (see slack-mini `internal/cli` + `internal/config`, e.g. the `extract.mjs`/token-extraction flow). Fold this into **worktree setup**. **DECISION (author):** write the acquired Slack token into `~/.config/watcher/auth.yaml` (the watcher library's shared auth config) from the start — even though in Phase 3 it's consumed only by the live-fetch tab, storing it centrally now means the token is already in the right place and shared when Phase 4's watcher Slack poller (and later handler) need it. So Phase 3 adds a `slack` credential entry to the watcher `auth.yaml` shape (the config package already has GitHubConfig/JiraConfig + a SlackConfig stub — verify/extend it) and worktree's Slack live-fetch reads it from there. This makes the watcher `config` package the single source of Slack creds across worktree + (later) watcher poller + handler. This is real scope, not just a UI move.
- Add a Slack-thread TAB to the worktree detail view, using the live-fetch API (full fidelity). Slack threads become a worktree resource the user can attach to a worktree.
- Archive the `slack-mini` repo.
- **Cross-repo note:** because the token goes in `~/.config/watcher/auth.yaml`, Phase 3 has a small watcher-library touch (extend/verify `SlackConfig` in the watcher `config` package + an accessor), even though the Slack *poller* is Phase 4. If that touch is more than trivial, it may warrant a small watcher patch release that worktree pins. Assess at Phase 3 planning. (The library already has a `SlackConfig` stub per prior work — likely just needs a token field + accessor.)
- Deliverable: worktree UI shows Slack threads (live) per worktree; Slack setup is part of `worktree setup` and writes to the shared watcher auth.yaml; slack-mini consolidated. NO timeline-slack yet.

### Phase 4 — watcher library: Slack thread resource type + poller (timeline half of hybrid)
- Add a `slack` resource type to the watcher library + a Slack poller that emits thread-reply events into `watcher_events` (lightweight: new reply → timeline entry). Reuse/relocate slack-mini's slackapi client as the fetch layer if clean; keep the poller lib-idiomatic (mirror `github`/`jira` pollers).
- worktree subscribes Slack threads as resources; Slack now appears in the worktree unified timeline (global + per-worktree).
- Tag a new watcher minor (e.g. v0.3.0 — new resource type is feature-level). worktree pins it.
- Deliverable: the hybrid is complete — Slack in the timeline (watcher events) + the live tab (Phase 3).

### Phase 5 — agent-handler ↔ worktree integration
- At session registration, handler detects the worktree CLI (in a worktree) and calls it (`worktree resources list --json`) to determine the worktree's PRIMARY resources → auto-watch those for the session. Replaces the old `.worktree-resources` read (drop handler's now-dead file readers across the ~5 seams).
- `/watch` + `/unwatch` (and handler's Subscribe/Unsubscribe): in addition to handler's DB, detect worktree + CLI availability and (a) `/watch` → tell worktree to also watch the new resource; (b) `/unwatch` → soft-unsubscribe in worktree as `unsubscribed-by-user`.
- Deliverable: handler and worktree share resource intent via the CLI; no file dependency.

### Phase 6 — agent-handler: Slack threads as a watched resource type (last)
- Handler gains `slack` as a first-class watched resource type (built on the watcher Slack support from Phase 4), so Slack thread events flow to session inboxes/timeline in handler too.
- Deliverable: Slack fully first-class in handler.

## Open questions to resolve at each phase's own planning
- Phase 1: worktree DB path (e.g. `~/.worktree/worktree.db`?) + subscriber-identity string (`worktree:<path>` per CC-4); how "related" maps onto a subscription flag vs a separate column. (Polling model already decided — CC-1: in-UI-server, no scheduler.)
- Phase 4: the exact Slack event shape (what counts as a timeline-worthy event — every reply? thread summary?); dedup/cursor model for Slack; whether the slackapi client lives in the library or worktree passes messages in.
- Phase 4 hybrid seam: how much the live tab and the timeline events share (avoid double-maintaining thread parsing).
- Cross-cutting: React version alignment (handler 19 / slack-mini 18 → target 19 in the new worktree ui).

## Non-goals / explicitly deferred
- No `.worktree-resources` backwards compat (decision #2).
- Slack-mini as a *separate* included repo — rejected (avoids sharing Go API + frontend across repos); fold in instead.
- Making the whole Slack UI watcher-backed — rejected in favor of the hybrid (decision #1).
