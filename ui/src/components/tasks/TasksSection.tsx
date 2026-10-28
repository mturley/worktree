import { useState, type ReactNode } from "react"
import { Box, Group, Stack, Text, UnstyledButton } from "@mantine/core"
import { IconChevronDown, IconChevronRight, IconChevronsDown } from "@tabler/icons-react"
import { useLocation } from "wouter"
import type { Task } from "../../api/types"
import { useTasks, type TaskScope } from "../../hooks/useTasks"
import { useIsWide } from "../../hooks/useIsWide"
import { useTaskListPrefs } from "../../hooks/useTaskListPrefs"
import { openSummary } from "../../lib/taskSections"
import { TaskList } from "./TaskList"
import { TaskListToolbar } from "./TaskListToolbar"
import { UnreadMarkerDot } from "../UnreadMarkerDot"

/** Rows the normal panel shows before its list scrolls inside itself. */
const NORMAL_ROWS = 8

export type TasksPanelLevel = "collapsed" | "normal" | "expanded"

/** What a resource type is called in the panel's summary. */
const RESOURCE_NOUN: Record<string, string> = { pr: "PR", jira: "issue", slack: "thread", link: "link" }

/** Which tasks the panel lists, for its summary: "all", "this worktree", "this PR"… */
export function scopeContext(scope: TaskScope): string {
  switch (scope.kind) {
    case "all":
      return "all"
    case "worktree":
      return "this worktree"
    case "resource":
      return `this ${RESOURCE_NOUN[scope.type] ?? "resource"}`
  }
}

/**
 * The task panel every page shows above its tab bar: the list for `scope`,
 * at one of three levels.
 *
 * - normal (the default): the count, the toolbar, and the list capped at
 *   NORMAL_ROWS (and a quarter of the viewport), with "Show all" under it
 *   when it overflows.
 * - collapsed: one line, the count and a chevron, that expands back to
 *   normal. ONE global saved choice (useTaskListPrefs' `collapsed`).
 * - expanded: "Show all" lifted the cap, and (wide) the page gives the
 *   panel's column two thirds of the width; a wide list that fits can be
 *   expanded from the summary just for that. Never saved, and only for the path
 *   and scope it was set under: navigating to another path or changing scope
 *   (another resource selected on the same page) puts the panel back to
 *   normal. A tab change does not: tabs live in the query string.
 *
 * `opts.unread` is the unread task events behind the list, for a page whose
 * other tabs cannot show them (a Slack thread's pane); above 0 an unread dot
 * sits by the count, at every level.
 *
 * `opts.resetKey` is anything else that should put an expanded panel back
 * to normal, for a page whose hook outlives its panel: the worktree page
 * passes its selected resource, since selecting one swaps its panel for the
 * resource pane's while the worktree's own path and scope stay the same.
 *
 * Pages render `panel` in their normal flow, ABOVE (never inside) the
 * sticky block that pins their tab bar: the panel scrolls away with the
 * content, and the tab bar sticks once it is scrolled to. So no level, not
 * even an uncapped expanded list, can fill the screen from a pinned header.
 */
export function useTasksPanel(
  scope: TaskScope,
  opts?: { ownResource?: { type: string; id: string }; unread?: number; resetKey?: string },
): { panel: ReactNode; expanded: boolean; tasks: Task[] } {
  const [prefs, setPrefs] = useTaskListPrefs()
  const { collapsed } = prefs
  // The same query (and cache entry) the list itself uses.
  const query = useTasks(scope, { completed: prefs.showCompleted, archived: prefs.includeArchived })
  const open = openSummary(query.data ?? [])
  const unread = (opts?.unread ?? 0) > 0
  const [location] = useLocation()

  // Expanded is the key it was set under: once path, scope or resetKey moves
  // on, the key no longer matches and the panel is normal again, without an
  // effect. A stale key is dropped as soon as it is seen (React's "adjust
  // state while rendering"), so coming back to the old key stays normal; so
  // is any key while collapsed, so a collapse from another browser tab
  // un-collapses to normal.
  const key = `${location}|${JSON.stringify(scope)}|${opts?.resetKey ?? ""}`
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  if (expandedKey !== null && (collapsed || expandedKey !== key)) setExpandedKey(null)
  const expanded = !collapsed && expandedKey === key
  const level: TasksPanelLevel = collapsed ? "collapsed" : expanded ? "expanded" : "normal"

  const toggleCollapsed = (next: boolean) => {
    if (next) setExpandedKey(null)
    setPrefs({ collapsed: next })
  }

  // One toggle on the left, the summary inside it, in both levels: the same
  // element stays mounted, so it keeps the focus across a toggle.
  // The summary cycles the levels: normal → expanded (Show all) → collapsed
  // → normal. Wide, expanded also widens the panel's column (the pages
  // split 4/8), which a list that fits still gains from — long titles — so
  // it is always offered there ("Widen task list"). Narrow, a list that fits
  // has nothing to show all of, so normal goes straight to collapsed.
  const [overflows, setOverflows] = useState(false)
  const wide = useIsWide()
  const toExpanded = !collapsed && !expanded && (overflows || wide)
  const cycle = () => {
    if (collapsed) toggleCollapsed(false)
    else if (toExpanded) setExpandedKey(key)
    else toggleCollapsed(true)
  }
  const action = collapsed
    ? "Expand task list"
    : toExpanded
      ? (overflows ? "Show all tasks" : "Widen task list")
      : "Collapse task list"

  const toggle = (
    <UnstyledButton
      // Leads with what it does; the count and the dot are in here too, or a
      // screen reader would hear neither.
      aria-label={`${action} (${open}${unread ? ", unread activity" : ""})`}
      aria-expanded={!collapsed}
      onClick={cycle}
      className="task-panel-toggle"
      // A big target: it fills the header up to the toolbar, and reaches
      // into the panel's padding (negative margin, matching padding) without
      // moving what it shows.
      style={{
        flex: "1 1 auto",
        alignSelf: "stretch",
        // Collapsed, it is the whole bar, to every edge of the panel. Open,
        // it is short vertically (4px), so its hover doesn't fill the
        // panel's top padding, and stops at the toolbar.
        ...(collapsed
          ? { margin: "calc(-1 * var(--mantine-spacing-xs))", padding: "var(--mantine-spacing-xs)" }
          : {
              margin: "-4px 0 -4px calc(-1 * var(--mantine-spacing-xs))",
              padding: "4px 0 4px var(--mantine-spacing-xs)",
            }),
        borderRadius: "var(--mantine-radius-md)",
      }}
    >
      <Group gap={6} wrap="nowrap">
        {collapsed ? <IconChevronRight size={16} /> : expanded ? <IconChevronsDown size={16} /> : <IconChevronDown size={16} />}
        <Text size="sm" fw={700}>Tasks ({scopeContext(scope)}){collapsed && ` · ${open}`}</Text>
        {unread && <UnreadMarkerDot label="unread task activity" />}
      </Group>
    </UnstyledButton>
  )

  const panel = (
    <Box className="task-panel" p="xs" data-testid="tasks-panel" data-level={level}>
      <Stack gap={6}>
        <Group gap="md" wrap="wrap">
          {toggle}
          {!collapsed && <Box ml="auto"><TaskListToolbar prefs={prefs} onChange={setPrefs} /></Box>}
        </Group>
        {!collapsed && (
          <TaskList
            scope={scope}
            ownResource={opts?.ownResource}
            maxRows={NORMAL_ROWS}
            expand={{ expanded, onToggle: () => setExpandedKey(expanded ? null : key), onOverflow: setOverflows }}
          />
        )}
      </Stack>
    </Box>
  )

  // The tasks the panel lists, for the page's search suggestions.
  return { panel, expanded, tasks: query.data ?? [] }
}
