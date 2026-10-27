import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useIsWide } from "../../hooks/useIsWide"
import { Anchor, Badge, Box, Group, Kbd, Paper, Stack, Text } from "@mantine/core"
import { SearchHighlight } from "./SearchHighlight"
import { KeyHint } from "./KeyHint"
import type { Suggestion, SuggestionItem } from "./SearchBar"
import { useCmuxMatches } from "../../api/cmux"
import { CmuxWorkspaceLabel } from "../CmuxWorkspaceSection"
import { ResourceCardBody } from "../ResourceCard"
import { EventRow } from "../EventRow"
import { worktreeName } from "../../lib/homeWorktree"
import type { Task, WorktreeSummary } from "../../api/types"
import type { SearchMatch } from "../../lib/search"
import { StateBox } from "../tasks/TaskStateCheckbox"
import { PRIORITY_MARK, PriorityGlyph } from "../tasks/TaskPriorityMenu"
import { WorktreeGlyph } from "../WorktreeGlyph"

/** The page's side gutter: --mantine-spacing-md, 16px with the theme's default scale. */
const GUTTER = 16
/** As wide as the bar allows when wide: the rows carry what the cards and feed do. */
const MAX_WIDTH = 640

/**
 * Where the dropdown goes, in px, its `left` relative to the bar it hangs
 * from. It always fits the window, keeping the gutter on both sides:
 *
 * - Phones: the full window width less the gutters, whatever the bar's
 *   position (it sits right of the logo).
 * - Otherwise: up to MAX_WIDTH, lined up with the bar when that fits, and
 *   shifted left just enough when it would run off the right edge — which
 *   happens on windows narrow but not narrow enough for the phone layout.
 */
export function fitDropdown({ barLeft, viewport, wide }: { barLeft: number; viewport: number; wide: boolean }): {
  left: number
  width: number
} {
  const room = Math.max(0, viewport - 2 * GUTTER)
  const width = wide ? Math.min(MAX_WIDTH, room) : room
  // Never past the right gutter, never past the left one.
  const left = Math.max(GUTTER - barLeft, Math.min(0, viewport - GUTTER - width - barLeft))
  return { left, width }
}

/**
 * The typeahead dropdown. An experiment: to remove it, delete this file,
 * suggestions.ts, and the `suggestions` prop wiring in SearchBar.
 *
 * Rows render things the way the rest of the UI does — a worktree under its
 * cmux workspace, a resource as the Resources tab lists it, an event as the
 * Activity feed shows it — but display only: picking the row navigates, so
 * nothing inside it may be a button or link of its own.
 */
export function SearchSuggestions({
  items, active, onHover, onPick, onViewAll,
}: {
  items: Suggestion[]
  active: number
  onHover: (i: number) => void
  onPick: (s: Suggestion) => void
  /** Closes the dropdown, leaving the filtered page. */
  onViewAll: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Keeps the keyboard's row in view as ↑/↓ walk a list taller than the box.
  // jsdom has no scrollIntoView.
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    el?.scrollIntoView?.({ block: "nearest" })
  }, [active])

  // The box hangs off the bar, so where it can go depends on where the bar
  // sits and how wide the window is: both measured, and again on resize.
  const wide = useIsWide()
  const boxRef = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ barLeft: 0, viewport: 0 })
  useLayoutEffect(() => {
    const measure = () => {
      const root = boxRef.current?.closest("[data-search-root]")
      setPlace({
        barLeft: root ? root.getBoundingClientRect().left : 0,
        // clientWidth, not innerWidth: the box must clear a scrollbar too.
        viewport: document.documentElement.clientWidth,
      })
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [])
  const fit = fitDropdown({ ...place, wide })

  const counts = new Map<string, number>()
  for (const s of items) counts.set(s.group, (counts.get(s.group) ?? 0) + 1)

  return (
    <Paper
      ref={boxRef}
      data-testid="search-suggestions"
      withBorder
      shadow="md"
      style={{
        position: "absolute", top: "100%", marginTop: 4,
        left: fit.left, width: fit.width,
        maxHeight: "70vh", display: "flex", flexDirection: "column", overflow: "hidden",
        zIndex: "var(--mantine-z-index-popover)",
      }}
    >
      {/* Outside the scrolling list, so it stays put and the section
          headings still pin to the list's own top. Shown with no results
          too: the page is still filtered, and View all results still goes
          there. */}
      <Group
        justify="space-between"
        wrap="nowrap"
        gap="sm"
        px="sm"
        py={6}
        style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      >
      <Text size="xs" c="dimmed">
        {"The page is also filtered as you type. "}
        <Anchor
          component="button"
          type="button"
          size="xs"
          // mousedown, as the rows: the input's blur must not close the list first.
          onMouseDown={(e) => { e.preventDefault(); onViewAll() }}
        >
          View all results
        </Anchor>
        {/* Enter only means this while no row is highlighted; with one, it
            picks that row. */}
        {active === -1 && <span data-testid="view-all-enter"> <KeyHint>↵</KeyHint></span>}
      </Text>
      {/* No rows, nothing to navigate. */}
      {items.length > 0 && (
        <Text size="xs" c="dimmed" data-testid="nav-hint" style={{ flex: "none", whiteSpace: "nowrap" }}>
          <KeyHint>↑</KeyHint>{" "}<KeyHint>↓</KeyHint>{" to navigate"}
        </Text>
      )}
      </Group>
      {items.length === 0 && (
        <Text size="sm" c="dimmed" px="sm" py="sm">Nothing matches your search</Text>
      )}
      <Box ref={ref} role="listbox" aria-label="Search suggestions" style={{ overflowY: "auto", minHeight: 0 }}>
      {items.map((s, i) => (
        <Box key={s.key}>
          {(i === 0 || items[i - 1].group !== s.group) && (
            <Group
              data-testid="suggestion-group"
              gap={6}
              px="sm"
              py={4}
              style={{
                // Stays on top while its section scrolls under it.
                position: "sticky", top: 0, zIndex: 1,
                background: "var(--mantine-color-default-hover)",
                borderTop: i ? "1px solid var(--mantine-color-default-border)" : undefined,
                borderBottom: "1px solid var(--mantine-color-default-border)",
              }}
            >
              <Text size="xs" tt="uppercase" fw={700} c="dimmed">{s.group}</Text>
              <Badge size="xs" variant="light" color="gray">{counts.get(s.group)}</Badge>
            </Group>
          )}
          <Box
            role="option"
            aria-selected={i === active}
            className={items[i - 1]?.group === s.group ? "linked-item" : undefined}
            px="sm"
            py={6}
            style={{
              cursor: "pointer",
              // The outline as well as the tint: an unread event row brings
              // its own tinted box, which hides a background alone.
              background: i === active ? "var(--mantine-color-blue-light)" : undefined,
              outline: i === active ? "2px solid var(--mantine-color-blue-filled)" : undefined,
              outlineOffset: -2,
            }}
            onMouseEnter={() => onHover(i)}
            // mousedown, so the input's blur doesn't close the list first.
            onMouseDown={(e) => { e.preventDefault(); onPick(s) }}
          >
            <Group wrap="nowrap" gap="sm" align="center">
              <Box style={{ flex: 1, minWidth: 0 }}>
                {s.item ? <SuggestionBody item={s.item} /> : <PlainBody s={s} />}
              </Box>
              {/* What Enter does here. Every row keeps the key's width, only
                  the highlighted one shows it, so moving the highlight never
                  reflows a row. */}
              <Kbd
                size="xs"
                data-testid={i === active ? "row-enter" : undefined}
                aria-hidden={i !== active || undefined}
                style={{ flex: "none", visibility: i === active ? "visible" : "hidden" }}
              >
                ↵
              </Kbd>
            </Group>
          </Box>
        </Box>
      ))}
      </Box>
    </Paper>
  )
}

function PlainBody({ s }: { s: Suggestion }) {
  return (
    <>
      <Text size="sm" lineClamp={1}><SearchHighlight text={s.label} /></Text>
      {s.detail && <Text size="xs" c="dimmed" lineClamp={1}><SearchHighlight text={s.detail} /></Text>}
    </>
  )
}

function SuggestionBody({ item }: { item: SuggestionItem }) {
  switch (item.kind) {
    case "worktree":
      return <WorktreeBody w={item.w} />
    case "resource":
      return <ResourceCardBody r={item.r} />
    case "event":
      // The global feed's form, which labels archived events.
      return <EventRow e={item.e} showWorktrees unreadBorder={false} />
    case "task":
      return <TaskBody t={item.t} match={item.match} />
  }
}

/**
 * A task as its row in the task panel reads, without the row's controls
 * (nothing in a suggestion is clickable but the suggestion): state box,
 * star, priority mark, title and id; then the description's hit, when that
 * is what matched.
 */
function TaskBody({ t, match }: { t: Task; match: SearchMatch | null }) {
  return (
    <Stack gap={2}>
      <Group gap={8} wrap="nowrap">
        <StateBox state={t.state} size={14} />
        {t.starred && <span aria-hidden style={{ color: "var(--task-accent)", flex: "none" }}>★</span>}
        {PRIORITY_MARK[t.priority] && <PriorityGlyph priority={t.priority} />}
        <Text
          size="sm"
          truncate="end"
          style={{ flex: 1, minWidth: 0, opacity: t.state === "done" ? 0.6 : 1 }}
          td={t.state === "done" ? "line-through" : undefined}
        >
          <SearchHighlight text={t.title} />
        </Text>
        <Text size="xs" c="dimmed" style={{ flex: "none" }}><SearchHighlight text={t.ref} /></Text>
      </Group>
      {match?.field === "description" && (
        <Text size="xs" c="dimmed" lineClamp={1}><SearchHighlight text={match.snippet} /></Text>
      )}
    </Stack>
  )
}

/** As a worktree card opens: its cmux workspace(s), then name and repo · branch. */
function WorktreeBody({ w }: { w: WorktreeSummary }) {
  const workspaces = useCmuxMatches(w.path)
  return (
    <Stack gap={4}>
      {workspaces.map((ws) => <CmuxWorkspaceLabel key={ws.ref} ws={ws} size="sm" />)}
      <Group gap="xs" wrap="nowrap">
        <Badge size="xs" color="blue" variant="light" style={{ flex: "none" }}>WORKTREE</Badge>
        <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
          <WorktreeGlyph />
          <span><SearchHighlight text={worktreeName(w.path)} /></span>
        </Text>
      </Group>
      <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
        <SearchHighlight text={[w.repo, w.branch].filter(Boolean).join(" · ")} />
      </Text>
    </Stack>
  )
}
