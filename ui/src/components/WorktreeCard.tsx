import { Badge, Box, Group, Paper, Stack, Text } from "@mantine/core"
import { relativeTime as rel, relativeFromNow } from "../lib/relativeTime"
import { useLocation } from "wouter"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { resourceSummary } from "../lib/resourceSummary"
import { CmuxWorkspaceSection } from "./CmuxWorkspaceSection"
import { ResourceStatusIcon } from "./ResourceStatusIcon"
import { shortResourceRef } from "../lib/resourceRef"

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
  const summary = resourceSummary(w.primary_by_type, w.related_count)
  const name = worktreeName(w.path)

  // The whole card is a single anchor. An <a> rather than a <button> because
  // it navigates: middle-click, copy-link and Enter all work for free, and
  // there is nothing interactive nested inside it any more to conflict with.
  const interactive = clickable
    ? {
        component: "a" as const,
        href,
        "aria-label": `open worktree ${name}`,
        "data-interactive": "true",
        onClick: (e: React.MouseEvent) => {
          // Let modified clicks (new tab, download) behave natively.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          navigate(href)
        },
        style: { display: "block", textDecoration: "none", color: "inherit" },
      }
    : {}

  return (
    <Paper p="sm" withBorder>
      <CmuxWorkspaceSection path={w.path} branch={w.branch} />
      <Box {...interactive}>
        <Stack gap={6}>
          <Group gap="xs" wrap="wrap">
            <Text fw={700} size="md" style={{ overflowWrap: "anywhere" }}>{name}</Text>
            {!w.on_disk && <Badge size="xs" color="red">missing</Badge>}
          </Group>
          <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
            {[
              w.repo,
              w.branch,
              w.latest_event_ts ? rel(w.latest_event_ts) : "",
              summary,
            ].filter(Boolean).join(" · ")}
          </Text>
          {w.focus_resources.length > 0 && (
            <Stack gap={2}>
              {w.focus_resources.map((r) => (
                <FocusResourceLine key={`${r.type}:${r.id}`} r={r} />
              ))}
            </Stack>
          )}
        </Stack>
      </Box>
    </Paper>
  )
}
