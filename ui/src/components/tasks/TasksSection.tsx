import { useEffect, type ReactNode } from "react"
import { Box, Group, Stack, Tabs, Text } from "@mantine/core"
import { useTasks, type TaskScope } from "../../hooks/useTasks"
import { useTaskListPrefs } from "../../hooks/useTaskListPrefs"
import { openCount } from "../../lib/taskSections"
import { TaskCountBadge } from "./TaskCountBadge"
import { TaskList } from "./TaskList"
import { TaskListToolbar } from "./TaskListToolbar"

/** The Tasks tab's value on every page that has one. */
export const TASKS_TAB = "tasks"

/** Rows a pinned list shows before it scrolls inside itself. */
const PINNED_ROWS = 8

/**
 * The tab a page should show: its own choice, except that a pinned list has
 * no Tasks tab, so "tasks" becomes `fallback`. For the render in which the
 * pin lands, before useTasksPlacement's effect has moved the page's state.
 */
export function tasksFallbackTab<T extends string>(tab: T, pinned: boolean, fallback: T): T {
  return pinned && tab === TASKS_TAB ? fallback : tab
}

/**
 * Where a page's task list goes: a Tasks tab (always the last one) or, while
 * the global pin is on, a lime panel above the page's tab bar. Every page
 * uses this, so the "tab or pinned" rule lives in one place.
 *
 * `active` tells it which tab the page shows: the tab's count hides while
 * Tasks is active, and a pin landing while it is calls `onFallback` (the
 * page then goes back to its first tab). Render with tasksFallbackTab too,
 * so the frame before that state change shows no empty panel.
 */
export function useTasksPlacement(
  scope: TaskScope,
  ownResource?: { type: string; id: string },
  active?: { activeTab?: string; onFallback?: () => void },
): {
  pinned: boolean
  tab: ReactNode | null
  tabPanelBody: ReactNode
  pinnedPanel: ReactNode
  toolbar: ReactNode
} {
  const [prefs, setPrefs] = useTaskListPrefs()
  const { pinned } = prefs
  // The same query (and cache entry) the list itself uses.
  const query = useTasks(scope, { completed: prefs.showCompleted, archived: prefs.includeArchived })
  const open = openCount(query.data ?? [])
  const tasksActive = active?.activeTab === TASKS_TAB

  const onFallback = active?.onFallback
  useEffect(() => {
    if (pinned && tasksActive) onFallback?.()
  }, [pinned, tasksActive, onFallback])

  const toolbar = (
    <TaskListToolbar
      prefs={prefs}
      onChange={setPrefs}
      pinned={pinned}
      onPinnedChange={(v) => setPrefs({ pinned: v })}
    />
  )

  const tab = pinned ? null : (
    <Tabs.Tab value={TASKS_TAB}>
      Tasks{!tasksActive && <TaskCountBadge count={open} ml="6px" />}
    </Tabs.Tab>
  )

  const pinnedPanel = pinned ? (
    <Box className="task-panel" p="xs" data-testid="pinned-tasks">
      <Stack gap={6}>
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Text size="sm" fw={700}>Tasks · {open} open</Text>
          {toolbar}
        </Group>
        <TaskList scope={scope} ownResource={ownResource} maxRows={PINNED_ROWS} />
      </Stack>
    </Box>
  ) : null

  return {
    pinned,
    tab,
    tabPanelBody: <TaskList scope={scope} ownResource={ownResource} />,
    pinnedPanel,
    toolbar,
  }
}
