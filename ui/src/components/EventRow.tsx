import { Badge, Box, Group, Stack, Text } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { relativeTime as rel } from "../lib/relativeTime"
import { eventMeta } from "../lib/eventMeta"
import { EventDot } from "./EventDot"
import { EventResourceChip } from "./EventResourceChip"
import { ROW_PAD_X } from "./timelineRail"

/**
 * One entry on the timeline rail: a dot on the line, then the event's text.
 *
 * The row is NOT one big button. The details area is a button, and the
 * resource chip beneath it is a second, separate button — nesting one inside
 * the other would be invalid markup and would make a click ambiguous.
 */
export function EventRow({ e, showWorktrees, onOpen, onSelectResource, resolveResource }: {
  e: TimelineEvent
  showWorktrees?: boolean
  onOpen?: (e: TimelineEvent) => void
  /** Selects the event's resource. Omit where selection has no meaning. */
  onSelectResource?: (key: { type: string; id: string }) => void
  /** Supplies the tracked resource, so the chip's icon shows real status. */
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
}) {
  const meta = eventMeta(e.type)
  const label = e.type_label || meta.label

  return (
    <Box style={{ display: "flex", gap: "var(--mantine-spacing-sm)", alignItems: "flex-start", padding: ROW_PAD_X }}>
      <EventDot type={e.type} label={label} />
      <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
        <Box
          component={onOpen ? "button" : "div"}
          type={onOpen ? "button" : undefined}
          onClick={onOpen ? () => onOpen(e) : undefined}
          data-interactive={onOpen ? "true" : undefined}
          style={{
            width: "100%", textAlign: "left", background: "transparent", border: 0,
            padding: 0, font: "inherit", color: "inherit", borderRadius: "var(--mantine-radius-sm)",
          }}
        >
          <Stack gap={2}>
            <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
              {/* The type label is its own element again, not only the dot's
                  tooltip: it is the fastest way to tell what happened, and a
                  colour alone does not say "review requested". */}
              <Badge size="sm" variant="light" color={meta.color}>{label}</Badge>
              <Text size="sm" fw={600} style={{ overflowWrap: "anywhere", minWidth: 0 }}>{e.title}</Text>
              <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                {e.author && `${e.author} · `}{rel(e.external_ts || e.ts)}
              </Text>
            </Group>
            {/* Without a select handler (the home page's global timeline)
                there is no chip, so the resource is named here instead —
                otherwise the event loses all trace of what it belongs to. */}
            {!onSelectResource && e.resource_title && (
              <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{e.resource_title}</Text>
            )}
            {e.body && <Text size="xs" c="dimmed" lineClamp={2} style={{ overflowWrap: "anywhere" }}>{e.body}</Text>}
            {showWorktrees && e.worktrees.length > 0 && (
              <Group gap={4}>{e.worktrees.map((w) => <Badge key={w} size="xs" variant="outline">{w}</Badge>)}</Group>
            )}
          </Stack>
        </Box>

        {onSelectResource && (
          <EventResourceChip e={e} onSelect={onSelectResource} resolveResource={resolveResource} />
        )}
      </Stack>
    </Box>
  )
}
