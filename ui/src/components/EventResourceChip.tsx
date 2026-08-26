import { Group, Text, UnstyledButton } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { ResourceStatusIcon } from "./ResourceStatusIcon"

/**
 * A short reference for a resource: "#42" for a PR, the key for a Jira issue.
 * Slack ids are channel:ts pairs with nothing human-readable in them, so they
 * get no reference and lean on the title instead.
 */
export function shortResourceRef(type: string, id: string): string {
  if (type === "pr") {
    const hash = id.lastIndexOf("#")
    return hash >= 0 ? id.slice(hash) : id
  }
  if (type === "jira") return id
  return ""
}

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

  const resource = resolveResource?.(e.resource_type, e.resource_id)
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
        <ResourceStatusIcon r={forIcon} />
        {ref && <Text size="xs" fw={600} style={{ whiteSpace: "nowrap" }}>{ref}</Text>}
        {title && <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>{title}</Text>}
      </Group>
    </UnstyledButton>
  )
}
