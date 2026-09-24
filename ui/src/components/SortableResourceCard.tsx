import { ActionIcon } from "@mantine/core"
import { IconGripVertical } from "@tabler/icons-react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { ResourceDTO } from "../api/types"
import { serializeResourceKey } from "../lib/resourceKey"
import { ResourceCard } from "./ResourceCard"

/**
 * A ResourceCard that can be dragged within the list.
 *
 * Dragging is driven by an explicit handle rather than the card surface. The
 * card is also a click target that opens the resource, and the two gestures
 * are not reliably separable on a touchscreen — a threshold long enough to
 * protect the tap makes the drag feel broken, and one short enough to make
 * the drag feel good eats taps. A handle sidesteps the tradeoff.
 */
export function SortableResourceCard({
  r,
  path,
  onRemoved,
}: {
  r: ResourceDTO
  path: string
  onRemoved: () => void
}) {
  const id = serializeResourceKey({ type: r.type, id: r.id })
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

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
        dragHandle={
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`drag to reorder ${r.id}`}
            style={{ cursor: "grab", touchAction: "none" }}
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
