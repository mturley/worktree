import { Badge, Box, Group, Paper, Stack, Text } from "@mantine/core"
import { relativeTime as rel, relativeFromNow } from "../lib/relativeTime"
import { useLocation } from "wouter"
import { useCmuxMatches } from "../api/cmux"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { relatedSummary } from "../lib/resourceSummary"
import { CmuxWorkspaceSection } from "./CmuxWorkspaceSection"
import { ResourceStatusIcon, UnreadDot } from "./ResourceStatusIcon"
import { shortResourceRef } from "../lib/resourceRef"
import { cardEdgeStyle } from "../lib/unread"
import { UnreadBadge } from "./UnreadBadge"

interface WorktreeCardProps {
  w: WorktreeSummary
  /**
   * When true (default) the card navigates to the worktree detail page.
   * The detail page renders the same card with clickable={false}, since we
   * are already there.
   */
  clickable?: boolean
}

/**
 * A focus resource, as plain content — deliberately NOT a link.
 *
 * These used to deep-link into the worktree with the resource preselected.
 * That made the card a minefield of small targets: the useful action is
 * "open this worktree", and picking a resource is one easy click away once
 * you are there. Now the whole card is one target and these just describe it.
 */
/**
 * The second line under a focus resource: the few facts worth knowing without
 * opening the worktree. Different per type because what matters differs — a
 * PR is about who owns it and how stale it is; an issue is about where it sits
 * in the workflow.
 *
 * Returns "" when nothing is known (a resource that has never been polled),
 * so the caller can skip the line entirely rather than render an empty one.
 */
function resourceMetaLine(r: ResourceDTO): string {
  const parts: string[] = []
  if (r.type === "jira") {
    if (r.status) parts.push(r.status)
    if (r.priority) parts.push(r.priority)
  } else if (r.author) {
    // PRs and Slack threads both lead with who owns the thing: the PR's
    // author, or whoever started the thread.
    parts.push(r.author)
  }

  // Two timestamp formats, deliberately not interchangeable. Slack threads
  // carry a raw Slack ts ("1699000500.000200") in updated_ts, while PRs and
  // Jira issues carry RFC3339 in updated_at. Passing one to the other's
  // helper prints the raw string back.
  if (r.type === "slack") {
    if (r.updated_ts) parts.push(`updated ${relativeFromNow(r.updated_ts)}`)
  } else if (r.updated_at) {
    parts.push(`updated ${rel(r.updated_at)}`)
  }

  return parts.join(" · ")
}

function FocusResourceLine({ r }: { r: ResourceDTO }) {
  const label = r.custom_name || r.title || r.id
  // Same abbreviation the timeline's event chips use, so "#42" and
  // "RHOAIENG-1" mean the same thing wherever they appear.
  const ref = shortResourceRef(r.type, r.id)
  const meta = resourceMetaLine(r)
  return (
    <Stack gap={0}>
      <Group gap={6} wrap="nowrap" align="center">
        <UnreadDot r={r} />
        {/* Same mapping as the resource cards' titles: both read
            resourceStatusMeta, so an icon change lands in both places. */}
        <ResourceStatusIcon r={r} />
        {ref && (
          <Text size="sm" fw={600} c="dimmed" style={{ whiteSpace: "nowrap" }}>{ref}</Text>
        )}
        <Text size="sm" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>{label}</Text>
      </Group>
      {meta && (
        // Indented to clear the status icon, so it reads as belonging to the
        // line above rather than as another resource.
        <Text size="xs" c="dimmed" pl={20} lineClamp={1} style={{ minWidth: 0 }}>
          {meta}
        </Text>
      )}
    </Stack>
  )
}

/** The worktree's own name — the last path segment, e.g. "wt-ui-fixes". */
function worktreeName(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] || path
}

export function WorktreeCard({ w, clickable = true }: WorktreeCardProps) {
  const [, navigate] = useLocation()
  const href = `/worktree/${encodeURIComponent(w.path)}`
  const name = worktreeName(w.path)
  const related = relatedSummary(w.related_by_type)

  // Inside cmux, a matched workspace name is the card's headline, so the
  // worktree title steps down to a subtitle. Same shared query the section
  // itself reads — no extra request.
  const hasWorkspace = useCmuxMatches(w.path).length > 0

  // The anchor is the inner Box, not the Paper, because the cmux section
  // sits above it and must not be nested interactive content inside an <a>.
  const link = clickable
    ? {
        component: "a" as const,
        href,
        "aria-label": `open worktree ${name}`,
        "data-card-link": "true",
        onClick: (e: React.MouseEvent) => {
          // Let modified clicks (new tab, download) behave natively.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          navigate(href)
        },
        style: { display: "block", textDecoration: "none", color: "inherit" },
      }
    : {}

  // The lighter background and hover belong to the WHOLE card, including the
  // cmux strip — the card is one surface, and lighting only its lower half
  // reads as a rendering bug. So the affordance flag lives on the Paper while
  // the anchor lives inside it; cards.css carries the matching focus rule for
  // the nested link.
  const affordance = clickable ? { "data-interactive": "true" } : {}

  return (
    <Paper
      p="sm"
      withBorder
      {...affordance}
      // Whole-card cue, from the backend's aggregate rather than the focus
      // lines: related resources are counted but never listed, so reading
      // focus_resources here would leave their unreads invisible.
      style={cardEdgeStyle(!!w.has_unread)}
    >
      <CmuxWorkspaceSection path={w.path} branch={w.branch} />
      <Box {...link}>
        <Stack gap={6}>
          <Group gap="xs" wrap="wrap">
            {/* Marks the worktree's own name, so it stays identifiable once
                the cmux workspace takes over as the card's headline. */}
            <Badge size="xs" color="blue" variant="light" style={{ flex: "none" }}>WORKTREE</Badge>
            <Text
              fw={hasWorkspace ? 600 : 700}
              size={hasWorkspace ? "sm" : "md"}
              c={hasWorkspace ? "dimmed" : undefined}
              style={{ overflowWrap: "anywhere" }}
            >
              {name}
            </Text>
            {!w.on_disk && <Badge size="xs" color="red">missing</Badge>}
            {/* Pushed to the right of the title row rather than the card's
                corner: the cmux strip owns the top edge, and a badge floating
                over it reads as belonging to the workspace, not the worktree. */}
            <UnreadBadge unread={!!w.has_unread} count={w.unread_count} ml="auto" />
          </Group>
          {/*
            Identity only: which repo, which branch. The counts that used to
            sit here ("1 PR, 1 issue") restated the resource list immediately
            below, and the worktree-level timestamp restated the per-resource
            "updated" on each row.
          */}
          <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
            {[w.repo, w.branch].filter(Boolean).join(" · ")}
          </Text>
          {w.focus_resources.length > 0 && (
            <Stack gap={2}>
              {w.focus_resources.map((r) => (
                <FocusResourceLine key={`${r.type}:${r.id}`} r={r} />
              ))}
            </Stack>
          )}
          {related && (
            // Related resources are not listed individually — they are the
            // ones you did not mark as the point of this worktree — so this
            // line is the only place their shape shows. Named by type, since
            // "2 related Slack threads" tells you where to look and a bare
            // total does not. Indented to sit under the resource text, so it
            // reads as the tail of that list rather than a new fact.
            <Text size="xs" c="dimmed" pl={20}>
              {`+ ${related}`}
            </Text>
          )}
        </Stack>
      </Box>
    </Paper>
  )
}
