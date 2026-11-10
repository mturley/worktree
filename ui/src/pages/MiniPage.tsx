import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocation } from "wouter"
import { ActionIcon, Box, Button, Group, Stack, Tabs, Text, Tooltip } from "@mantine/core"
import { IconViewportNarrow, IconViewportWide } from "@tabler/icons-react"
import type { ResourceDTO } from "../api/types"
import { useCmux } from "../api/cmux"
import { useActivityPanel } from "../components/ActivityPanel"
import { ChooseWorktreeModal } from "../components/ChooseWorktreeModal"
import { Logo } from "../components/Logo"
import { UnreadBadge } from "../components/UnreadBadge"
import { NarrowingContext } from "../components/search/NarrowingContext"
import { SearchBar } from "../components/search/SearchBar"
import { KeyHint } from "../components/search/KeyHint"
import { SearchContext } from "../components/search/SearchContext"
import { buildSuggestions } from "../components/search/suggestions"
import { TaskList } from "../components/tasks/TaskList"
import { TaskListToolbar } from "../components/tasks/TaskListToolbar"
import { useMacDropdownView } from "../hooks/useMacDropdownView"
import { useResourcesView } from "../hooks/useResourcesView"
import { useSearchQuery } from "../hooks/useSearchQuery"
import { useSeeEverything } from "../hooks/useSeeEverything"
import { useTaskListPrefs } from "../hooks/useTaskListPrefs"
import { useTasks } from "../hooks/useTasks"
import { useUnreadOnly } from "../hooks/useUnreadOnly"
import { useUnreadOnlyHotkey } from "../hooks/useUnreadOnlyHotkey"
import { useWorktrees } from "../hooks/useWorktrees"
import { hasMacBridge, postToMac } from "../lib/macBridge"
import { readMiniExpanded, writeMiniExpanded } from "../lib/miniExpandedPref"
import { openExternal } from "../lib/miniMode"
import { resourceParam } from "../lib/resourceKey"
import { unreadBadge } from "../lib/unreadBadge"

type MiniTab = "tasks" | "activity"

/** Every task, with no context to link a new one to. */
const ALL_TASKS = { kind: "all" } as const

/** Keeps the expanded columns' headers level, whatever controls each one has. */
const COLUMN_HEADER_MIN_HEIGHT = 38

/** Switches between the tabs and the side-by-side columns. */
function ExpandToggle({ expanded, onChange }: { expanded: boolean; onChange: (expanded: boolean) => void }) {
  const label = expanded ? "Show Activity and Tasks as tabs" : "Show Activity and Tasks side by side"
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={label}
        onClick={() => onChange(!expanded)}
      >
        {expanded ? <IconViewportNarrow size={16} /> : <IconViewportWide size={16} />}
      </ActionIcon>
    </Tooltip>
  )
}

/** One expanded column: a header like the tab bar over its own scrolling body. */
function MiniColumn({ header, controls, children }: { header: ReactNode; controls: ReactNode; children: ReactNode }) {
  return (
    <Stack gap="xs" style={{ flex: "1 1 0", minWidth: 0, minHeight: 0 }}>
      <Group
        gap="xs"
        wrap="nowrap"
        style={{ minHeight: COLUMN_HEADER_MIN_HEIGHT, borderBottom: "1px solid var(--mantine-color-default-border)" }}
      >
        {header}
        <Group ml="auto" align="center" gap="sm" wrap="nowrap">{controls}</Group>
      </Group>
      <Box style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{children}</Box>
    </Stack>
  )
}

/**
 * The macOS menu bar app's view: a header with the search bar, then the
 * Activity and Tasks tabs (Activity first, the default), whose bar carries
 * the active tab's controls.
 *
 * The search is the home page's: the same `?q=` query (useSearchQuery), the
 * same suggestions, `/` to focus it. It narrows both tabs. Rows and
 * suggestions for an event or task open their details in place; a worktree
 * or resource opens the full UI, outside (see useMiniLocation). Esc closes
 * whatever is open (a modal, a menu, the suggestions), else clears the
 * search, Unreads only and the feed's filters; with none of that left it
 * goes back to the Activity tab, the main view (as the detail page's Notes
 * tab is), and only from there closes the dropdown itself (the app's
 * `close`, which its "Close dropdown on Esc" menu item can turn off), the
 * only step back out of here. The app never closes the dropdown on Esc by
 * itself.
 *
 * The toggle beside the logo swaps the tabs for columns showing both
 * at once, remembered per browser. The app remembers a dropdown size for each
 * of the two, widening it while a task is open (see useMacDropdownView). A
 * task's or an event's details fill a narrow dropdown and open windowed in a
 * wide one (see useMiniModalFullScreen).
 *
 * Sized by the popover, so no fixed width.
 */
export function MiniPage() {
  const [, navigate] = useLocation()
  const [tab, setTab] = useState<MiniTab>("activity")
  const [expanded, setExpandedState] = useState(readMiniExpanded)
  const setExpanded = (value: boolean) => {
    writeMiniExpanded(value)
    setExpandedState(value)
  }
  const [unreadOnly, setUnreadOnly] = useUnreadOnly()
  useUnreadOnlyHotkey(unreadOnly, setUnreadOnly)
  const [prefs, setPrefs] = useTaskListPrefs()
  const search = useSearchQuery()
  const queryText = search.q.trim()
  const wts = useWorktrees()
  const cmux = useCmux()
  const { unread, count } = unreadBadge(wts.data)
  const activity = useActivityPanel({
    unreadOnly,
    setUnreadOnly,
    hasUnread: unread,
    search: { terms: search.terms, debouncedQ: search.debouncedQ, queryText },
    select: "details",
  })
  // For suggestions only: the Resources tab is the full UI's.
  const resourcesView = useResourcesView(unreadOnly, search.terms)
  // The same query (and cache entry) the Tasks tab's list uses.
  const tasks = useTasks(ALL_TASKS, { completed: prefs.showCompleted, archived: prefs.includeArchived })
  useMacDropdownView(expanded)

  useEffect(() => postToMac({ type: "ready" }), [])

  // Every resource each worktree follows, for worktree suggestions' "via"
  // matches and the highlights that explain them.
  const resourcesByPath = useMemo(() => {
    const m = new Map<string, ResourceDTO[]>()
    for (const r of resourcesView.shown) {
      for (const w of r.worktrees) m.set(w.path, [...(m.get(w.path) ?? []), r])
    }
    return m
  }, [resourcesView.shown])
  const searchContext = useMemo(() => ({ terms: search.terms, resourcesByPath }), [search.terms, resourcesByPath])

  const everything = useSeeEverything()
  const narrowing = useMemo(() => ({
    search: search.terms.length > 0,
    unread: unreadOnly,
    filters: activity.filtered,
    clearAll: () => {
      everything.seeEverything()
      activity.clearFilters()
    },
  }), [search.terms, unreadOnly, activity.filtered, activity.clearFilters, everything])

  // A resource several worktrees follow asks which one, here; the choice
  // then opens in the full UI.
  const [choosing, setChoosing] = useState<{ r: ResourceDTO; worktrees: { path: string; branch: string }[] } | null>(null)
  const openResourceIn = (path: string, r: { type: string; id: string }) =>
    navigate(`/worktree/${encodeURIComponent(path)}?${resourceParam({ type: r.type, id: r.id })}`)

  const suggestions = buildSuggestions({
    terms: search.terms,
    worktrees: (wts.data ?? []).map((w) => ({
      w, workspaceTitles: (cmux.data?.available ? cmux.data.matches?.[w.path] ?? [] : []).map((m) => m.title),
      resources: resourcesByPath.get(w.path) ?? w.focus_resources,
    })),
    resources: resourcesView.shown.map((r) => ({ r, worktreePath: r.worktrees[0]?.path })),
    tasks: tasks.data ?? [],
    events: activity.events,
    go: {
      worktree: (p) => navigate(`/worktree/${encodeURIComponent(p)}`),
      resource: (r, p) => {
        const followers = resourcesView.shown.find((x) => x.type === r.type && x.id === r.id)?.worktrees ?? []
        if (followers.length > 1) setChoosing({ r, worktrees: followers })
        else if (p) openResourceIn(p, r)
      },
      event: activity.pickEvent,
      task: activity.pickTask,
    },
  })

  const escClears = narrowing.search || narrowing.unread || narrowing.filters
  const onTasksTab = !expanded && tab !== "activity"
  const escActivity = !escClears && onTasksTab
  const escapeIdle = () => {
    if (onTasksTab) setTab("activity")
    else if (hasMacBridge()) postToMac({ type: "close" })
  }

  return (
    <NarrowingContext.Provider value={narrowing}><SearchContext.Provider value={searchContext}>
      <Stack p="xs" gap="xs" data-testid="mini-page" h={expanded ? "100dvh" : undefined}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Logo size={24} />
          <ExpandToggle expanded={expanded} onChange={setExpanded} />
          <Box style={{ flex: 1, minWidth: 0 }}>
            <SearchBar
              value={search.q}
              onChange={search.setQ}
              placeholder="Search…"
              suggestions={suggestions}
              onEscape={narrowing.clearAll}
              escapeActive={escClears}
              onEscapeIdle={escapeIdle}
              fillWindow
            />
          </Box>
          <Group gap="sm" wrap="nowrap">
            {/* Unreads only is with the activity feed's other toggles. */}
            <Button size="compact-xs" variant="default" onClick={() => openExternal("/")}>
              Open full UI ↗
            </Button>
          </Group>
        </Group>
        {expanded ? (
          <Group gap="md" wrap="nowrap" align="stretch" style={{ flex: 1, minHeight: 0 }}>
            <MiniColumn
              header={(
                <>
                  <Text size="sm" fw={600}>Activity</Text>
                  <UnreadBadge unread={unread} count={count} />
                </>
              )}
              controls={activity.controls}
            >
              {activity.render(<></>)}
            </MiniColumn>
            <MiniColumn
              header={<Text size="sm" fw={600}>Tasks</Text>}
              controls={<TaskListToolbar prefs={prefs} onChange={setPrefs} />}
            >
              <TaskList scope={ALL_TASKS} />
            </MiniColumn>
          </Group>
        ) : (
        <Tabs value={tab} onChange={(v) => v && setTab(v as MiniTab)}>
          <Tabs.List>
            <Tabs.Tab
              value="activity"
              rightSection={escActivity ? <KeyHint decorative>Esc</KeyHint> : undefined}
            >
              Activity
              {/* The home page's worktree card badge. */}
              <UnreadBadge unread={unread} count={count} ml="6px" />
            </Tabs.Tab>
            <Tabs.Tab value="tasks">Tasks</Tabs.Tab>
            {/* The active tab's controls at the bar's far end, as on the
                home page's tab bar. */}
            <Group ml="auto" align="center" gap="sm" wrap="nowrap" pb={4}>
              {tab === "activity" ? activity.controls : <TaskListToolbar prefs={prefs} onChange={setPrefs} />}
            </Group>
          </Tabs.List>
          {/* An empty top: the controls are in the tab bar, not above the feed. */}
          <Tabs.Panel value="activity" pt="xs">{activity.render(<></>)}</Tabs.Panel>
          <Tabs.Panel value="tasks" pt="xs"><TaskList scope={ALL_TASKS} /></Tabs.Panel>
        </Tabs>
        )}
        {activity.modals}
        <ChooseWorktreeModal
          r={choosing?.r ?? null}
          worktrees={choosing?.worktrees ?? []}
          onPick={(path) => {
            const c = choosing
            setChoosing(null)
            if (c) openResourceIn(path, c.r)
          }}
          onClose={() => setChoosing(null)}
        />
      </Stack>
    </SearchContext.Provider></NarrowingContext.Provider>
  )
}
