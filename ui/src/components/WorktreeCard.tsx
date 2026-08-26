import { Anchor, Badge, Group, Paper, Stack, Text } from "@mantine/core"
import { relativeTime as rel } from "../lib/relativeTime"
import { useLocation } from "wouter"
import type { ResourceDTO, WorktreeSummary } from "../api/types"
import { resourceSummary } from "../lib/resourceSummary"
import { ResourceStatusIcon } from "./ResourceStatusIcon"
import { serializeResourceKey } from "../lib/resourceKey"

interface WorktreeCardProps {
  w: WorktreeSummary
  /**
   * When true (default) the card navigates to the worktree detail page.
   * The detail page renders the same card with clickable={false}, since we
   * are already there.
   */
  clickable?: boolean
}

function FocusResourceLine({ r, worktreePath }: { r: ResourceDTO; worktreePath: string }) {
  const [, navigate] = useLocation()
  const label = r.custom_name || r.title || r.id
  // Deep link into the worktree with this resource already selected, rather
  // than opening the resource itself. Selecting is the useful default, and a
  // mis-click no longer throws you into a new browser tab — the detail card's
  // "Open in …" is where you go to the resource itself.
  const href = `/worktree/${encodeURIComponent(worktreePath)}?resource=${serializeResourceKey({ type: r.type, id: r.id })}`
  return (
    <Group gap={6} wrap="nowrap" align="center">
      {/* Same mapping as the resource cards' titles: both read
          resourceStatusMeta, so an icon change lands in both places. */}
      <ResourceStatusIcon r={r} />
      <Anchor
        href={href}
        size="sm"
        // Stop the click reaching the card, which would navigate to the
        // worktree WITHOUT this resource selected.
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          navigate(href)
        }}
        style={{ overflowWrap: "anywhere" }}
      >
        {label}
      </Anchor>
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
        "aria-label": `worktree ${name}`,
        // Flags this card for the clickable surface + hover/focus styling in
        // styles/cards.css; absent when clickable={false} (detail-page header).
        "data-interactive": "true",
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
            // Still an <a> — that is what makes middle-click, copy-link and
            // "opens worktree X" announcements work — but deliberately NOT
            // link-STYLED: it inherits the body colour and never underlines,
            // because the whole card is the click target and a blue heading
            // implied the text was the only way in.
            <Anchor
              href={href}
              aria-label={`open worktree ${name}`}
              onClick={(e) => {
                e.preventDefault()
                // Stop the card's own handler from also firing (double nav).
                e.stopPropagation()
                go()
              }}
              c="inherit"
              underline="never"
              fw={700}
              size="md"
              style={{ overflowWrap: "anywhere" }}
            >
              {name}
            </Anchor>
          ) : (
            <Text fw={700} size="md" style={{ overflowWrap: "anywhere" }}>{name}</Text>
          )}
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
              <FocusResourceLine key={`${r.type}:${r.id}`} r={r} worktreePath={w.path} />
            ))}
          </Stack>
        )}
      </Stack>
    </Paper>
  )
}
