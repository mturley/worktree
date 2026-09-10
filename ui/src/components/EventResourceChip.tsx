import { Group, Text } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { ResourceStatusIcon, UnreadDot } from "./ResourceStatusIcon"
import { shortResourceRef } from "../lib/resourceRef"

/**
 * Names the resource an event belongs to, with its live status.
 *
 * Read-only: the row that contains it is itself the button that goes there,
 * and a button inside a button is invalid markup. Shared by the timeline row
 * and the details modal so the two cannot drift.
 */
export function EventResourceChip({ e, resolveResource }: {
  e: TimelineEvent
  /** Supplies the tracked resource, so the icon shows real status. */
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
}) {
  if (!e.resource_type || !e.resource_id) return null

  // The worktree page resolves against its own list (freshest, and already
  // loaded); the global timeline has no such list, so the event carries the
  // enriched resource itself.
  const resource = resolveResource?.(e.resource_type, e.resource_id) ?? e.resource
  const ref = shortResourceRef(e.resource_type, e.resource_id)
  const title = resource?.custom_name || resource?.title || e.resource_title
  // Falls back to a bare shape when the resource is not in the worktree's
  // list: the event still names it.
  const forIcon = resource
    ?? ({ type: e.resource_type, id: e.resource_id, url: e.resource_url, primary: false } as ResourceDTO)

  return (
    <Group
      gap={6}
      wrap="nowrap"
      style={{
        alignSelf: "flex-start",
        maxWidth: "100%",
        minWidth: 0,
        padding: "2px 8px",
        borderRadius: "var(--mantine-radius-sm)",
        border: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <UnreadDot r={forIcon} />
      <ResourceStatusIcon r={forIcon} />
      {ref && <Text size="xs" fw={600} style={{ whiteSpace: "nowrap" }}>{ref}</Text>}
      {title && <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>{title}</Text>}
    </Group>
  )
}
