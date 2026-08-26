import { Badge, Group, Paper, Stack, Text } from "@mantine/core"
import { relativeTime as rel } from "../lib/relativeTime"
import { useLocation } from "wouter"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { resourceSummary } from "../lib/resourceSummary"
import { ResourceStatusIcon } from "./ResourceStatusIcon"

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
function FocusResourceLine({ r }: { r: ResourceDTO }) {
  const label = r.custom_name || r.title || r.id
  return (
    <Group gap={6} wrap="nowrap" align="center">
      {/* Same mapping as the resource cards' titles: both read
          resourceStatusMeta, so an icon change lands in both places. */}
      <ResourceStatusIcon r={r} />
      <Text size="sm" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>{label}</Text>
    </Group>
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
    <Paper p="sm" withBorder {...interactive}>
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
    </Paper>
  )
}
