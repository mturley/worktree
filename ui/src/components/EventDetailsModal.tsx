import { Anchor, Badge, Divider, Group, Modal, Stack, Text } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { eventMeta } from "../lib/eventMeta"
import { relativeTime as rel } from "../lib/relativeTime"
import { EventDot } from "./EventDot"
import { EventResourceChip } from "./EventResourceChip"

/**
 * Full detail for one timeline event.
 *
 * Exists because the row deliberately clamps the body to keep the feed
 * scannable, which left long comments unreadable in the UI — the text was
 * fetched and then thrown away. Here it is shown in full.
 */
export function EventDetailsModal({ e, onClose, onSelectResource, resolveResource }: {
  e: TimelineEvent | null
  onClose: () => void
  /** Selects the event's resource. Omit where selection has no meaning. */
  onSelectResource?: (key: { type: string; id: string }) => void
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
}) {
  const meta = e ? eventMeta(e.type) : null
  return (
    <Modal opened={!!e} onClose={onClose} size="lg" title={
      e && meta ? (
        <Group gap={8} wrap="nowrap">
          <EventDot type={e.type} label={e.type_label || e.type} />
          <Text fw={600} size="sm">{e.type_label || e.type}</Text>
        </Group>
      ) : null
    }>
      {e && (
        <Stack gap="sm">
          <Text fw={600} style={{ overflowWrap: "anywhere" }}>{e.title}</Text>
          <Text size="xs" c="dimmed">
            {e.author && `${e.author} · `}
            {rel(e.external_ts || e.ts)}
          </Text>

          {e.body && (
            <>
              <Divider />
              {/* Preserve the author's line breaks; this is comment text, not prose. */}
              <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {e.body}
              </Text>
            </>
          )}

          {(e.resource_title || e.resource_url || e.resource_id) && (
            <>
              <Divider />
              <Group gap="xs" wrap="wrap">
                {onSelectResource ? (
                  <EventResourceChip
                    e={e}
                    resolveResource={resolveResource}
                    // Close on select: the selection changes what is behind
                    // the modal, so staying open would hide the result.
                    onSelect={(key) => {
                      onSelectResource(key)
                      onClose()
                    }}
                  />
                ) : (
                  <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                    {e.resource_title || e.resource_id}
                  </Text>
                )}
                {e.resource_url && (
                  <Anchor href={e.resource_url} target="_blank" rel="noreferrer" size="sm">
                    Open
                  </Anchor>
                )}
              </Group>
            </>
          )}

          {e.worktrees.length > 0 && (
            <Group gap={4}>
              {e.worktrees.map((w) => <Badge key={w} size="xs" variant="outline">{w}</Badge>)}
            </Group>
          )}
        </Stack>
      )}
    </Modal>
  )
}
