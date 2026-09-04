import { Group, Text, UnstyledButton } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { ResourceStatusIcon, UnreadDot } from "./ResourceStatusIcon"
import { shortResourceRef } from "../lib/resourceRef"
import { hasUnread, UNREAD_COLOR } from "../lib/unread"

/**
 * Jumps to the resource an event belongs to — which filters the timeline to
 * it, or opens the thread for a Slack resource.
 *
 * Shared by the timeline row and the details modal so the two cannot drift:
 * the same chip, the same icon, the same behaviour in both places.
 */
export function EventResourceChip({ e, onSelect, resolveResource }: {
  e: TimelineEvent
  onSelect: (key: { type: string; id: string }) => void
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
  // list: the event still names it, and the chip still navigates.
  const forIcon = resource
    ?? ({ type: e.resource_type, id: e.resource_id, url: e.resource_url, primary: false } as ResourceDTO)

  return (
    <UnstyledButton
      onClick={() => onSelect({ type: e.resource_type, id: e.resource_id })}
      data-interactive="true"
      aria-label={`select resource ${e.resource_id}`}
      style={{
        alignSelf: "flex-start",
        maxWidth: "100%",
        padding: "2px 8px",
        borderRadius: "var(--mantine-radius-sm)",
        border: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
        <UnreadDot r={forIcon} />
        <ResourceStatusIcon r={forIcon} />
        {ref && <Text size="xs" fw={600} style={{ whiteSpace: "nowrap" }}>{ref}</Text>}
        {title && (
          <Text
            size="xs"
            // Dimmed is the resting state here, so unread is a jump from
            // grey to blue rather than a shade of the same colour.
            c={hasUnread(forIcon) ? UNREAD_COLOR : "dimmed"}
            lineClamp={1}
            style={{ minWidth: 0 }}
          >
            {title}
          </Text>
        )}
      </Group>
    </UnstyledButton>
  )
}
