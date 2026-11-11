import { useEffect, useState } from "react"
import { ActionIcon, Alert, Button, Divider, Group, Popover, SegmentedControl, Stack, Text } from "@mantine/core"
import { IconArrowBarToDown, IconArrowBarToUp, IconGripVertical, IconTrash } from "@tabler/icons-react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { ResourceDTO } from "../api/types"
import type { HoverMenu } from "../lib/useHoverMenu"
import { serializeResourceKey } from "../lib/resourceKey"
import { ResourceCard, type ResourceNotifyContext } from "./ResourceCard"
import { useUnfollowResource } from "../hooks/useUnfollowResource"

/**
 * A ResourceCard that can be dragged by its grip handle.
 *
 * Only the handle starts a drag (it is the sortable's activator node), so the
 * rest of the card keeps behaving exactly as it always has: a click selects,
 * and on touch a swipe that starts on the card scrolls the page. The handle is
 * a real button beside the card's select button rather than a wrapper around
 * it, which is also what lets dnd-kit's `attributes` — focusability, role,
 * the screen-reader description — go on it, and keyboard reordering with it.
 *
 * Hovering the handle opens a small menu: the "Drag to reorder" hint, plus
 * Move to top / Move to bottom (within the card's own group) and the same
 * Focus/Related switch as the detail card, and Unfollow, which asks to be
 * confirmed in place (and offers an undo once done). Not a Tooltip, which is never
 * interactive: a Popover driven by ResourceList's useHoverMenu, which keeps
 * it open while the pointer travels from the handle into it and allows only
 * one card's menu open at a time.
 */
export function SortableResourceCard({
  r,
  path,
  onRemoved,
  selected,
  onSelect,
  canMoveToTop,
  canMoveToBottom,
  onMoveToEdge,
  onSetPrimary,
  menu,
  notify,
  checkedOut,
}: {
  r: ResourceDTO
  path: string
  onRemoved: () => void
  selected: boolean
  onSelect?: () => void
  canMoveToTop: boolean
  canMoveToBottom: boolean
  onMoveToEdge: (edge: "top" | "bottom") => void
  onSetPrimary: (primary: boolean) => void
  menu: HoverMenu
  notify?: ResourceNotifyContext
  checkedOut?: boolean
}) {
  const id = serializeResourceKey({ type: r.type, id: r.id })
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id })
  const { unfollow, removing, error: unfollowError, clearError } = useUnfollowResource({ r, path, onRemoved })
  const [confirming, setConfirming] = useState(false)
  // A confirm prompt (or an unfollow in flight) holds the menu open when the
  // pointer drifts off it; Cancel, Escape or a click outside still close it.
  const holdOpen = confirming || removing
  // However the menu closed — including another card's menu taking over —
  // it reopens on its usual buttons, not a stale prompt.
  useEffect(() => {
    if (!menu.opened) {
      setConfirming(false)
      clearError()
    }
  }, [menu.opened])
  const closeMenu = () => {
    setConfirming(false)
    clearError()
    menu.close()
  }

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
        notify={notify}
        checkedOut={checkedOut}
        dragHandle={
          <Popover
            opened={menu.opened}
            onClose={closeMenu}
            position="right"
            withArrow
            shadow="md"
            // The gap a pointer must cross to get into the menu, which belongs
            // to neither: Mantine's default 8px offset plus the arrow made it
            // 12px. The grace period for crossing it is useHoverMenu's.
            offset={4}
          >
            <Popover.Target>
              <ActionIcon
                ref={setActivatorNodeRef}
                variant="subtle"
                color="gray"
                size="sm"
                aria-label={`drag to reorder ${r.id}`}
                // touchAction: none on the handle only — it is what lets a
                // touch drag start without the browser claiming the gesture
                // as a scroll, and confining it here leaves the rest of the
                // card scrollable.
                style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
                onMouseEnter={menu.onTargetEnter}
                onMouseLeave={menu.onLeave}
                {...attributes}
                {...listeners}
              >
                <IconGripVertical size={16} />
              </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown
              p="xs"
              onMouseEnter={menu.onDropdownEnter}
              onMouseLeave={holdOpen ? undefined : menu.onLeave}
            >
              <Stack gap={6}>
                <Text size="xs" c="dimmed">Drag to reorder</Text>
                <Group gap={4} wrap="nowrap">
                  {/* Arrows against a bar, not plain arrows: "to the top", not
                      "up one".

                      Subtle, like the app's other compact buttons, not light:
                      light hovers from a 15% to a 20% tint, which measured
                      invisible on this dark-only theme. Subtle hovers from
                      transparent to a tint. */}
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<IconArrowBarToUp size={14} />}
                    disabled={!canMoveToTop}
                    onClick={() => onMoveToEdge("top")}
                  >
                    Move to top
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    leftSection={<IconArrowBarToDown size={14} />}
                    disabled={!canMoveToBottom}
                    onClick={() => onMoveToEdge("bottom")}
                  >
                    Move to bottom
                  </Button>
                </Group>
                <SegmentedControl
                  size="xs"
                  fullWidth
                  value={r.primary ? "focus" : "related"}
                  onChange={(v) => onSetPrimary(v === "focus")}
                  data={[
                    { value: "focus", label: "Focus" },
                    { value: "related", label: "Related" },
                  ]}
                />
                <Divider />
                {confirming ? (
                  <Stack gap={6}>
                    <Text size="xs">Unfollow this resource?</Text>
                    {unfollowError && (
                      <Alert color="red" variant="light" p="xs">
                        <Text size="xs">{unfollowError}</Text>
                      </Alert>
                    )}
                    <Group gap={6} justify="flex-end" wrap="nowrap">
                      <Button size="compact-xs" variant="default" disabled={removing} onClick={() => {
                        setConfirming(false)
                        clearError()
                      }}>
                        Cancel
                      </Button>
                      <Button
                        size="compact-xs"
                        color="red"
                        loading={removing}
                        onClick={() => void unfollow().then((ok) => ok && closeMenu())}
                      >
                        Unfollow
                      </Button>
                    </Group>
                  </Stack>
                ) : (
                  // Subtle, like the move buttons above, but red: it is the
                  // one thing here that takes something away.
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    leftSection={<IconTrash size={14} />}
                    onClick={() => setConfirming(true)}
                    style={{ alignSelf: "flex-start" }}
                  >
                    Unfollow
                  </Button>
                )}
              </Stack>
            </Popover.Dropdown>
          </Popover>
        }
      />
    </div>
  )
}
