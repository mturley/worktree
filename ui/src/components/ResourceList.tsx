import { useEffect, useState } from "react"
import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import type { ResourceDTO } from "../api/types"
import { api } from "../api/client"
import { parseResourceKey, resourceKeyEquals, serializeResourceKey, type ResourceKey } from "../lib/resourceKey"
import { applyDrag, type DropTarget, type GroupId } from "../lib/resourceOrder"
import { ResourceCard } from "./ResourceCard"
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

/** A group's heading plus its cards, and — while reordering — its drop area. */
function ResourceGroup({
  group,
  title,
  items,
  children,
  reordering,
}: {
  group: GroupId
  title: string
  items: ResourceDTO[]
  children: React.ReactNode
  reordering: boolean
}) {
  // The group itself is a drop target, not just the cards in it: an empty
  // group has no card to aim at, and it must still be possible to drag the
  // last related resource back into focus.
  const { setNodeRef, isOver } = useDroppable({ id: group, disabled: !reordering })
  if (items.length === 0 && !reordering) return null
  return (
    <Stack gap={4}>
      <Title order={5}>{title}</Title>
      <Stack
        gap={4}
        ref={setNodeRef}
        style={{
          minHeight: reordering ? 36 : undefined,
          borderRadius: 6,
          outline: isOver ? "2px dashed var(--mantine-color-violet-5)" : undefined,
        }}
      >
        {items.length === 0 && reordering && (
          <Text c="dimmed" size="xs" p={6}>Drop a resource here.</Text>
        )}
        {children}
      </Stack>
    </Stack>
  )
}

export function ResourceList({ items, path, onChanged, selectedKey, onSelectResource }: ResourceListProps) {
  const [addOpen, setAddOpen] = useState(false)
  const [reordering, setReordering] = useState(false)
  // The optimistically reordered list. While it is set it wins over `items`,
  // which is what keeps a background refetch from yanking the list out from
  // under a drag that has not been confirmed yet.
  const [pending, setPending] = useState<ResourceDTO[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fresh server data supersedes the optimistic list — but only once the user
  // is done reordering. Clearing it mid-session is the yank this exists to
  // prevent.
  // `reordering` is deliberately not a dependency: leaving reorder mode must
  // NOT clear the optimistic list, or the pre-drag order flashes back for the
  // frame between "Done" and the refetch landing.
  useEffect(() => {
    if (!reordering) setPending(null)
  }, [items])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A few pixels of travel before a drag starts, so pressing the handle
      // and releasing still behaves like a press.
      activationConstraint: { distance: 4 },
    }),
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
      await api.setResourceOrder({
        path,
        focus: next.filter((r) => r.primary).map((r) => ({ type: r.type, id: r.id })),
        related: next.filter((r) => !r.primary).map((r) => ({ type: r.type, id: r.id })),
      })
    } catch (e) {
      setPending(previous)
      setError(e instanceof Error ? e.message : String(e))
      onChanged()
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const over = event.over ? toDropTarget(String(event.over.id)) : null
    const active = parseResourceKey(String(event.active.id))
    if (!over || !active) return
    const next = applyDrag(shown, active, over)
    if (next === shown) return
    void persist(next)
  }

  const stopReordering = () => {
    setReordering(false)
    // The optimistic list stays on screen until the refetch lands, so the
    // order does not visibly snap back to the pre-drag one for a frame.
    onChanged()
  }

  const cards = (group: ResourceDTO[]) =>
    group.map((r) =>
      reordering ? (
        <SortableResourceCard key={`${r.type}:${r.id}`} r={r} path={path} onRemoved={onChanged} />
      ) : (
        <ResourceCard
          key={`${r.type}:${r.id}`}
          r={r}
          path={path}
          onRemoved={onChanged}
          selected={resourceKeyEquals(selectedKey ?? null, { type: r.type, id: r.id })}
          onSelect={onSelectResource ? () => onSelectResource({ type: r.type, id: r.id }) : undefined}
        />
      ),
    )

  const groups = (
    <>
      <ResourceGroup group="focus" title="Focus" items={focus} reordering={reordering}>
        <SortableContext
          items={focus.map((r) => serializeResourceKey({ type: r.type, id: r.id }))}
          strategy={verticalListSortingStrategy}
        >
          {cards(focus)}
        </SortableContext>
      </ResourceGroup>
      <ResourceGroup group="related" title="Related" items={related} reordering={reordering}>
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
      {items.length === 0 ? (
        <Text c="dimmed" size="sm">No resources tracked.</Text>
      ) : reordering ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          {groups}
        </DndContext>
      ) : (
        groups
      )}
      {/*
        Below the list, not above it: adding is the rare action and the list
        is what you came for, so the resources start at the top of the column
        rather than under a button.
      */}
      <Group>
        {/* Filled, i.e. the theme's primary: it is the only thing on this
            column you can DO, and light left it reading as a secondary
            action beside the resource cards it sits under. */}
        <Button size="sm" variant="filled" leftSection="+" onClick={() => setAddOpen(true)}>
          Follow resource
        </Button>
        {/* Reordering is a mode rather than an always-live gesture: it keeps
            the grip handles out of the way when you are only reading, and
            leaves a plain click on a card meaning "open this". */}
        {shown.length > 1 && (
          reordering ? (
            <Button size="sm" variant="light" onClick={stopReordering}>Done</Button>
          ) : (
            <Button size="sm" variant="subtle" onClick={() => setReordering(true)}>Reorder</Button>
          )
        )}
      </Group>
    </Stack>
  )
}
