import { useEffect, useRef } from "react"
import { Badge, Box, Group, Paper, Stack, Text } from "@mantine/core"
import { SearchHighlight } from "./SearchHighlight"
import type { Suggestion, SuggestionItem } from "./SearchBar"
import { useCmuxMatches } from "../../api/cmux"
import { CmuxWorkspaceLabel } from "../CmuxWorkspaceSection"
import { ResourceCardBody } from "../ResourceCard"
import { EventRow } from "../EventRow"
import { worktreeName } from "../../lib/homeWorktree"
import type { WorktreeSummary } from "../../api/types"

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
  items, active, onHover, onPick,
}: { items: Suggestion[]; active: number; onHover: (i: number) => void; onPick: (s: Suggestion) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // Keeps the keyboard's row in view as ↑/↓ walk a list taller than the box.
  // jsdom has no scrollIntoView.
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    el?.scrollIntoView?.({ block: "nearest" })
  }, [active])

  const counts = new Map<string, number>()
  for (const s of items) counts.set(s.group, (counts.get(s.group) ?? 0) + 1)

  return (
    <Paper
      withBorder
      shadow="md"
      style={{
        position: "absolute", top: "100%", left: 0, marginTop: 4,
        // Wider than the bar: the rows carry what the cards and feed do.
        width: "min(640px, calc(100vw - 2 * var(--mantine-spacing-md)))",
        maxHeight: "70vh", display: "flex", flexDirection: "column", overflow: "hidden",
        zIndex: "var(--mantine-z-index-popover)",
      }}
    >
      {/* Outside the scrolling list, so it stays put and the section
          headings still pin to the list's own top. */}
      <Text size="xs" c="dimmed" px="sm" py={6} style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
        The page is also filtered as you type. Press Enter to view all results.
      </Text>
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
            {s.item ? <SuggestionBody item={s.item} /> : <PlainBody s={s} />}
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
      return <EventRow e={item.e} showWorktrees />
  }
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
          <SearchHighlight text={worktreeName(w.path)} />
        </Text>
      </Group>
      <Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
        <SearchHighlight text={[w.repo, w.branch].filter(Boolean).join(" · ")} />
      </Text>
    </Stack>
  )
}
