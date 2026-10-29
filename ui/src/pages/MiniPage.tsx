import { useEffect, useState } from "react"
import { Badge, Button, Group, Stack, Tabs } from "@mantine/core"
import { useActivityPanel } from "../components/ActivityPanel"
import { Logo } from "../components/Logo"
import { UnreadOnlyToggle } from "../components/UnreadOnlyToggle"
import { TaskList } from "../components/tasks/TaskList"
import { TaskListToolbar } from "../components/tasks/TaskListToolbar"
import { useTaskListPrefs } from "../hooks/useTaskListPrefs"
import { useUnreadOnly } from "../hooks/useUnreadOnly"
import { useWorktrees } from "../hooks/useWorktrees"
import { postToMac } from "../lib/macBridge"
import { openExternal } from "../lib/miniMode"
import { unreadBadge } from "../lib/unreadBadge"

type MiniTab = "tasks" | "activity"

/** Every task, with no context to link a new one to. */
const ALL_TASKS = { kind: "all" } as const

/**
 * The macOS menu bar app's view: a slim header, then Tasks and Activity.
 * Rows open their details in place; anything bound for the full UI opens
 * outside (see useMiniLocation). Sized by the popover, so no fixed width.
 */
export function MiniPage() {
  const [tab, setTab] = useState<MiniTab>("activity")
  const [unreadOnly, setUnreadOnly] = useUnreadOnly()
  const [prefs, setPrefs] = useTaskListPrefs()
  const wts = useWorktrees()
  const activity = useActivityPanel({ unreadOnly, select: "details" })
  const { unread, count } = unreadBadge(wts.data)

  useEffect(() => postToMac({ type: "ready" }), [])

  return (
    <Stack p="xs" gap="xs" data-testid="mini-page">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Logo size={24} />
        <Group gap="sm" wrap="nowrap">
          <UnreadOnlyToggle value={unreadOnly} onChange={setUnreadOnly} hasUnread={unread} />
          <Button size="compact-xs" variant="default" onClick={() => openExternal("/")}>
            Open full UI ↗
          </Button>
        </Group>
      </Group>
      <Tabs value={tab} onChange={(v) => v && setTab(v as MiniTab)}>
        <Tabs.List>
          <Tabs.Tab value="tasks">Tasks</Tabs.Tab>
          <Tabs.Tab value="activity">
            Activity
            {count > 0 && <Badge size="xs" variant="light" color="blue" ml={6}>{count}</Badge>}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="tasks" pt="xs">
          <Stack gap="xs">
            <TaskListToolbar prefs={prefs} onChange={setPrefs} />
            <TaskList scope={ALL_TASKS} />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="activity" pt="xs">{activity.render(activity.controls)}</Tabs.Panel>
      </Tabs>
      {activity.modals}
    </Stack>
  )
}
