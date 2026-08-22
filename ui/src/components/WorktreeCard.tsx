import { Anchor, Badge, Group, Paper, Stack, Text } from "@mantine/core"
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

function FocusResourceLine({ r }: { r: ResourceDTO }) {
  const label = r.custom_name || r.title || r.id
  return (
    <Group gap={6} wrap="nowrap" align="center">
      <ResourceStatusIcon r={r} />
      {r.url ? (
        <Anchor
          href={r.url}
          target="_blank"
          rel="noreferrer"
          size="sm"
          // Stop the click reaching the card, so a resource link opens the
          // resource instead of navigating to the worktree.
          onClick={(e) => e.stopPropagation()}
          style={{ overflowWrap: "anywhere" }}
        >
          {label}
        </Anchor>
      ) : (
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>{label}</Text>
      )}
    </Group>
  )
}

export function WorktreeCard({ w, clickable = true }: WorktreeCardProps) {
  const [, navigate] = useLocation()
  const href = `/worktree/${encodeURIComponent(w.path)}`
  const summary = resourceSummary(w.primary_by_type, w.related_count)

  const go = () => navigate(href)

  // The whole card is the click target (spec: "clicking elsewhere on the card
  // should navigate to the worktree detail page"), while resource links keep
  // their own behaviour by stopping propagation. The branch name stays a real
  // anchor so the destination is announced and middle-click/copy-link work;
  // the card itself is a focusable group with an Enter/Space handler so the
  // same action is reachable from the keyboard.
  const interactive = clickable
    ? {
        role: "group",
        "aria-label": `worktree ${w.branch}`,
        tabIndex: 0,
        onClick: go,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            go()
          }
        },
        style: { cursor: "pointer" },
      }
    : {}

  return (
    <Paper p="sm" withBorder {...interactive}>
      <Stack gap={6}>
        <Group gap="xs" wrap="wrap">
          {clickable ? (
            <Anchor
              href={href}
              aria-label={`open worktree ${w.branch}`}
              onClick={(e) => {
                e.preventDefault()
                // Stop the card's own handler from also firing (double nav).
                e.stopPropagation()
                go()
              }}
              fw={600}
              size="sm"
              style={{ overflowWrap: "anywhere" }}
            >
              {w.branch}
            </Anchor>
          ) : (
            <Text fw={600} size="sm" style={{ overflowWrap: "anywhere" }}>{w.branch}</Text>
          )}
          {!w.on_disk && <Badge size="xs" color="red">missing</Badge>}
        </Group>
        <Text size="xs" c="dimmed">
          {w.repo}{summary ? ` · ${summary}` : ""}
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
