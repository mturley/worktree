import { Anchor, Badge, Divider, Group, Modal, Stack, Text } from "@mantine/core"
import type { ResourceDTO, TimelineEvent } from "../api/types"
import { eventLabel } from "../lib/eventMeta"
import { relativeTime as rel } from "../lib/relativeTime"
import { EventDot } from "./EventDot"
import { EventResourceChip } from "./EventResourceChip"
import { openLabel } from "./ResourceActions"

/**
 * Full detail for one timeline event.
 *
 * Exists because the row deliberately clamps the body to keep the feed
 * scannable, which left long comments unreadable in the UI — the text was
 * fetched and then thrown away. Here it is shown in full.
 */
export function EventDetailsModal({ e, onClose, resolveResource }: {
  e: TimelineEvent | null
  onClose: () => void
  resolveResource?: (type: string, id: string) => ResourceDTO | undefined
}) {
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
          {(e.resource_type || e.worktrees.length > 0 || e.resource_url) && (
            <Group gap="xs" wrap="wrap">
              <EventResourceChip e={e} resolveResource={resolveResource} />

              {e.worktrees.map((w) => (
                <Badge key={w} size="sm" color="blue" variant="light">{w}</Badge>
              ))}

              {e.resource_url && (
                <Anchor href={e.resource_url} target="_blank" rel="noreferrer" size="sm">
                  {/* Same wording as the resource card's button — "Open" alone
                      did not say where it went. */}
                  {openLabel(e.resource_type)}
                </Anchor>
              )}
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
