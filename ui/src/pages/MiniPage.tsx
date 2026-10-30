import { useEffect, useMemo, useState } from "react"
import { useLocation } from "wouter"
import { Badge, Box, Button, Group, Stack, Tabs } from "@mantine/core"
import type { ResourceDTO } from "../api/types"
import { useCmux } from "../api/cmux"
import { useActivityPanel } from "../components/ActivityPanel"
import { ChooseWorktreeModal } from "../components/ChooseWorktreeModal"
import { Logo } from "../components/Logo"
import { UnreadOnlyToggle } from "../components/UnreadOnlyToggle"
import { NarrowingContext } from "../components/search/NarrowingContext"
import { SearchBar } from "../components/search/SearchBar"
import { SearchContext } from "../components/search/SearchContext"
import { buildSuggestions } from "../components/search/suggestions"
import { TaskList } from "../components/tasks/TaskList"
import { TaskListToolbar } from "../components/tasks/TaskListToolbar"
import { useTaskModal } from "../components/tasks/modal/TaskModalProvider"
import { useResourcesView } from "../hooks/useResourcesView"
import { useSearchQuery } from "../hooks/useSearchQuery"
import { useSeeEverything } from "../hooks/useSeeEverything"
import { useTaskListPrefs } from "../hooks/useTaskListPrefs"
import { useTasks } from "../hooks/useTasks"
import { useUnreadOnly } from "../hooks/useUnreadOnly"
import { useUnreadOnlyHotkey } from "../hooks/useUnreadOnlyHotkey"
import { useWorktrees } from "../hooks/useWorktrees"
import { postToMac } from "../lib/macBridge"
import { openExternal } from "../lib/miniMode"
import { serializeResourceKey } from "../lib/resourceKey"
import { unreadBadge } from "../lib/unreadBadge"

type MiniTab = "tasks" | "activity"

/** Every task, with no context to link a new one to. */
const ALL_TASKS = { kind: "all" } as const

/**
 * The macOS menu bar app's view: a header with the search bar, then the
 * Activity and Tasks tabs (Activity first, the default), whose bar carries
 * the active tab's controls.
 *
 * The search is the home page's: the same `?q=` query (useSearchQuery), the
 * same suggestions, `/` to focus it. It narrows both tabs. Rows and
 * suggestions for an event or task open their details in place; a worktree
 * or resource opens the full UI, outside (see useMiniLocation). Esc clears
 * the search, Unreads only and the feed's filters, and does nothing else:
 * there is no page to step back out to here.
 *
 * Sized by the popover, so no fixed width.
 */
export function MiniPage() {
  const [, navigate] = useLocation()
  const [tab, setTab] = useState<MiniTab>("activity")
  const [unreadOnly, setUnreadOnly] = useUnreadOnly()
  useUnreadOnlyHotkey(unreadOnly, setUnreadOnly)
  const [prefs, setPrefs] = useTaskListPrefs()
  const { open: openTask } = useTaskModal()
  const search = useSearchQuery()
  const queryText = search.q.trim()
  const wts = useWorktrees()
  const cmux = useCmux()
  const activity = useActivityPanel({
    unreadOnly,
    search: { terms: search.terms, debouncedQ: search.debouncedQ, queryText },
    select: "details",
  })
  // For suggestions only: the Resources tab is the full UI's.
  const resourcesView = useResourcesView(unreadOnly, search.terms)
  // The same query (and cache entry) the Tasks tab's list uses.
  const tasks = useTasks(ALL_TASKS, { completed: prefs.showCompleted, archived: prefs.includeArchived })
  const { unread, count } = unreadBadge(wts.data)

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
    navigate(`/worktree/${encodeURIComponent(path)}?resource=${serializeResourceKey({ type: r.type, id: r.id })}`)

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
      task: openTask,
    },
  })

  const escClears = narrowing.search || narrowing.unread || narrowing.filters

  return (
    <NarrowingContext.Provider value={narrowing}><SearchContext.Provider value={searchContext}>
      <Stack p="xs" gap="xs" data-testid="mini-page">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Logo size={24} />
          <Box style={{ flex: 1, minWidth: 0 }}>
            <SearchBar
              value={search.q}
              onChange={search.setQ}
              placeholder="Search…"
              suggestions={suggestions}
              onEscape={narrowing.clearAll}
              escapeActive={escClears}
              fillWindow
            />
          </Box>
          <Group gap="sm" wrap="nowrap">
            <UnreadOnlyToggle value={unreadOnly} onChange={setUnreadOnly} hasUnread={unread} />
            <Button size="compact-xs" variant="default" onClick={() => openExternal("/")}>
              Open full UI ↗
            </Button>
          </Group>
        </Group>
        <Tabs value={tab} onChange={(v) => v && setTab(v as MiniTab)}>
          <Tabs.List>
            <Tabs.Tab value="activity">
              Activity
              {count > 0 && <Badge size="xs" variant="light" color="blue" ml={6}>{count}</Badge>}
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
