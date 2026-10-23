import { useState } from "react"
import { ActionIcon, Alert, Button, Center, Group, Loader, Stack, Text, Tooltip } from "@mantine/core"
import { IconLink, IconLinkOff } from "@tabler/icons-react"
import type { TaskDetail, TimelineEvent } from "../../../api/types"
import { type ActivityQuery, useTaskActivity, useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { eventTaskKey } from "../../../lib/taskEventKey"
import { EventRow } from "../../EventRow"
import { useSectionAction } from "./sectionAction"

interface Pill {
  value: string
  label: string
  query: ActivityQuery
}

const FIXED: Pill[] = [
  { value: "all", label: "Everything", query: { filter: "all" } },
  { value: "task", label: "This task only", query: { filter: "task" } },
  { value: "linked", label: "Linked events", query: { filter: "linked" } },
]

/** One pill per linked resource; worktrees have no activity of their own. */
function resourcePills(task: TaskDetail): Pill[] {
  return task.detail_links.flatMap((l) =>
    l.kind === "resource" && l.resource_type && l.resource_id
      ? [{
          value: `res:${l.resource_type}:${l.resource_id}`,
          label: l.title || l.resource_id,
          query: { filter: "resource" as const, type: l.resource_type, rid: l.resource_id },
        }]
      : [],
  )
}

/**
 * The Activity tab: the task's own events merged with its linked resources'
 * events, newest first, narrowed by the filter pills. Each resource event
 * has a link toggle. The rows are inert, as on the Details tab: navigating
 * in the app from inside the modal would have to close it first (its
 * close() undoes the open with history.back()).
 */
export function ActivityTab({ task }: { task: TaskDetail }) {
  const pills = [...FIXED, ...resourcePills(task)]
  const [picked, setPicked] = useState("all")
  // A resource unlinked while its pill is picked falls back to Everything,
  // rather than asking for a resource the server would refuse (404).
  const active = pills.find((p) => p.value === picked) ?? FIXED[0]
  const activity = useTaskActivity(task.id, active.query)
  const m = useTaskDetailMutations(task.id)
  const { run, alert } = useSectionAction()

  /**
   * The key a toggle acts on. A linked row unlinks by the key the server says
   * it is linked under (linked_key: a Slack message's slack: key, another
   * event's ev: key, or a snapshot row's own key). An unlinked watcher event
   * links by its ev: key, and the server stores a Slack message's under its
   * slack: key.
   */
  const toggleKey = (e: TimelineEvent): string | null =>
    e.linked_to_task ? e.linked_key || null : eventTaskKey(e)

  const toggle = (e: TimelineEvent) => {
    const key = toggleKey(e)
    if (!key) return
    run(e.linked_to_task ? m.unlinkEvent(key) : m.linkEvent(key))
  }

  return (
    <Stack gap="sm">
      <Group gap={6} wrap="wrap">
        {pills.map((p) => (
          <Button
            key={p.value}
            size="compact-xs"
            radius="xl"
            variant={p.value === active.value ? "filled" : "default"}
            aria-pressed={p.value === active.value}
            onClick={() => setPicked(p.value)}
            style={{ maxWidth: 220 }}
          >
            {p.label}
          </Button>
        ))}
      </Group>
      {alert}
      {activity.isPending ? (
        <Center py="md"><Loader size="sm" /></Center>
      ) : activity.isError ? (
        <Alert color="red" variant="light" py={6}>
          <Text size="xs">Couldn't load activity: {activity.error instanceof Error ? activity.error.message : "the request failed"}</Text>
        </Alert>
      ) : activity.data.length === 0 ? (
        <Text size="sm" c="dimmed">No activity.</Text>
      ) : (
        <Stack gap={2}>
          {activity.data.map((e) => {
            const linkable = toggleKey(e) !== null
            const linked = !!e.linked_to_task
            const label = `${linked ? "Unlink" : "Link"} event: ${e.title}`
            return (
              <Group key={e.id} gap={4} wrap="nowrap" align="flex-start">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <EventRow e={e} showResource={active.query.filter !== "resource"} />
                </div>
                {linkable && (
                  <Tooltip label={linked ? "Unlink from this task" : "Link to this task"}>
                    <ActionIcon
                      variant={linked ? "light" : "subtle"}
                      color={linked ? "blue" : "gray"}
                      size="sm"
                      mt={6}
                      aria-label={label}
                      aria-pressed={linked}
                      onClick={() => toggle(e)}
                    >
                      {linked ? <IconLinkOff size={14} /> : <IconLink size={14} />}
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}
