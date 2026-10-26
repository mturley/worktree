import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Box, Group, Stack, Text, UnstyledButton } from "@mantine/core"
import { IconChevronDown, IconChevronRight, IconChevronsDown } from "@tabler/icons-react"
import { useLocation } from "wouter"
import { useTasks, type TaskScope } from "../../hooks/useTasks"
import { useTaskListPrefs } from "../../hooks/useTaskListPrefs"
import { openCount } from "../../lib/taskSections"
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
 * - expanded: "Show all" lifted the cap. Never saved, and only for the path
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
 * Where the page pins a header (sticky, data-tooltip-layer="pinned"), render
 * `above(tabBar)` inside it rather than `panel` above it: the panel stays in
 * view with the tab bar, and its tooltips share the header's layer. The
 * normal cap keeps that header bounded; an expanded panel is not bounded, so
 * the page must drop the header's stickiness while `expanded`.
 *
 * Dropping it sends the header back to its place in the flow, which on a
 * scrolled page is far above the viewport. So when the panel expands and
 * its top has ended up above the visible area (its scroll container's, or
 * the viewport's below `opts.topInset`), it is scrolled back to the top of
 * it. `opts.topInset` is the height (px) of a sticky page header that would
 * cover it there; it becomes the panel's scroll-margin-top.
 */
export function useTasksPanel(
  scope: TaskScope,
  opts?: { ownResource?: { type: string; id: string }; unread?: number; resetKey?: string; topInset?: number },
): { panel: ReactNode; expanded: boolean; above: (bar: ReactNode) => ReactNode } {
  const [prefs, setPrefs] = useTaskListPrefs()
  const { collapsed } = prefs
  // The same query (and cache entry) the list itself uses.
  const query = useTasks(scope, { completed: prefs.showCompleted, archived: prefs.includeArchived })
  const open = openCount(query.data ?? [])
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

  // Keep an expanded panel in view: see the doc comment. Only on the change
  // to expanded, and only when it is out of view.
  const rootRef = useRef<HTMLDivElement>(null)
  const topInset = opts?.topInset ?? 0
  const wasExpanded = useRef(expanded)
  useLayoutEffect(() => {
    const became = expanded && !wasExpanded.current
    wasExpanded.current = expanded
    const el = rootRef.current
    if (!became || !el) return
    const scroller = scrollParent(el)
    const visibleTop = scroller ? scroller.getBoundingClientRect().top : topInset
    if (el.getBoundingClientRect().top < visibleTop) el.scrollIntoView({ block: "start" })
  }, [expanded, topInset])

  const toggleCollapsed = (next: boolean) => {
    if (next) setExpandedKey(null)
    setPrefs({ collapsed: next })
  }

  // One toggle on the left, the summary inside it, in both levels: the same
  // element stays mounted, so it keeps the focus across a toggle.
  // The summary cycles the levels: normal → expanded (Show all) → collapsed
  // → normal. A list that fits has nothing to show all of, so normal goes
  // straight to collapsed then.
  const [overflows, setOverflows] = useState(false)
  const toExpanded = !collapsed && !expanded && overflows
  const cycle = () => {
    if (collapsed) toggleCollapsed(false)
    else if (toExpanded) setExpandedKey(key)
    else toggleCollapsed(true)
  }
  const action = collapsed ? "Expand task list" : toExpanded ? "Show all tasks" : "Collapse task list"

  const toggle = (
    <UnstyledButton
      // Leads with what it does; the count and the dot are in here too, or a
      // screen reader would hear neither.
      aria-label={`${action} (${open} open${unread ? ", unread activity" : ""})`}
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
        <Text size="sm" fw={700}>Tasks ({scopeContext(scope)}){collapsed && ` · ${open} open`}</Text>
        {unread && <UnreadMarkerDot label="unread task activity" />}
      </Group>
    </UnstyledButton>
  )

  const panel = (
    <Box
      ref={rootRef}
      className="task-panel"
      p="xs"
      data-testid="tasks-panel"
      data-level={level}
      style={topInset > 0 ? { scrollMarginTop: topInset } : undefined}
    >
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

  return {
    panel,
    expanded,
    above: (bar) => (
      <Stack gap="sm">
        {panel}
        {bar}
      </Stack>
    ),
  }
}

/** The nearest ancestor that scrolls vertically, or null for the document. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if (overflowY === "auto" || overflowY === "scroll") return p
  }
  return null
}
