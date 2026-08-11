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

## Phases

Each phase is independently shippable (decision #2). Detailed writing-plans authored per phase at execution time. Execute subagent-driven with reviews (as with prior phases). Suggested subscriber identity for worktree-as-consumer: `worktree:<canonical-worktree-path>` (parallel to handler's `handler:session:<id>`); confirm at Phase 1 design.

### Phase 1 — worktree adopts the watcher library + a DB; resources move to the DB
- Add `modernc.org/sqlite` + depend on `github.com/mturley/watcher`; call `wdb.Migrate` on open. Decide the DB location (e.g. `~/.worktree/worktree.db` or per-user). worktree becomes a watcher *consumer* (its own subscriber namespace).
- Reimplement `internal/resources` over `watcher_subscriptions` (preserve primary/related via a flag; primary = `!Related`). **Stop writing `.worktree-resources`.** (No compat export — decision #2.)
- worktree gains pr/jira polling via the library pollers (`wgithub`/`wjira`) so it has its own timeline data (`watcher_events`) independent of handler.
- Provide a JSON CLI surface handler will later consume (e.g. `worktree resources list --json`, and commands to add/remove/soft-unsubscribe) — design the contract here even though handler adopts it in Phase 5.
- Deliverable: worktree tracks resources in the DB, polls them, has timeline data. CLI unchanged UX-wise.

### Phase 2 — worktree Mantine UI shell (worktree list + global timeline + detail, pr/jira)
- New `ui/` (Vite + Mantine + React 19), Go-embedded, served by a `worktree ui` (and/or server) command mirroring handler's delivery model (embed.go, SSE for live timeline).
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
- Phase 1: worktree DB path + subscriber-identity string; how "related" maps onto a subscription flag vs a separate column; whether worktree runs its own scheduler/poller or polls on-demand from the UI/CLI.
- Phase 4: the exact Slack event shape (what counts as a timeline-worthy event — every reply? thread summary?); dedup/cursor model for Slack; whether the slackapi client lives in the library or worktree passes messages in.
- Phase 4 hybrid seam: how much the live tab and the timeline events share (avoid double-maintaining thread parsing).
- Cross-cutting: React version alignment (handler 19 / slack-mini 18 → target 19 in the new worktree ui).

## Non-goals / explicitly deferred
- No `.worktree-resources` backwards compat (decision #2).
- Slack-mini as a *separate* included repo — rejected (avoids sharing Go API + frontend across repos); fold in instead.
- Making the whole Slack UI watcher-backed — rejected in favor of the hybrid (decision #1).
