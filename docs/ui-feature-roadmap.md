# Worktree UI feature roadmap

A running list of UI enhancements for `worktree ui` — things we want but have
deferred, with enough context to pick each one up later. Add to this as ideas
come up; delete items when they ship.

Shipped phases are not kept here. Their commits are in git history
(`git log -- docs/ui-feature-roadmap.md` for the entries as they were written),
their designs in `docs/superpowers/specs/`, and the parts that still constrain
the code in `docs/web-ui-architecture.md`. Phases F, G and H shipped in the
2026-08 run and were cleared from this file on 2026-09-02.

## In design

- **Per-resource unread cursor.** A read cursor per tracked resource, driving
  an unread divider in single-resource timelines, unread dots on events in the
  unified timelines, a "mark N events as read" action, and an unread dot
  wherever a resource is named. Slack threads keep their own read state from
  the Slack API rather than getting a cursor. Being brainstormed 2026-09-02.

## Deferred / needs input

- **Task manager feature.** Scope undefined; needs brainstorming before it can
  be written down usefully — see the reminder.
