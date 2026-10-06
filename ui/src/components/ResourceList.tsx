import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core"
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core"
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"
import { parseResourceKey, resourceKeyEquals, serializeResourceKey, type ResourceKey } from "../lib/resourceKey"
import { applyDrag, crossGroupPreview, mergeVisibleOrder, moveToEdge, type DropTarget, type GroupId } from "../lib/resourceOrder"
import { resourceCollisions } from "../lib/resourceCollision"
import { useHoverMenu } from "../lib/useHoverMenu"
import { SortableResourceCard } from "./SortableResourceCard"
import { AddResourceModal } from "./AddResourceModal"

interface ResourceListProps {
  items: ResourceDTO[]
  path: string
  onChanged: () => void
  selectedKey?: ResourceKey | null
  onSelectResource?: (key: ResourceKey) => void
  /**
   * Every resource the worktree follows, when `items` is a filtered subset
   * (Unreads only). Reorders are saved against this, so the cards the
   * filter hides keep their places — see mergeVisibleOrder.
   */
  allItems?: ResourceDTO[]
  /** Shown instead of the cards when `items` is empty. */
  emptyText?: string
  /** Extra controls beside Follow resource. */
  toolbar?: React.ReactNode
}

/** Whether two lists hold the same cards, in the same groups and order. */
function sameOrder(a: ResourceDTO[], b: ResourceDTO[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.type === b[i].type && r.id === b[i].id && r.primary === b[i].primary)
  )
}

/**
 * Resolves a dnd-kit droppable id back to what it means: a group container,
 * or the card with that key. Returns null for an id neither shape explains,
 * which makes a stray drop a no-op instead of a scramble.
 */
function toDropTarget(id: string): DropTarget | null {
  if (id === "focus" || id === "related") return id
  return parseResourceKey(id)
}

/** A group's heading plus its cards, and — mid-drag — its drop area. */
function ResourceGroup({
  group,
  title,
  items,
  children,
  dragging,
}: {
  group: GroupId
  title: string
  items: ResourceDTO[]
  children: React.ReactNode
  dragging: boolean
}) {
  // The group itself is a drop target, not just the cards in it: an empty
  // group has no card to aim at, and it must still be possible to drag the
  // last related resource back into focus. An empty group only appears while
  // something is being dragged, so it is not a permanent empty box.
  const { setNodeRef, isOver } = useDroppable({ id: group })
  if (items.length === 0 && !dragging) return null
  return (
    <Stack gap={4}>
      <Title order={5}>{title}</Title>
      <Stack
        gap={4}
        ref={setNodeRef}
        style={{
          minHeight: dragging ? 36 : undefined,
          borderRadius: 6,
          outline: isOver ? "2px dashed var(--mantine-color-violet-5)" : undefined,
        }}
      >
        {items.length === 0 && dragging && (
          <Text c="dimmed" size="xs" p={6}>Drop a resource here.</Text>
        )}
        {children}
      </Stack>
    </Stack>
  )
}

export function ResourceList({
  items, path, onChanged, selectedKey, onSelectResource, allItems, emptyText = "No resources tracked.", toolbar,
}: ResourceListProps) {
  const [addOpen, setAddOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  // The optimistically reordered list. While it is set it wins over `items`,
  // which is what keeps a background refetch from yanking the list out from
  // under a drag, or from snapping it back before a save has landed.
  const [pending, setPending] = useState<ResourceDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const saving = useRef(0)
  // What was on screen when the drag began: the order to compare the drop
  // against, and what to restore if the drag is cancelled or the save fails.
  const dragStart = useRef<{ list: ResourceDTO[]; pending: ResourceDTO[] | null } | null>(null)
  // The list as of the latest drag event. Drag events can arrive faster than
  // React re-renders, so each one must see the previous one's move rather
  // than the last render's `shown`.
  const live = useRef<ResourceDTO[]>(items)
  // Set for one frame after a card moves into the other group; see collisions.
  const justMoved = useRef(false)

  // Fresh server data supersedes the optimistic list, except while a drag or
  // a save is in flight — clearing it then is exactly the yank it prevents.
  // Only `items` is a dependency: the save resolving calls onChanged, and it
  // is the refetch that follows, not the resolution itself, that may clear.
  useEffect(() => {
    if (!dragging && saving.current === 0) setPending(null)
  }, [items])

  // The handles' hover menus, one open at a time for the whole list.
  // closeDelay is the grace period for crossing from handle into menu —
  // measured in a browser, Mantine's 150ms default lost the menu on a slow,
  // deliberate trackpad move. Closed for the length of any drag: a menu
  // hanging off a card that is sliding around would chase it.
  const menuFor = useHoverMenu({ openDelay: 300, closeDelay: 400, disabled: dragging })

  const sensors = useSensors(
    // Only the grip handle starts a drag, so these thresholds guard nothing
    // but the handle itself: a few pixels of travel, so pressing it and
    // letting go is not read as a drag. No long press on touch — the handle
    // is the only thing that drags, so a swipe anywhere else still scrolls.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 4 } }),
    // The handle is a focusable button: Space or Enter picks the card up,
    // the arrow keys move it, and Space or Enter again drops it.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const shown = pending ?? items
  const focus = shown.filter((r) => r.primary)
  const related = shown.filter((r) => !r.primary)

  useLayoutEffect(() => {
    live.current = shown
  })
  // Moving a card into the other group shifts the layout under the pointer,
  // and for a frame the collision can resolve back to the group it just
  // left — bouncing the card between groups. Hold still until the move has
  // painted.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      justMoved.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [pending])

  const baseCollisions = resourceCollisions((group) =>
    live.current.every((r) => r.primary !== (group === "focus")),
  )
  const collisions: CollisionDetection = (args) =>
    // Aiming at the dragged card itself reads as "stay put", which is exactly
    // what the hold needs.
    justMoved.current ? [{ id: args.active.id }] : baseCollisions(args)

  // Shows `next` at once, then writes it; on failure, puts `previous` back.
  const save = async (next: ResourceDTO[], previous: ResourceDTO[], write: () => Promise<unknown>) => {
    setPending(next)
    setError(null)
    try {
      saving.current++
      await write()
    } catch (e) {
      setPending(previous)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      saving.current--
      // Either way the server's order is now the one to show: the refetch
      // replaces the optimistic list once it lands.
      onChanged()
    }
  }

  // `order` is what gets saved: the full list, when `next` is only the cards
  // a filter left showing.
  const persist = (
    next: ResourceDTO[],
    previous: ResourceDTO[],
    order = allItems ? mergeVisibleOrder(allItems, next) : next,
  ) =>
    save(next, previous, () =>
      // Both groups are stated in full, so the call says what the order IS
      // rather than how it changed — replayable, and safe when another
      // device is dragging at the same time.
      api.setResourceOrder({
        path,
        focus: order.filter((r) => r.primary).map((r) => ({ type: r.type, id: r.id })),
        related: order.filter((r) => !r.primary).map((r) => ({ type: r.type, id: r.id })),
      }),
    )

  const moveCard = (r: ResourceDTO, edge: "top" | "bottom") => {
    const key = { type: r.type, id: r.id }
    const next = moveToEdge(shown, key, edge)
    // Against the full list when filtered: "top" means the top of the group,
    // not just above the cards that happen to be showing.
    if (next !== shown) void persist(next, shown, allItems ? moveToEdge(allItems, key, edge) : next)
  }

  const setGroup = (r: ResourceDTO, primary: boolean) => {
    if (r.primary === primary) return
    // The server sends a reclassified card to the bottom of its new group
    // (resources.SetPrimary), which is exactly what dropping it on that
    // group's container does locally — so show that while the write lands,
    // rather than letting the switch snap back until the refetch.
    const next = applyDrag(shown, { type: r.type, id: r.id }, primary ? "focus" : "related")
    void save(next, shown, () => api.setResourcePrimary({ path, type: r.type, id: r.id, primary }))
  }

  // No click suppression here: the dragged card follows the pointer, so the
  // release can land on it and the browser fires a click there — but
  // dnd-kit's pointer sensors already swallow that click (a capture-phase
  // listener on document, armed once a drag activates). A press too short to
  // activate a drag never arms it.
  const startDrag = () => {
    dragStart.current = { list: shown, pending }
    live.current = shown
    setDragging(true)
  }

  const handleDragOver = ({ active, over }: DragOverEvent) => {
    const activeKey = parseResourceKey(String(active.id))
    const target = over ? toDropTarget(String(over.id)) : null
    const dragged = active.rect.current.translated
    if (!activeKey || !target || !over || !dragged) return
    const next = crossGroupPreview(
      live.current,
      activeKey,
      target,
      dragged.top + dragged.height / 2,
      over.rect.top + over.rect.height / 2,
    )
    if (!next) return
    justMoved.current = true
    live.current = next
    setPending(next)
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false)
    const start = dragStart.current
    dragStart.current = null
    if (!start) return
    // By now a card that crossed groups is already in its new group, so all
    // that is left is a move within it.
    const activeKey = parseResourceKey(String(active.id))
    const target = over ? toDropTarget(String(over.id)) : null
    const next = activeKey && target ? applyDrag(live.current, activeKey, target) : live.current
    if (sameOrder(next, start.list)) {
      // Back where it started, perhaps via the other group: nothing to save.
      setPending(start.pending)
      return
    }
    void persist(next, start.list)
  }

  const handleDragCancel = () => {
    setDragging(false)
    const start = dragStart.current
    dragStart.current = null
    // Undo any trip into the other group the cancelled drag made.
    if (start) setPending(start.pending)
  }

  const cards = (group: ResourceDTO[]) =>
    group.map((r, i) => (
      <SortableResourceCard
        key={`${r.type}:${r.id}`}
        r={r}
        path={path}
        onRemoved={onChanged}
        selected={resourceKeyEquals(selectedKey ?? null, { type: r.type, id: r.id })}
        onSelect={onSelectResource ? () => onSelectResource({ type: r.type, id: r.id }) : undefined}
        canMoveToTop={i > 0}
        canMoveToBottom={i < group.length - 1}
        onMoveToEdge={(edge) => moveCard(r, edge)}
        onSetPrimary={(primary) => setGroup(r, primary)}
        menu={menuFor(serializeResourceKey({ type: r.type, id: r.id }))}
      />
    ))

  const groups = (
    <>
      <ResourceGroup group="focus" title="Focus" items={focus} dragging={dragging}>
        <SortableContext
          items={focus.map((r) => serializeResourceKey({ type: r.type, id: r.id }))}
          strategy={verticalListSortingStrategy}
        >
          {cards(focus)}
        </SortableContext>
      </ResourceGroup>
      <ResourceGroup group="related" title="Related" items={related} dragging={dragging}>
        <SortableContext
          items={related.map((r) => serializeResourceKey({ type: r.type, id: r.id }))}
          strategy={verticalListSortingStrategy}
        >
          {cards(related)}
        </SortableContext>
      </ResourceGroup>
    </>
  )

  return (
    <Stack gap="md">
      <AddResourceModal
        opened={addOpen}
        path={path}
        onClose={() => setAddOpen(false)}
        onAdded={onChanged}
      />
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          <Text size="xs">Could not save the new order: {error}</Text>
        </Alert>
      )}
      {/*
        Above the list: Follow resource is about the list below it, so it
        reads as its toolbar rather than as a footnote.
      */}
      <Group>
        {/* Filled, i.e. the theme's primary: it is the only thing on this
            column you can DO, and light left it reading as a secondary
            action beside the resource cards it heads. */}
        <Button size="sm" variant="filled" leftSection="+" onClick={() => setAddOpen(true)}>
          Follow resource
        </Button>
        {toolbar}
      </Group>
      {items.length === 0 ? (
        <Text c="dimmed" size="sm">{emptyText}</Text>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collisions}
          // No auto-scroll. Left on, it scrolled the page to its bottom mid-
          // drag and then ran away with the sticky list column: the dragged
          // card's transform pushes past the column's bottom, inflating its
          // scrollable area, so the column kept chasing it (scrollTop 858 in a
          // column whose real maximum was 137) before snapping back on drop.
          // Scrolling a sticky overflow container under a transformed element
          // is also what knocked WebKit's hit-testing ~20px out of step with
          // what it painted, until something forced a repaint. The lists are
          // short enough to fit; the wheel still scrolls during a drag.
          autoScroll={false}
          onDragStart={startDrag}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          {groups}
        </DndContext>
      )}
    </Stack>
  )
}
