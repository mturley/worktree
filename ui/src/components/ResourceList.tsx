import { useEffect, useRef, useState } from "react"
import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core"
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"
import { parseResourceKey, resourceKeyEquals, serializeResourceKey, type ResourceKey } from "../lib/resourceKey"
import { applyDrag, type DropTarget, type GroupId } from "../lib/resourceOrder"
import { SortableResourceCard } from "./SortableResourceCard"
import { AddResourceModal } from "./AddResourceModal"

interface ResourceListProps {
  items: ResourceDTO[]
  path: string
  onChanged: () => void
  selectedKey?: ResourceKey | null
  onSelectResource?: (key: ResourceKey) => void
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

export function ResourceList({ items, path, onChanged, selectedKey, onSelectResource }: ResourceListProps) {
  const [addOpen, setAddOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  // The optimistically reordered list. While it is set it wins over `items`,
  // which is what keeps a background refetch from yanking the list out from
  // under a drag, or from snapping it back before a save has landed.
  const [pending, setPending] = useState<ResourceDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const saving = useRef(0)

  // Fresh server data supersedes the optimistic list, except while a drag or
  // a save is in flight — clearing it then is exactly the yank it prevents.
  // Only `items` is a dependency: the save resolving calls onChanged, and it
  // is the refetch that follows, not the resolution itself, that may clear.
  useEffect(() => {
    if (!dragging && saving.current === 0) setPending(null)
  }, [items])

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

  const persist = async (next: ResourceDTO[]) => {
    const previous = shown
    setPending(next)
    setError(null)
    try {
      // Both groups are stated in full, so the call says what the order IS
      // rather than how it changed — replayable, and safe when another
      // device is dragging at the same time.
      saving.current++
      await api.setResourceOrder({
        path,
        focus: next.filter((r) => r.primary).map((r) => ({ type: r.type, id: r.id })),
        related: next.filter((r) => !r.primary).map((r) => ({ type: r.type, id: r.id })),
      })
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

  // No click suppression here: the dragged card follows the pointer, so the
  // release can land on it and the browser fires a click there — but
  // dnd-kit's pointer sensors already swallow that click (a capture-phase
  // listener on document, armed once a drag activates). A press too short to
  // activate a drag never arms it.
  const startDrag = () => setDragging(true)
  const finishDrag = () => setDragging(false)

  const handleDragEnd = (event: DragEndEvent) => {
    finishDrag()
    const over = event.over ? toDropTarget(String(event.over.id)) : null
    const active = parseResourceKey(String(event.active.id))
    if (!over || !active) return
    const next = applyDrag(shown, active, over)
    if (next === shown) return
    void persist(next)
  }

  const cards = (group: ResourceDTO[]) =>
    group.map((r) => (
      <SortableResourceCard
        key={`${r.type}:${r.id}`}
        r={r}
        path={path}
        onRemoved={onChanged}
        selected={resourceKeyEquals(selectedKey ?? null, { type: r.type, id: r.id })}
        onSelect={onSelectResource ? () => onSelectResource({ type: r.type, id: r.id }) : undefined}
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
      </Group>
      {items.length === 0 ? (
        <Text c="dimmed" size="sm">No resources tracked.</Text>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={startDrag}
          onDragEnd={handleDragEnd}
          onDragCancel={finishDrag}
        >
          {groups}
        </DndContext>
      )}
    </Stack>
  )
}
