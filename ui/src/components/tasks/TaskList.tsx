import { useState } from "react"
import { ActionIcon, Alert, Box, Stack, Text, Tooltip } from "@mantine/core"
import { IconGripVertical } from "@tabler/icons-react"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
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
/**
 * A pinned list is also capped at a quarter of the viewport: inside a sticky
 * header (card + panel + tab bar) 8 rows alone could take most of a short
 * screen.
 */
const PINNED_VIEWPORT_CAP = "25dvh"
/** An empty section's drop strip: present at rest, so a drag shifts nothing. */
const STRIP_PX = 22

/** The list body's height cap for `maxRows`, rows and viewport both. */
export function pinnedMaxHeight(maxRows: number): string {
  return `min(${maxRows * ROW_PX}px, ${PINNED_VIEWPORT_CAP})`
}

/** What an empty section's strip says: what dropping there does. */
function stripText(section: TaskSection): string {
  if (section.key === "starred") return "Drag here to star"
  if (section.priority === "none") return "Drag here for no priority"
  if (section.priority) return `Drag here for ${section.label.toLowerCase()} priority`
  return "Drag here to unstar"
}
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
      data-task-sortable={task.id}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
        position: "relative",
        // A faint placeholder: the DragOverlay is what follows the pointer.
        opacity: isDragging ? 0.35 : 1,
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

/**
 * A section: its label (when the list is labelled) and its rows. An empty
 * draggable section is a slim dashed strip saying what a drop there does. It
 * renders at rest, not only mid-drag, so starting a drag shifts nothing
 * under the pointer. An empty Starred strip carries no label: its text says
 * it all.
 */
function SectionBlock({ section, labelled, children }: {
  section: TaskSection
  labelled: boolean
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: sectionDroppableId(section.key), disabled: !section.draggable })
  const empty = section.tasks.length === 0
  return (
    <Stack gap={0} data-task-section={section.key}>
      {labelled && !(empty && section.key === "starred") && (
        <Text size="xs" fw={700} tt="uppercase" c="dimmed" px="xs" pt={4}>
          {section.label}
        </Text>
      )}
      <Stack
        gap={0}
        ref={setNodeRef}
        data-task-drop={section.key}
        style={{ borderRadius: 6, outline: isOver && !empty ? "2px dashed var(--task-accent)" : undefined }}
      >
        {empty ? (
          <Text
            data-task-strip={section.key}
            c="dimmed"
            size="xs"
            px="xs"
            mx="xs"
            my={2}
            style={{
              height: STRIP_PX,
              lineHeight: `${STRIP_PX - 2}px`,
              borderRadius: 6,
              border: `1px dashed ${isOver ? "var(--task-accent)" : "var(--mantine-color-default-border)"}`,
              opacity: isOver ? 1 : 0.7,
            }}
          >
            {stripText(section)}
          </Text>
        ) : children}
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
  const [activeId, setActiveId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sections = buildSections(query.data ?? [], prefs, terms)
  const sortDraggable = canDrag(prefs.sort)
  // Empty draggable sections show as drop strips at rest; nothing here
  // depends on whether a drag is on, so starting one moves no row.
  const shown = sections.filter((s) => s.tasks.length > 0 || s.draggable)
  const anyTasks = sections.some((s) => s.tasks.length > 0)
  // Priority groups are always labelled (an empty one is a strip under its
  // label); otherwise labels appear once two sections hold tasks.
  const labelled = prefs.sort === "priority" || sections.filter((s) => s.tasks.length > 0).length > 1
  const activeTask = activeId === null ? undefined : sections.flatMap((s) => s.tasks).find((t) => t.id === activeId)
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

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(Number(String(active.id).replace(/^task:/, "")))
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null)
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
  } else if (!anyTasks) {
    body = <Text c="dimmed" size="xs" px="xs">{terms.length > 0 ? "No matching tasks." : "No tasks."}</Text>
  } else {
    body = (
      <DndContext
        sensors={sensors}
        collisionDetection={collisions}
        // Off for the same reason as ResourceList: it ran away with sticky
        // and capped scroll containers.
        autoScroll={false}
        // Re-measure drop targets throughout a drag: sortable transforms
        // move rows, and the strips' rects must follow.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        {shown.map((s) => (
          <SectionBlock key={s.key} section={s} labelled={labelled}>
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
        {/* The dragged row follows the pointer here; its own slot stays put. */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <Box className="task-panel" style={{ cursor: "grabbing" }} data-testid="task-drag-overlay">
              <TaskRow task={activeTask} ownResource={ownResource} onState={() => {}} onToggleStar={() => {}} />
            </Box>
          ) : null}
        </DragOverlay>
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
        style={maxRows ? { maxHeight: pinnedMaxHeight(maxRows), overflowY: "auto" } : undefined}
      >
        {body}
      </Box>
      <TaskQuickAdd onAdd={add} />
    </Stack>
  )
}
