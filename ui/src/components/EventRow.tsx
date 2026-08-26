import { Badge, Box, Group, Stack, Text } from "@mantine/core"
import type { TimelineEvent } from "../api/types"
import { relativeTime as rel } from "../lib/relativeTime"
import { EventDot } from "./EventDot"

/**
 * One entry on the timeline rail: a dot on the line, then the event's text.
 *
 * The whole row is the click target for the details modal — the body is
 * clamped here to keep the feed scannable, so there has to be a way to read
 * the rest, and a row-sized target is easier to hit than an icon. It is a
 * <button> for keyboard and screen-reader access; the resource link that used
 * to live inside it moved to the modal, since a link nested in a button is
 * both invalid and ambiguous to click.
 */
export function EventRow({ e, showWorktrees, onOpen }: {
  e: TimelineEvent
  showWorktrees?: boolean
  onOpen?: (e: TimelineEvent) => void
}) {
  return (
    <Box
      component={onOpen ? "button" : "div"}
      type={onOpen ? "button" : undefined}
      onClick={onOpen ? () => onOpen(e) : undefined}
      data-interactive={onOpen ? "true" : undefined}
      style={{
        display: "flex",
        gap: "var(--mantine-spacing-sm)",
        alignItems: "flex-start",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: 0,
        padding: "var(--mantine-spacing-xs)",
        borderRadius: "var(--mantine-radius-sm)",
        font: "inherit",
        color: "inherit",
      }}
    >
      <EventDot type={e.type} label={e.type_label || e.type} />
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} style={{ overflowWrap: "anywhere", minWidth: 0 }}>{e.title}</Text>
          <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {e.author && `${e.author} · `}{rel(e.external_ts || e.ts)}
          </Text>
        </Group>
        {e.resource_title && (
          <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{e.resource_title}</Text>
        )}
        {e.body && <Text size="xs" c="dimmed" lineClamp={2} style={{ overflowWrap: "anywhere" }}>{e.body}</Text>}
        {showWorktrees && e.worktrees.length > 0 && (
          <Group gap={4}>{e.worktrees.map((w) => <Badge key={w} size="xs" variant="outline">{w}</Badge>)}</Group>
        )}
      </Stack>
    </Box>
  )
}
