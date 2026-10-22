import { Badge, Group, Text } from "@mantine/core"
import { IconChecklist } from "@tabler/icons-react"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { ResourceTypeLine } from "./ResourceTypeLine"
import { SearchHighlight } from "./search/SearchHighlight"

/**
 * Names the resource an event belongs to, with its live status: the same
 * type line (brand icon, badge, status icon, typed key) that introduces a
 * resource on its card, then its title.
 *
 * Read-only: the row that contains it is itself the button that goes there,
 * and a button inside a button is invalid markup. Shared by the timeline row
 * and the details modal so the two cannot drift.
 *
 * Carries no unread dot. The resource's unread state is a property of its
 * EVENTS, and this feed is showing them — each unread one is already boxed
 * in blue and marked. A second, coarser signal beside them said nothing the
 * rows did not, and said it on read events too.
 */
export function EventResourceChip({ e, resolveResource }: {
  e: TimelineEvent
  /** Supplies the tracked resource, so the icon shows real status. */
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
}) {
  if (!e.resource_type || !e.resource_id) return null

  // A task's own event: its pseudo-resource is the task, which has no
  // resource type line of its own. Named as one, in the task accent.
  if (e.resource_type === "task") {
    return (
      <Group gap={6} wrap="nowrap" align="center" data-resource-type-line>
        <IconChecklist size={14} color="var(--task-accent)" aria-hidden style={{ flexShrink: 0 }} />
        <Badge size="xs" variant="light" color="lime" mr={6} style={{ flex: "none" }}>Task</Badge>
        {e.resource_title && (
          <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <SearchHighlight text={e.resource_title} />
          </Text>
        )}
      </Group>
    )
  }

  // The worktree page resolves against its own list (freshest, and already
  // loaded); the global timeline has no such list, so the event carries the
  // enriched resource itself.
  const resource = resolveResource?.(e.resource_type, e.resource_id) ?? e.resource
  const title = resource?.custom_name || resource?.title || e.resource_title
  // Falls back to a bare shape when the resource is not in the worktree's
  // list: the event still names it. Nothing will ever fetch that shape, so it
  // must not wait on a fetch with a spinner.
  const forLine = resource
    ?? ({ type: e.resource_type, id: e.resource_id, url: e.resource_url, primary: false } as ResourceDTO)

  return (
    <ResourceTypeLine
      r={forLine}
      pending={resource ? undefined : false}
      trailing={title && (
        <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <SearchHighlight text={title} />
        </Text>
      )}
    />
  )
}
