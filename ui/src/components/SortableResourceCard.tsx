import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { ResourceDTO } from "../api/types"
import { serializeResourceKey } from "../lib/resourceKey"
import { ResourceCard } from "./ResourceCard"

/**
 * A ResourceCard that can be dragged by its whole surface.
 *
 * The card is also a click target that selects the resource, so the two
 * gestures share one element. They are told apart by the sensors in
 * ResourceList (a few pixels of travel with a mouse, a long press on touch)
 * and by ResourceList swallowing the click a drop leaves behind.
 *
 * dnd-kit's `attributes` are deliberately not spread here: they would make the
 * wrapper a focusable role="button" around the card's own select button —
 * nested interactive roles, and a second tab stop per card.
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
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // Lifted above its neighbours so the card being dragged is never
        // painted underneath the ones it is passing.
        zIndex: isDragging ? 1 : undefined,
        position: "relative",
        opacity: isDragging ? 0.6 : 1,
        cursor: isDragging ? "grabbing" : undefined,
      }}
    >
      <ResourceCard r={r} path={path} onRemoved={onRemoved} selected={selected} onSelect={onSelect} />
    </div>
  )
}
