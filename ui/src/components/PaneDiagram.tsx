import { ActionIcon, Box, Button, Group, Popover, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core"
import { IconFile, IconMarkdown, IconTerminal2, IconWorld, IconX } from "@tabler/icons-react"
import { useState, type CSSProperties, type ReactNode } from "react"
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { CmuxLayout, CmuxMove, CmuxPane, CmuxTab } from "../api/types"
import { windowTabs } from "../lib/windowTabs"
import { dropTarget } from "../lib/cmuxMove"

/** Tabs listed per pane before the rest collapse into "Show N more tabs". */
export const VISIBLE_TABS = 10

const BORDER = "1px solid var(--mantine-color-default-border)"

const TAB_ICONS: Record<string, typeof IconFile> = {
  terminal: IconTerminal2,
  browser: IconWorld,
  markdown: IconMarkdown,
}

interface Handlers {
  onSelect: (tab: CmuxTab) => void
  onClose: (tab: CmuxTab) => void
}

interface Props extends Handlers {
  layout: CmuxLayout
  panes: CmuxPane[]
  onMove: (move: CmuxMove) => void
}

// Only what is under the pointer counts, tabs before panes. Nothing under it
// (the pointer left the diagram) means the drop goes nowhere, rather than to
// whichever tab happens to be closest.
const underPointer: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  const tabs = hits.filter((h) => String(h.id).startsWith("surface:"))
  return tabs.length > 0 ? tabs : hits
}

/** Which row/pane the drag is over, for the cross-pane drop hints. */
interface DragState {
  activeRef: string | null
  activePane: string | null
  overId: string | null
}

/**
 * A cmux workspace's panes drawn in their real arrangement: side-by-side
 * splits share the width by cmux's ratio; heights follow the content, so a
 * short pane never leaves a tall empty box. Each pane lists up to
 * VISIBLE_TABS tabs (see windowTabs) with the rest behind "Show N more tabs"
 * links that expand in place.
 *
 * Expansion lives here, so it resets whenever the diagram remounts — which
 * the card arranges by unmounting the cmux tab when it is not selected.
 *
 * Rows are draggable (dnd-kit): within a pane dragging reorders via
 * SortableContext's preview; across panes there is no slot preview, so the
 * hovered row/pane gets a drop hint instead (see PaneBox/TabRow).
 */
export function PaneDiagram({ layout, panes, onSelect, onClose, onMove }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [drag, setDrag] = useState<DragState>({ activeRef: null, activePane: null, overId: null })
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  )
  const setGroup = (key: string, open: boolean) =>
    setExpanded((cur) => {
      const next = new Set(cur)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  const byRef = new Map(panes.map((p) => [p.ref, p]))
  const paneOf = (ref: string) => panes.find((p) => p.tabs.some((t) => t.ref === ref))?.ref ?? null
  const activeTab = drag.activeRef ? panes.flatMap((p) => p.tabs).find((t) => t.ref === drag.activeRef) : undefined
  const reset = () => setDrag({ activeRef: null, activePane: null, overId: null })

  const onDragStart = ({ active }: DragStartEvent) =>
    setDrag({ activeRef: String(active.id), activePane: paneOf(String(active.id)), overId: null })
  const onDragOver = ({ over }: DragOverEvent) => setDrag((d) => ({ ...d, overId: over ? String(over.id) : null }))
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    reset()
    if (!over) return
    const move = dropTarget(panes, String(active.id), String(over.id))
    if (move) onMove(move)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={underPointer}
      autoScroll={false}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      <Box style={{ display: "flex", border: BORDER, borderRadius: "var(--mantine-radius-sm)", overflow: "hidden" }}>
        <LayoutView
          node={layout}
          grow={1}
          byRef={byRef}
          expanded={expanded}
          setGroup={setGroup}
          drag={drag}
          onSelect={onSelect}
          onClose={onClose}
        />
      </Box>
      <DragOverlay dropAnimation={null}>
        {activeTab && (
          <Text size="xs" fw={600} px={6} py={2} bg="var(--mantine-color-body)" style={{ border: BORDER, borderRadius: 4, whiteSpace: "nowrap" }}>
            {activeTab.title}
          </Text>
        )}
      </DragOverlay>
    </DndContext>
  )
}

interface ViewProps extends Handlers {
  byRef: Map<string, CmuxPane>
  expanded: ReadonlySet<string>
  setGroup: (key: string, open: boolean) => void
  drag: DragState
}

function LayoutView({ node, grow, edge, ...rest }: ViewProps & { node: CmuxLayout; grow: number; edge?: "left" | "top" }) {
  const style: CSSProperties = {
    flex: `${grow} 1 0`,
    minWidth: 0,
    display: "flex",
    borderLeft: edge === "left" ? BORDER : undefined,
    borderTop: edge === "top" ? BORDER : undefined,
  }
  if (node.pane !== undefined) {
    const pane = rest.byRef.get(node.pane) ?? { ref: node.pane, focused: false, tabs: [] }
    return <PaneBox pane={pane} style={style} {...rest} />
  }
  const [a, b] = node.children ?? []
  const split = node.split ?? 0.5
  const vertical = node.direction === "vertical"
  return (
    <div data-split={node.direction} style={{ ...style, flexDirection: vertical ? "column" : "row" }}>
      {a && <LayoutView node={a} grow={split} {...rest} />}
      {b && <LayoutView node={b} grow={1 - split} edge={vertical ? "top" : "left"} {...rest} />}
    </div>
  )
}

function PaneBox({ pane, style, expanded, setGroup, drag, onSelect, onClose }: ViewProps & { pane: CmuxPane; style: CSSProperties }) {
  const { setNodeRef } = useDroppable({ id: pane.ref })
  const { before, shown, after } = windowTabs(pane.tabs, VISIBLE_TABS)
  const open = (side: "before" | "after") => expanded.has(`${pane.ref}:${side}`)
  // Exactly the rows rendered, in order: collapsed groups are not targets.
  const items = [...(open("before") ? before : []), ...shown, ...(open("after") ? after : [])].map((t) => t.ref)
  const fromElsewhere = drag.activePane !== null && drag.activePane !== pane.ref
  const rows = (list: CmuxTab[]) =>
    list.map((tab) => (
      <TabRow
        key={tab.ref}
        tab={tab}
        // Across panes there is no slot preview; mark where it will land.
        dropBefore={fromElsewhere && drag.overId === tab.ref}
        onSelect={onSelect}
        onClose={onClose}
      />
    ))
  // A collapsed group is one link standing exactly where its tabs would be,
  // so cmux's order survives; "Show fewer" takes the link's place when open.
  const group = (list: CmuxTab[], side: "before" | "after"): ReactNode => {
    if (list.length === 0) return null
    const key = `${pane.ref}:${side}`
    if (!expanded.has(key)) {
      return <MoreLink onClick={() => setGroup(key, true)}>{`Show ${list.length} more tab${list.length === 1 ? "" : "s"}`}</MoreLink>
    }
    const fewer = <MoreLink onClick={() => setGroup(key, false)}>Show fewer</MoreLink>
    return side === "before" ? <>{fewer}{rows(list)}</> : <>{rows(list)}{fewer}</>
  }
  const paneHovered = drag.activeRef !== null && drag.overId === pane.ref
  return (
    <Stack
      ref={setNodeRef}
      gap={1}
      p={4}
      data-pane={pane.ref}
      data-droppable="true"
      style={{
        ...style,
        flexDirection: "column",
        // The focused pane is the one cmux sends keystrokes to; a hovered
        // pane during a cross-pane drag gets a thicker highlight instead.
        boxShadow: paneHovered
          ? "inset 0 0 0 2px var(--mantine-color-blue-filled)"
          : pane.focused
            ? "inset 0 0 0 1px var(--mantine-color-blue-filled)"
            : undefined,
      }}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {pane.tabs.length === 0 && <Text size="xs" c="dimmed" fs="italic" px={4}>No tabs</Text>}
        {group(before, "before")}
        {rows(shown)}
        {group(after, "after")}
      </SortableContext>
    </Stack>
  )
}

function MoreLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <UnstyledButton onClick={onClick} px={4} pl={22}>
      <Text size="xs" c="blue">{children}</Text>
    </UnstyledButton>
  )
}

function TabRow({ tab, dropBefore, onSelect, onClose }: Handlers & { tab: CmuxTab; dropBefore: boolean }) {
  const [confirming, setConfirming] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.ref })
  const Icon = TAB_ICONS[tab.type] ?? IconFile
  // A terminal may be running something (a dev server, an agent); everything
  // else closes like clicking ✕ in cmux.
  const close = () => (tab.type === "terminal" ? setConfirming(true) : onClose(tab))
  return (
    <Group
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // The row is not itself a button; its switch button is. Drop dnd-kit's
      // tabIndex/role so keyboard focus lands only on real controls.
      tabIndex={undefined}
      role={undefined}
      gap={2}
      wrap="nowrap"
      className="cmux-tab-row"
      style={{
        borderRadius: 4,
        minWidth: 0,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        borderTop: dropBefore ? "2px solid var(--mantine-color-blue-filled)" : "2px solid transparent",
        touchAction: "manipulation",
      }}
    >
      <Tooltip
        // Not the native title attribute: cmux's embedded browser does not
        // show those.
        label={
          <>
            <Text size="xs" fw={600}>{tab.title}</Text>
            {tab.url && <Text size="xs" style={{ wordBreak: "break-all" }}>{tab.url}</Text>}
          </>
        }
        openDelay={400}
        multiline
        maw={360}
      >
        <UnstyledButton
          aria-label={`Switch to ${tab.title}`}
          onClick={() => onSelect(tab)}
          style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4, padding: "1px 4px" }}
        >
          <Icon size={12} style={{ flex: "none" }} color={tab.selected ? "var(--mantine-color-blue-filled)" : "var(--mantine-color-dimmed)"} />
          <Text size="xs" truncate fw={tab.selected ? 700 : 400} data-selected={tab.selected || undefined}>
            {tab.title}
          </Text>
        </UnstyledButton>
      </Tooltip>
      <Popover opened={confirming} onChange={setConfirming} position="bottom-end" withArrow shadow="md">
        <Popover.Target>
          <ActionIcon variant="subtle" color="gray" size="xs" className="cmux-tab-close" aria-label={`Close ${tab.title}`} onClick={close}>
            <IconX size={10} />
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown>
          <Text size="xs">Close terminal "{tab.title}"?</Text>
          <Group gap="xs" justify="flex-end" mt={6}>
            <Button size="compact-xs" variant="subtle" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button size="compact-xs" color="red" onClick={() => { setConfirming(false); onClose(tab) }}>Close</Button>
          </Group>
        </Popover.Dropdown>
      </Popover>
    </Group>
  )
}
