import { ActionIcon, Anchor, Group, Stack, Text, Title } from "@mantine/core"
import { IconX } from "@tabler/icons-react"
import type { TaskDetail, TaskEventLink, TimelineEvent } from "../../../api/types"
import { useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { EventRow } from "../../EventRow"
import { useSectionAction } from "./sectionAction"

/**
 * The row to show for a linked event: the live event while it still exists
 * with the same type, else one built from the snapshot taken when it was
 * linked. A snapshot carries no unread state and no worktrees.
 */
export function eventFromLink(link: TaskEventLink): TimelineEvent {
  if (link.live) return link.live
  const s = link.snapshot
  return {
    id: link.key,
    ts: s.ts,
    external_ts: "",
    source: s.source,
    type: s.type,
    type_label: "",
    title: s.title,
    body: s.body,
    author: s.author,
    resource_type: s.resource_type,
    resource_id: s.resource_id,
    resource_url: "",
    resource_title: "",
    worktrees: [],
  }
}

/**
 * "Linked events": each as an event row, with Open (the event's URL, in a
 * new tab) and unlink. The rows themselves go nowhere: EventRow is given no
 * onSelectResource, since navigating inside the app from the modal would
 * have to close it first (its close() undoes the open with history.back()).
 */
export function LinkedEventsSection({ task }: { task: TaskDetail }) {
  const m = useTaskDetailMutations(task.id)
  const { run, alert } = useSectionAction()

  return (
    <Stack gap={6}>
      <Title order={6}>Linked events</Title>
      {alert}
      {task.event_links.length === 0 ? (
        <Text size="sm" c="dimmed">No linked events.</Text>
      ) : (
        <Stack gap={2}>
          {task.event_links.map((link) => {
            const e = eventFromLink(link)
            const url = link.snapshot.url || link.live?.resource_url
            return (
              <Group key={link.key} gap={4} wrap="nowrap" align="flex-start">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <EventRow e={e} />
                </div>
                {url && (
                  <Anchor href={url} target="_blank" rel="noreferrer" size="xs" mt={8} style={{ flex: "none" }}>
                    Open
                  </Anchor>
                )}
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  mt={6}
                  aria-label={`Unlink event: ${e.title}`}
                  onClick={() => run(m.unlinkEvent(link.key))}
                >
                  <IconX size={14} />
                </ActionIcon>
              </Group>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}
