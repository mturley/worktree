import { useLayoutEffect, useRef, useState } from "react"
import { ActionIcon, Alert, Box, Button, Group, Stack, Text, Tooltip } from "@mantine/core"
import { IconGripVertical } from "@tabler/icons-react"
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { Task, TaskState } from "../../api/types"
import { useTaskMutations, useTasks, type TaskScope } from "../../hooks/useTasks"
import { useTaskListPrefs } from "../../hooks/useTaskListPrefs"
import { buildSections, canDrag, quickAddAnchor, type TaskSection } from "../../lib/taskSections"
import { useSearchContext } from "../search/SearchContext"
import { useTaskModal } from "./modal/TaskModalProvider"
import { TaskQuickAdd } from "./TaskQuickAdd"
import { TaskRow } from "./TaskRow"
import { taskUndoMessage, useOfferTaskUndo } from "./taskUndo"
import { dropPlanFor, taskDraggableId } from "./taskDrag"

/** A compact row's height, for capping a list at `maxRows`. */
const ROW_PX = 30
/**
 * A capped list is also capped at a quarter of the viewport: inside a sticky
 * header (card + panel + tab bar) 8 rows alone could take most of a short
 * screen.
 */
const VIEWPORT_CAP = "25dvh"

/** The list body's height cap for `maxRows`, rows and viewport both. */
export function cappedMaxHeight(maxRows: number): string {
  return `min(${maxRows * ROW_PX}px, ${VIEWPORT_CAP})`
}

const DRAG_HINT = "Drag to reorder works in Custom or Priority order"

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Whether a capped body overflows its cap: measured after layout, and again
 * whenever the capped box or the content inside it resizes, or the list's
 * shape (`shape`: its count, sections and labels) changes. Under a cap that
 * holds, the box keeps its size while its content grows, so the content is
 * observed too (`contentRef`), and `shape` covers environments without
 * ResizeObserver.
 *
 * Uncapped (expanded), the last answer is kept rather than reset: the footer
 * shows regardless while expanded, and a reset would unmount Show less's
 * button on the way back, taking the keyboard focus with it.
 */
function useOverflow(capped: boolean, shape: string) {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !capped) return
    const check = () => setValue(el.scrollHeight > el.clientHeight + 1)
    check()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    if (contentRef.current) ro.observe(contentRef.current)
    return () => ro.disconnect()
  }, [capped, shape])
  return { ref, contentRef, value }
}

/**
 * A TaskRow that drags by its grip only, as SortableResourceCard does. The
 * grip renders disabled with a hint when the sort can't be reordered, and not
 * at all in Completed, whose order isn't master order.
 */
function SortableTaskRow({ task, section, sortDraggable, ownResource, mutations, onError, onOpen }: {
  task: Task
  section: TaskSection
  sortDraggable: boolean
  ownResource?: { type: string; id: string }
  mutations: Pick<ReturnType<typeof useTaskMutations>, "setState" | "update">
  onError: (msg: string) => void
  onOpen: (id: number) => void
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

  const offerUndo = useOfferTaskUndo()
  const run = (p: Promise<unknown>) => {
    p.catch((e: unknown) => onError(errorText(e)))
  }
  const pickState = (s: TaskState) => {
    // The title as clicked, so a rename landing meanwhile can't change what the toast names.
    const title = task.title
    run(setState(task.id, s).then((t) => offerUndo(t.undo_event_id, taskUndoMessage.state(title, s))))
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
        onState={pickState}
        onPriority={(priority) => run(update(task.id, { priority }))}
        onToggleStar={() => run(update(task.id, { starred: !task.starred }))}
        onOpen={() => onOpen(task.id)}
      />
    </div>
  )
}

/**
 * A section: its label (when the list is labelled) and its rows. Only
 * sections that hold tasks are rendered, so there is nothing to drop onto but
 * rows: a drop's section follows from the row it lands on.
 */
function SectionBlock({ section, labelled, children }: {
  section: TaskSection
  labelled: boolean
  children: React.ReactNode
}) {
  return (
    <Stack gap={0} data-task-section={section.key}>
      {labelled && (
        <Text size="xs" fw={700} tt="uppercase" c="dimmed" px="xs" pt={4}>
          {section.label}
        </Text>
      )}
      {children}
    </Stack>
  )
}

/**
 * One task list, used everywhere: sections (starred on top, priority groups,
 * completed last), drag reordering across sections, and quick add at the
 * bottom. View prefs are global (useTaskListPrefs); the toolbar that edits
 * them is rendered by whoever hosts the list.
 *
 * `maxRows` caps the body, which then scrolls inside itself. With `expand`,
 * a capped body that overflows offers "Show all (N)" under it, and an
 * expanded one (`maxRows` ignored) offers "Show less"; both call `onToggle`,
 * and the host owns the level.
 */
export function TaskList({ scope, ownResource, maxRows, expand }: {
  scope: TaskScope
  ownResource?: { type: string; id: string }
  maxRows?: number
  expand?: { expanded: boolean; onToggle: () => void }
}) {
  const [prefs] = useTaskListPrefs()
  const { terms } = useSearchContext()
  const query = useTasks(scope, { completed: prefs.showCompleted, archived: prefs.includeArchived })
  const mutations = useTaskMutations(scope)
  const { open } = useTaskModal()
  const [activeId, setActiveId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sections = buildSections(query.data ?? [], prefs, terms)
  // Every task the list shows, across its sections: Show all's count.
  const shownCount = sections.reduce((n, s) => n + s.tasks.length, 0)
  // Expanded drops the cap.
  const cap = expand?.expanded ? undefined : maxRows
  const sortDraggable = canDrag(prefs.sort)
  // Empty sections are not rendered at all, so a drag shifts nothing and
  // there is no empty target.
  const shown = sections.filter((s) => s.tasks.length > 0)
  const anyTasks = shown.length > 0
  // Priority order labels every group shown; otherwise labels appear once two
  // sections hold tasks.
  const labelled = prefs.sort === "priority" || shown.length > 1
  // A label adds height without adding a task, so the shape is more than the count.
  const shape = `${shownCount}|${labelled}|${shown.map((s) => `${s.key}:${s.tasks.length}`).join(",")}`
  const overflows = useOverflow(cap !== undefined, shape)
  const activeTask = activeId === null ? undefined : sections.flatMap((s) => s.tasks).find((t) => t.id === activeId)
  const anchor = quickAddAnchor(sections, prefs.sort)
  // Under a priority filter a "none" task would vanish on creation.
  const newPriority: Task["priority"] = prefs.priority === "all" ? "none" : prefs.priority

  const sensors = useSensors(
    // Only the grip starts a drag; a few pixels of travel so a press isn't one.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

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
    // Every drop lands on a row of a non-empty section, so a plan that
    // changes anything has a place.
    if (!plan.place) return
    mutations.move(id, plan.place, plan.patch).catch((e: unknown) => setError(errorText(e)))
  }

  const add = (input: { title: string; priority: Task["priority"]; starred: boolean }) => {
    setError(null)
    return mutations.create(anchor ? { ...input, after: anchor.id } : input).catch((e: unknown) => {
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
        // Rows are the only drop targets: the nearest one wins.
        collisionDetection={closestCenter}
        // Off for the same reason as ResourceList: it ran away with sticky
        // and capped scroll containers.
        autoScroll={false}
        // Re-measure drop targets throughout a drag: sortable transforms
        // move rows, and their rects must follow.
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
                  onOpen={open}
                />
              ))}
            </SortableContext>
          </SectionBlock>
        ))}
        {/* The dragged row follows the pointer here; its own slot stays put. */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <Box className="task-panel" style={{ cursor: "grabbing" }} data-testid="task-drag-overlay">
              <TaskRow task={activeTask} ownResource={ownResource} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} />
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
        ref={overflows.ref}
        data-testid="task-list-body"
        style={cap !== undefined ? { maxHeight: cappedMaxHeight(cap), overflowY: "auto" } : undefined}
      >
        {/* Observed for overflow: under a holding cap only this grows. */}
        <div ref={overflows.contentRef}>{body}</div>
      </Box>
      {expand && (expand.expanded || overflows.value) && (
        <Group justify="center">
          <Button variant="subtle" size="compact-xs" onClick={expand.onToggle}>
            {expand.expanded ? "Show less" : `Show all (${shownCount})`}
          </Button>
        </Group>
      )}
      <TaskQuickAdd onAdd={add} onOpen={(id) => open(id)} defaultPriority={newPriority} />
    </Stack>
  )
}
