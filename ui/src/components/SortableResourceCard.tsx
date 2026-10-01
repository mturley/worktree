import { ActionIcon } from "@mantine/core"
import { IconGripVertical } from "@tabler/icons-react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { ResourceDTO } from "../api/types"
import { serializeResourceKey } from "../lib/resourceKey"
import { ResourceCard } from "./ResourceCard"

/**
 * A ResourceCard that can be dragged by its grip handle.
 *
 * Only the handle starts a drag (it is the sortable's activator node), so the
 * rest of the card keeps behaving exactly as it always has: a click selects,
 * and on touch a swipe that starts on the card scrolls the page. The handle is
 * a real button beside the card's select button rather than a wrapper around
 * it, which is also what lets dnd-kit's `attributes` — focusability, role,
 * the screen-reader description — go on it, and keyboard reordering with it.
 */
export function SortableResourceCard({
  r,
  path,
  onRemoved,
  selected,
  onSelect,
}: {
  r: ResourceDTO
  path: string
  onRemoved: () => void
  selected: boolean
  onSelect?: () => void
}) {
  const id = serializeResourceKey({ type: r.type, id: r.id })
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id })

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Lifted above its neighbours so the card being dragged is never
        // painted underneath the ones it is passing.
        zIndex: isDragging ? 1 : undefined,
        position: "relative",
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <ResourceCard
        r={r}
        path={path}
        onRemoved={onRemoved}
        selected={selected}
        onSelect={onSelect}
        dragHandle={
          <ActionIcon
            ref={setActivatorNodeRef}
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={`drag to reorder ${r.id}`}
            // touchAction: none on the handle only — it is what lets a touch
            // drag start without the browser claiming the gesture as a
            // scroll, and confining it here leaves the rest of the card
            // scrollable.
            style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={16} />
          </ActionIcon>
        }
      />
    </div>
  )
}
