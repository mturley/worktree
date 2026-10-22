import { useCallback, useEffect, useMemo, type ReactNode } from "react"
import { Box, Group, Stack, Tabs, Text } from "@mantine/core"
import { useTasks, type TaskScope } from "../../hooks/useTasks"
import { useTaskListPrefs } from "../../hooks/useTaskListPrefs"
import { openCount } from "../../lib/taskSections"
import { TaskCountBadge } from "./TaskCountBadge"
import { TaskList } from "./TaskList"
import { TaskListToolbar } from "./TaskListToolbar"
import { UnreadMarkerDot } from "../UnreadMarkerDot"

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
 *
 * `active.unread` is the unread task events behind the list, for a page whose
 * other tabs cannot show them (a Slack thread's pane: its Thread tab is the
 * thread, not a feed holding task events). Above 0, an unread dot marks the
 * Tasks tab while it is not active, or the pinned panel's header.
 *
 * Where the page pins a header (sticky, data-tooltip-layer="pinned"), render
 * `pinnedAbove(tabBar)` inside it rather than `pinnedPanel` above it: the
 * panel then stays in view with the tab bar instead of scrolling away, and
 * its tooltips share the header's layer. Its row cap keeps the header bounded.
 */
export function useTasksPlacement(
  scope: TaskScope,
  ownResource?: { type: string; id: string },
  active?: { activeTab?: string; onFallback?: () => void; unread?: number },
): {
  pinned: boolean
  tab: ReactNode | null
  tabPanelBody: ReactNode
  pinnedPanel: ReactNode
  toolbar: ReactNode
  pinnedAbove: (bar: ReactNode) => ReactNode
} {
  const [prefs, setPrefs] = useTaskListPrefs()
  const { pinned } = prefs
  // The same query (and cache entry) the list itself uses.
  const query = useTasks(scope, { completed: prefs.showCompleted, archived: prefs.includeArchived })
  const open = openCount(query.data ?? [])
  const tasksActive = active?.activeTab === TASKS_TAB
  const unread = (active?.unread ?? 0) > 0
  const unreadDot = <UnreadMarkerDot label="unread task activity" />

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
    <Tabs.Tab value={TASKS_TAB} rightSection={unread && !tasksActive ? unreadDot : undefined}>
      Tasks{!tasksActive && <TaskCountBadge count={open} ml="6px" />}
    </Tabs.Tab>
  )

  const pinnedPanel = pinned ? (
    <Box className="task-panel" p="xs" data-testid="pinned-tasks">
      <Stack gap={6}>
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={700}>Tasks · {open} open</Text>
            {unread && unreadDot}
          </Group>
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
    pinnedAbove: (bar) =>
      pinnedPanel ? (
        <Stack gap="sm">
          {pinnedPanel}
          {bar}
        </Stack>
      ) : bar,
  }
}

/**
 * useTasksPlacement for a selected resource's pane, whose tab lives in the
 * URL (useResourceTab): the resource's own list, with its link chip
 * suppressed, falling back to `firstTab` when the pin lands on Tasks. The
 * fallback replaces the history entry: the user chose the pin, not the tab.
 * Returns the tab to render too (see tasksFallbackTab). `unread`: see
 * useTasksPlacement's `active.unread`.
 */
export function useResourceTasksPlacement(
  resource: { type: string; id: string },
  tab: string,
  setTab: (tab: string, opts?: { replace?: boolean }) => void,
  firstTab: string,
  unread?: number,
) {
  const { type, id } = resource
  const toFirst = useCallback(() => setTab(firstTab, { replace: true }), [setTab, firstTab])
  const scope = useMemo(() => ({ kind: "resource" as const, type, id }), [type, id])
  const own = useMemo(() => ({ type, id }), [type, id])
  const tasks = useTasksPlacement(scope, own, { activeTab: tab, onFallback: toFirst, unread })
  return { tasks, shownTab: tasksFallbackTab(tab, tasks.pinned, firstTab) }
}
