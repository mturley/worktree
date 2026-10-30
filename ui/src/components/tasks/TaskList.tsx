import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ActionIcon, Alert, Box, Button, Divider, Stack, Text, Tooltip } from "@mantine/core"
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
  type Active,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Over,
} from "@dnd-kit/core"
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { Task, TaskState } from "../../api/types"
import { useTaskMutations, useTasks, type TaskScope } from "../../hooks/useTasks"
import { useTaskListPrefs } from "../../hooks/useTaskListPrefs"
import { applyMove, buildSections, canDrag, quickAddAnchor, type TaskSection } from "../../lib/taskSections"
import { useSearchContext } from "../search/SearchContext"
import { useTaskModal } from "./modal/TaskModalProvider"
import { PRIORITY_LABEL, PRIORITY_MARK } from "./TaskPriorityMenu"
import { TaskQuickAdd } from "./TaskQuickAdd"
import { TaskRow } from "./TaskRow"
import { TASK_STATE_LABEL } from "./TaskStateCheckbox"
import { taskUndoMessage, useOfferTaskUndo } from "./taskUndo"
import { dropHint, dropIndicatorFor, dropPlanFor, taskDraggableId, type DropIndicator } from "./taskDrag"
import { useSuspendCrossHover } from "../CrossHoverContext"

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

const DRAG_HINT = "Drag to reorder works in Custom, Priority or State order"

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Whether the dragged row's centre is below the centre of the row it is over. */
function isBelow(active: Active, over: Over): boolean {
  const dragged = active.rect.current.translated
  return dragged ? dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2 : false
}

/**
 * Whether a capped body overflows its cap: measured after layout, and again
 * whenever the capped box or the content inside it resizes, or the list's
 * shape (`shape`: its count and sections) changes. Under a cap that
 * holds, the box keeps its size while its content grows, so the content is
 * observed too (`contentRef`), and `shape` covers environments without
 * ResizeObserver.
 *
 * Uncapped (expanded), the last answer is kept rather than reset: it is what
 * shows the footer (Show less) while expanded, and a reset would unmount
 * that button on the way back, taking the keyboard focus with it.
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
function SortableTaskRow({ task, section, sortDraggable, dropEdge, ownResource, ownWorktree, mutations, onError, onOpen }: {
  task: Task
  section: TaskSection
  sortDraggable: boolean
  /** A cross-section drag will land on this edge of the row: draw the line. */
  dropEdge?: DropIndicator["edge"]
  ownResource?: { type: string; id: string }
  ownWorktree?: string
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
      // The row's own slot, while the DragOverlay copy follows the pointer:
      // an empty outlined placeholder (theme.css), never a faded copy, whose
      // text would show through the copy passing over it.
      className={isDragging ? "task-drag-placeholder" : undefined}
      data-dragging={isDragging || undefined}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
        position: "relative",
      }}
    >
      {/* Absolute, so drawing it moves nothing under the pointer. */}
      {dropEdge && <div className="task-drop-line" data-task-drop-line={dropEdge} aria-hidden />}
      <TaskRow
        task={task}
        ownResource={ownResource}
        ownWorktree={ownWorktree}
        dragHandle={grip}
        onState={pickState}
        onPriority={(priority) => run(update(task.id, { priority }))}
        onToggleStar={() => run(update(task.id, { starred: !task.starred }))}
        onOpen={() => onOpen(task.id)}
      />
    </div>
  )
}

/** A pinned group's prefix on its band tags. */
const PIN_TAG = { in_progress: "▶", starred: "★" } as const

/** A section's name on its band while a drag is on. */
function bandTag(section: TaskSection): string {
  if (section.priority) {
    // Priority sort's pinned groups: "★ High", "▶ No priority".
    if (section.pin) {
      const tag = PIN_TAG[section.pin]
      return section.priority === "none" ? `${tag} No priority` : `${tag} ${PRIORITY_LABEL[section.priority]}`
    }
    const mark = PRIORITY_MARK[section.priority]
    return mark ? `${mark.text} ${PRIORITY_LABEL[section.priority]}` : "No priority"
  }
  if (section.pin === "in_progress") return "▶ In progress"
  if (section.pin === "starred") return "★ Starred"
  // State sort's groups: "In progress", "Not started".
  if (section.key.startsWith("state:") && section.state) return TASK_STATE_LABEL[section.state]
  return "Tasks"
}

/**
 * A section: its rows, under no label. Only sections that hold tasks are
 * rendered, so there is nothing to drop onto but rows: a drop's section
 * follows from the row it lands on.
 *
 * While a drag is on, a draggable section is a band (outline and wash, with a
 * tag naming it), so the drop's sections are evident. What landing changes
 * is said on the dragged copy instead (the DragOverlay's hint). Both are
 * drawn out of the flow: nothing moves when a drag starts.
 */
function SectionBlock({ section, band, dropTarget, children }: {
  section: TaskSection
  band: boolean
  /** A drag from another section will land here: outlined, as ResourceGroup's isOver. */
  dropTarget: boolean
  children: React.ReactNode
}) {
  return (
    <Stack
      gap={0}
      data-task-section={section.key}
      data-task-band={band || undefined}
      data-drop-target={dropTarget || undefined}
      style={{ position: "relative" }}
    >
      {band && (
        <span className="task-band-tag" data-task-band-tag aria-hidden style={{ position: "absolute" }}>
          {bandTag(section)}
        </span>
      )}
      {children}
    </Stack>
  )
}

/**
 * One task list, used everywhere: sections (pinned in progress and starred
 * on top, priority groups, completed last), drag reordering across sections, and quick add at the
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
  expand?: {
    expanded: boolean
    onToggle: () => void
    /** Told whether the capped list overflows, whenever that changes. */
    onOverflow?: (overflows: boolean) => void
  }
}) {
  const [prefs] = useTaskListPrefs()
  // A worktree's own list leaves out chips naming that same worktree.
  const ownWorktree = scope.kind === "worktree" ? scope.path : undefined
  const { terms } = useSearchContext()
  const query = useTasks(scope, { completed: prefs.showCompleted, archived: prefs.includeArchived })
  const mutations = useTaskMutations(scope)
  const offerUndo = useOfferTaskUndo()
  const { open } = useTaskModal()
  const [activeId, setActiveId] = useState<number | null>(null)
  // A drag sweeps the pointer across rows it means nothing about.
  useSuspendCrossHover(activeId !== null)
  const [error, setError] = useState<string | null>(null)
  // Where a cross-section drag will land, while one is over another section.
  const [indicator, setIndicator] = useState<DropIndicator | null>(null)
  // The list as of the latest drop, as ResourceList's `pending`: while set it
  // wins over the query, so a refetch landing mid-save (an SSE invalidation
  // between the star/priority update and the move, say) can't flash the old
  // order. Cleared once every save has settled and its refetch has landed —
  // mutations.move resolves only then — or on failure, when the cache is
  // already rolled back.
  const [pending, setPending] = useState<Task[] | null>(null)
  const saving = useRef(0)

  const tasks = pending ?? query.data ?? []
  const sections = buildSections(tasks, prefs, terms)
  // Every task the list shows, across its sections: Show all's count.
  const shownCount = sections.reduce((n, s) => n + s.tasks.length, 0)
  // Expanded drops the cap.
  const cap = expand?.expanded ? undefined : maxRows
  const sortDraggable = canDrag(prefs.sort)
  // Empty sections are not rendered at all, so a drag shifts nothing and
  // there is no empty target.
  const shown = sections.filter((s) => s.tasks.length > 0)
  const anyTasks = shown.length > 0
  const shape = `${shownCount}|${shown.map((s) => `${s.key}:${s.tasks.length}`).join(",")}`
  const overflows = useOverflow(cap !== undefined, shape)
  const onOverflow = expand?.onOverflow
  useEffect(() => {
    onOverflow?.(overflows.value)
  }, [onOverflow, overflows.value])
  const activeTask = activeId === null ? undefined : sections.flatMap((s) => s.tasks).find((t) => t.id === activeId)
  const anchor = quickAddAnchor(sections, prefs.sort)
  // What the drop will change, in words, for the dragged copy.
  const dragHint = dropHint(indicator?.patch)

  const sensors = useSensors(
    // Only the grip starts a drag; a few pixels of travel so a press isn't one.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(Number(String(active.id).replace(/^task:/, "")))
  }

  // On every move, not just when `over` changes: which side of the hovered
  // row the drop lands on follows the pointer within that row.
  const handleDragMove = ({ active, over }: DragMoveEvent) => {
    const next = over ? dropIndicatorFor(sections, active.id, over.id, isBelow(active, over)) : null
    setIndicator((cur) =>
      cur?.section === next?.section && cur?.id === next?.id && cur?.edge === next?.edge &&
      dropHint(cur?.patch) === dropHint(next?.patch) ? cur : next,
    )
  }

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    setIndicator(null)
    if (!over) return
    const plan = dropPlanFor(sections, active.id, over.id, isBelow(active, over))
    const id = Number(String(active.id).replace(/^task:/, ""))
    // Every drop lands on a row of a non-empty section, so a plan that
    // changes anything has a place.
    if (!plan.place) return
    // In this same render as the overlay's removal, so the row never shows
    // back in its old slot while the save is in flight.
    setPending(applyMove(tasks, id, plan.place, plan.patch))
    setError(null)
    saving.current++
    // A drop that changes state offers the same undo as the row's state
    // picker; the title as dropped, so a rename meanwhile can't change it.
    const title = tasks.find((t) => t.id === id)?.title ?? ""
    const state = plan.patch?.state
    mutations
      .move(id, plan.place, plan.patch)
      .then((t) => {
        if (t && state) offerUndo(t.undo_event_id, taskUndoMessage.state(title, state))
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => {
        saving.current--
        if (saving.current === 0) setPending(null)
      })
  }

  const handleDragCancel = () => {
    setActiveId(null)
    setIndicator(null)
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
        onDragMove={handleDragMove}
        onDragOver={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {shown.map((s, i) => (
          <Fragment key={s.key}>
          <SectionBlock
            section={s}
            band={activeId !== null && s.draggable}
            dropTarget={indicator?.section === s.key}
          >
            <SortableContext items={s.tasks.map((t) => taskDraggableId(t.id))} strategy={verticalListSortingStrategy}>
              {s.tasks.map((t) => (
                <SortableTaskRow
                  key={t.id}
                  task={t}
                  section={s}
                  sortDraggable={sortDraggable}
                  dropEdge={indicator?.id === t.id ? indicator.edge : undefined}
                  ownResource={ownResource}
                  ownWorktree={ownWorktree}
                  mutations={mutations}
                  onError={setError}
                  onOpen={open}
                />
              ))}
            </SortableContext>
          </SectionBlock>
          {/* A subtle line under a pinned group, when others follow.
              Always rendered (not only mid-drag), so a drag shifts nothing. */}
          {s.pin && shown[i + 1] && shown[i + 1].pin !== s.pin && (
            <Divider my={4} data-task-pin-divider={s.pin} />
          )}
          </Fragment>
        ))}
        {/* The dragged row follows the pointer here, its own slot left as an
            empty placeholder. On an opaque, lifted surface (theme.css): the
            panel's own wash is translucent, and the rows it passes over showed
            through it. What the drop will change rides on it, just above its
            top-left corner, out of the flow. */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <Box className="task-drag-overlay" data-testid="task-drag-overlay" style={{ position: "relative" }}>
              {dragHint && (
                <span className="task-band-tag task-drop-hint" data-task-drop-hint style={{ position: "absolute" }}>
                  {dragHint}
                </span>
              )}
              <TaskRow task={activeTask} ownResource={ownResource} ownWorktree={ownWorktree} onState={() => {}} onPriority={() => {}} onToggleStar={() => {}} />
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
      {/* Only for a list that overflows its cap: one expanded only to widen
          its column (it fits) has nothing to show less of, and leaves by
          the panel's summary toggle. */}
      {expand && overflows.value && (
        <Button variant="subtle" size="compact-xs" fullWidth justify="flex-start" onClick={expand.onToggle}>
          {expand.expanded ? "Show less" : `Show all (${shownCount})`}
        </Button>
      )}
      <TaskQuickAdd onAdd={add} onOpen={(id) => open(id)} />
    </Stack>
  )
}
