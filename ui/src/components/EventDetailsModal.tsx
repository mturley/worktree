import { Badge, Divider, Group, Modal, Stack, Text } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { eventLabel } from "../lib/eventMeta"
import { relativeTime as rel } from "../lib/relativeTime"
import { EventDot } from "./EventDot"
import { EventResourceChip } from "./EventResourceChip"
import { ResourceActions } from "./ResourceActions"

/**
 * Full detail for one timeline event.
 *
 * Exists because the row deliberately clamps the body to keep the feed
 * scannable, which left long comments unreadable in the UI — the text was
 * fetched and then thrown away. Here it is shown in full.
 */
export function EventDetailsModal({ e, onClose, resolveResource, path }: {
  e: TimelineEvent | null
  onClose: () => void
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
  /**
   * The worktree this modal is shown in, so a cmux tab in ITS workspace is
   * preferred by the open button. Defaults to the first worktree following
   * the event.
   */
  path?: string
}) {
  const actionResource = e?.resource_url ? eventResource(e, resolveResource) : undefined

  return (
    <Modal opened={!!e} onClose={onClose} size="lg" title={
      e ? (
        <Group gap={8} wrap="nowrap">
          <EventDot type={e.type} label={e.type_label} />
          <Text fw={600} size="sm">{eventLabel(e.type, e.type_label)}</Text>
        </Group>
      ) : null
    }>
      {e && (
        <Stack gap="sm">
          {/*
            Context first: which resource this event is about, and which
            worktrees follow it. Both are read-only labels — the row that
            opened this modal is itself the way to the resource — but they
            still sit ahead of the content, so you do not have to scroll past
            a long comment to find out what you are reading about.
          */}
          {(e.resource_type || actionResource) && (
            <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
              <div style={{ flex: 1, minWidth: 0 }}>
                <EventResourceChip e={e} resolveResource={resolveResource} />
              </div>
              {/* The resource card's own control, so an already-open cmux tab
                  is offered here exactly as it is there. */}
              {actionResource && <ResourceActions r={actionResource} path={path ?? e.worktree_paths?.[0]} />}
            </Group>
          )}

          {e.worktrees.length > 0 && (
            <Group gap={6} wrap="wrap">
              {e.worktrees.map((w) => (
                // Worded as on the activity feed's rows.
                <Badge key={w} size="sm" color="blue" variant="light">Worktree: {w}</Badge>
              ))}
            </Group>
          )}

          <Divider />

          <Text fw={600} style={{ overflowWrap: "anywhere" }}>{e.title}</Text>
          <Text size="xs" c="dimmed">
            {e.author && `${e.author} · `}
            {rel(e.external_ts || e.ts)}
          </Text>

          {e.body && (
            // Preserve the author's line breaks; this is comment text, not prose.
            <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {e.body}
            </Text>
          )}
        </Stack>
      )}
    </Modal>
  )
}

/**
 * The resource to hand ResourceActions: the tracked one where known, else a
 * bare shape built from the event, which carries everything the buttons use.
 */
function eventResource(
  e: TimelineEvent,
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined,
): ResourceDTO {
  const known = e.resource_type && e.resource_id
    ? resolveResource?.(e.resource_type, e.resource_id) ?? e.resource
    : undefined
  return known ?? ({ type: e.resource_type, id: e.resource_id, url: e.resource_url, primary: false } as ResourceDTO)
}
