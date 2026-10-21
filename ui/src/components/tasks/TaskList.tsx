import { useState } from "react"
import { ActionIcon, Alert, Box, Stack, Text, Tooltip } from "@mantine/core"
import { IconGripVertical } from "@tabler/icons-react"
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { Task } from "../../api/types"
import { useTaskMutations, useTasks, type TaskScope } from "../../hooks/useTasks"
import { useTaskListPrefs } from "../../hooks/useTaskListPrefs"
import { buildSections, canDrag, type TaskSection } from "../../lib/taskSections"
import { useSearchContext } from "../search/SearchContext"
import { TaskQuickAdd } from "./TaskQuickAdd"
import { TaskRow } from "./TaskRow"
import { dropPlanFor, sectionDroppableId, taskCollisions, taskDraggableId } from "./taskDrag"

/** A compact row's height, for capping a pinned list at `maxRows`. */
const ROW_PX = 30
const DRAG_HINT = "Drag to reorder works in Custom or Priority order"

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * A TaskRow that drags by its grip only, as SortableResourceCard does. The
 * grip renders disabled with a hint when the sort can't be reordered, and not
 * at all in Completed, whose order isn't master order.
 */
function SortableTaskRow({ task, section, sortDraggable, ownResource, mutations, onError }: {
  task: Task
  section: TaskSection
  sortDraggable: boolean
  ownResource?: { type: string; id: string }
  mutations: Pick<ReturnType<typeof useTaskMutations>, "setState" | "update">
  onError: (msg: string) => void
}) {
  const { setState, update } = mutations
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: taskDraggableId(task.id), disabled: !section.draggable })

  let grip: React.ReactNode = null
  if (section.draggable) {
    grip = (
      <ActionIcon
        ref={setActivatorNodeRef}
        variant="subtle"
        color="gray"
        size="xs"
        aria-label={`Drag to reorder ${task.title}`}
        // touchAction: none on the grip only, so a touch drag starts there
        // and a swipe anywhere else still scrolls.
        style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
        {...attributes}
        {...listeners}
      >
        <IconGripVertical size={14} />
      </ActionIcon>
    )
  } else if (!sortDraggable && section.key !== "completed") {
    grip = (
      <Tooltip label={DRAG_HINT}>
        {/* data-disabled rather than disabled: a disabled button gets no
            pointer events, and the hint has to show on hover. */}
        <ActionIcon
          variant="subtle"
          color="gray"
          size="xs"
          data-disabled
          aria-disabled
          aria-label={`Drag to reorder ${task.title}`}
          onClick={(e) => e.preventDefault()}
        >
          <IconGripVertical size={14} />
        </ActionIcon>
      </Tooltip>
    )
  }

  const run = (p: Promise<unknown>) => {
    p.catch((e: unknown) => onError(errorText(e)))
  }

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
        position: "relative",
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <TaskRow
        task={task}
        ownResource={ownResource}
        dragHandle={grip}
        onState={(s) => run(setState(task.id, s))}
        onToggleStar={() => run(update(task.id, { starred: !task.starred }))}
      />
    </div>
  )
}

/** A section: its label (when there are several), its rows and, mid-drag, its drop area. */
function SectionBlock({ section, labelled, dragging, children }: {
  section: TaskSection
  labelled: boolean
  dragging: boolean
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: sectionDroppableId(section.key), disabled: !section.draggable })
  return (
    <Stack gap={0} data-task-section={section.key}>
      {labelled && (
        <Text size="xs" fw={700} tt="uppercase" c="dimmed" px="xs" pt={4}>
          {section.label}
        </Text>
      )}
      <Stack
        gap={0}
        ref={setNodeRef}
        style={{
          minHeight: dragging && section.tasks.length === 0 ? ROW_PX : undefined,
          borderRadius: 6,
          outline: isOver ? "2px dashed var(--task-accent)" : undefined,
        }}
      >
        {section.tasks.length === 0 && dragging && (
          <Text c="dimmed" size="xs" p={6}>Drop a task here.</Text>
        )}
        {children}
      </Stack>
    </Stack>
  )
}

/**
 * One task list, used everywhere: sections (starred on top, priority groups,
 * completed last), drag reordering across sections, and quick add at the
 * bottom. View prefs are global (useTaskListPrefs); the toolbar that edits
 * them is rendered by whoever hosts the list.
 */
export function TaskList({ scope, ownResource, maxRows }: {
  scope: TaskScope
  ownResource?: { type: string; id: string }
  maxRows?: number
}) {
  const [prefs] = useTaskListPrefs()
  const { terms } = useSearchContext()
  const query = useTasks(scope, { completed: prefs.showCompleted, archived: prefs.includeArchived })
  const mutations = useTaskMutations(scope)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sections = buildSections(query.data ?? [], prefs, terms)
  const sortDraggable = canDrag(prefs.sort)
  // Empty sections exist only as drop targets: shown while a drag is on.
  const shown = sections.filter((s) => s.tasks.length > 0 || (dragging && s.draggable))
  const labelled = shown.length > 1
  const lastVisible = sections
    .filter((s) => s.key !== "completed")
    .flatMap((s) => s.tasks)
    .at(-1)

  const sensors = useSensors(
    // Only the grip starts a drag; a few pixels of travel so a press isn't one.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const collisions = taskCollisions((key) => sections.find((s) => s.key === key)?.tasks.length === 0)

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(false)
    if (!over) return
    const dragged = active.rect.current.translated
    const below = dragged ? dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2 : false
    const plan = dropPlanFor(sections, active.id, over.id, below)
    const id = Number(String(active.id).replace(/^task:/, ""))
    if (!plan.place && !plan.patch) return
    if (plan.place) {
      mutations.move(id, plan.place, plan.patch).catch((e: unknown) => setError(errorText(e)))
    } else if (plan.patch) {
      // A move to an empty section with nothing else around: only the edit.
      mutations.update(id, plan.patch).catch((e: unknown) => setError(errorText(e)))
    }
  }

  const add = (input: { title: string; priority: Task["priority"]; starred: boolean }) => {
    setError(null)
    return mutations.create(lastVisible ? { ...input, after: lastVisible.id } : input).catch((e: unknown) => {
      setError(errorText(e))
      throw e
    })
  }

  let body: React.ReactNode
  if (query.isError) {
    body = <Text c="red" size="xs" px="xs">Could not load tasks: {errorText(query.error)}</Text>
  } else if (query.isPending) {
    body = <Text c="dimmed" size="xs" px="xs">Loading tasks…</Text>
  } else if (shown.length === 0) {
    body = <Text c="dimmed" size="xs" px="xs">{terms.length > 0 ? "No matching tasks." : "No tasks."}</Text>
  } else {
    body = (
      <DndContext
        sensors={sensors}
        collisionDetection={collisions}
        // Off for the same reason as ResourceList: it ran away with sticky
        // and capped scroll containers.
        autoScroll={false}
        onDragStart={() => setDragging(true)}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragging(false)}
      >
        {shown.map((s) => (
          <SectionBlock key={s.key} section={s} labelled={labelled} dragging={dragging}>
            <SortableContext items={s.tasks.map((t) => taskDraggableId(t.id))} strategy={verticalListSortingStrategy}>
              {s.tasks.map((t) => (
                <SortableTaskRow
                  key={t.id}
                  task={t}
                  section={s}
                  sortDraggable={sortDraggable}
                  ownResource={ownResource}
                  mutations={mutations}
                  onError={setError}
                />
              ))}
            </SortableContext>
          </SectionBlock>
        ))}
      </DndContext>
    )
  }

  return (
    <Stack gap={6}>
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)} p="xs">
          <Text size="xs">{error}</Text>
        </Alert>
      )}
      <Box
        data-testid="task-list-body"
        style={maxRows ? { maxHeight: maxRows * ROW_PX, overflowY: "auto" } : undefined}
      >
        {body}
      </Box>
      <TaskQuickAdd onAdd={add} />
    </Stack>
  )
}
