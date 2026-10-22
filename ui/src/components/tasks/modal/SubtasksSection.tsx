import { useEffect, useRef, useState } from "react"
import { ActionIcon, Box, Checkbox, Group, Stack, Text, TextInput, Title, UnstyledButton } from "@mantine/core"
import { IconGripVertical, IconX } from "@tabler/icons-react"
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { TaskDetail, TaskSubtask } from "../../../api/types"
import { taskDetailKey, useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { useQueryClient } from "@tanstack/react-query"
import { errorText, useSectionAction } from "./sectionAction"

const sortableId = (id: number) => `subtask:${id}`

/**
 * The task's checklist: "done/total", add on Enter (focus stays for the
 * next), check to write at once, click the text to edit in place, ✕ to
 * remove, and drag the grip to reorder.
 */
export function SubtasksSection({ task }: { task: TaskDetail }) {
  const m = useTaskDetailMutations(task.id)
  const qc = useQueryClient()
  const { run, alert, setError } = useSectionAction()
  const [text, setText] = useState("")
  const [adding, setAdding] = useState(false)
  // The optimistic order while a reorder saves, as ResourceList's `pending`.
  const [pending, setPending] = useState<number[] | null>(null)
  const saving = useRef(0)
  useEffect(() => {
    if (saving.current === 0) setPending(null)
  }, [task.subtasks])

  const sensors = useSensors(
    // Copied from ResourceList: only the grip drags, after a few pixels.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const byId = new Map(task.subtasks.map((s) => [s.id, s]))
  const shown: TaskSubtask[] = pending
    ? [
        ...pending.flatMap((id) => byId.get(id) ?? []),
        // Anything added since the drag began goes last, as the server would.
        ...task.subtasks.filter((s) => !pending.includes(s.id)),
      ]
    : task.subtasks
  const done = shown.filter((s) => s.checked).length

  const patchSubtask = (id: number, fields: Partial<TaskSubtask>) =>
    qc.setQueryData<TaskDetail>(taskDetailKey(task.id), (cur) =>
      cur ? { ...cur, subtasks: cur.subtasks.map((s) => (s.id === id ? { ...s, ...fields } : s)) } : cur,
    )

  const add = async () => {
    const t = text.trim()
    if (!t || adding) return
    setAdding(true)
    setError(null)
    // Cleared as it is sent, so whatever is typed during the save survives it.
    setText("")
    try {
      await m.addSubtask(t)
    } catch (e) {
      // Back in the input to retry, unless something new was typed since;
      // the alert says why.
      setText((cur) => (cur === "" ? t : cur))
      setError(errorText(e))
    } finally {
      setAdding(false)
    }
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const ids = shown.map((s) => s.id)
    const from = ids.findIndex((id) => sortableId(id) === active.id)
    const to = ids.findIndex((id) => sortableId(id) === over.id)
    if (from < 0 || to < 0) return
    const next = arrayMove(ids, from, to)
    setPending(next)
    saving.current++
    run(
      m.orderSubtasks(next).finally(() => {
        // As LinksSection: the cache now holds the server's order.
        if (--saving.current === 0) setPending(null)
      }),
    )
  }

  return (
    <Stack gap={6}>
      <Group gap="xs">
        <Title order={6}>Subtasks</Title>
        {shown.length > 0 && <Text size="xs" c="dimmed">{done}/{shown.length}</Text>}
      </Group>
      {alert}
      <DndContext sensors={sensors} collisionDetection={closestCenter} autoScroll={false} onDragEnd={onDragEnd}>
        <SortableContext items={shown.map((s) => sortableId(s.id))} strategy={verticalListSortingStrategy}>
          <Stack gap={2} data-subtask-list>
            {shown.map((s) => (
              <SubtaskRow
                key={s.id}
                s={s}
                onCheck={(checked) => {
                  patchSubtask(s.id, { checked })
                  run(m.checkSubtask(s.id, checked))
                }}
                onEdit={(t) => {
                  patchSubtask(s.id, { text: t })
                  run(m.editSubtask(s.id, t))
                }}
                onRemove={() => run(m.removeSubtask(s.id))}
              />
            ))}
          </Stack>
        </SortableContext>
      </DndContext>
      <TextInput
        size="xs"
        aria-label="New subtask"
        placeholder="Add a subtask"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            void add()
          }
        }}
      />
    </Stack>
  )
}

function SubtaskRow({ s, onCheck, onEdit, onRemove }: {
  s: TaskSubtask
  onCheck: (checked: boolean) => void
  onEdit: (text: string) => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: sortableId(s.id) })
  const [draft, setDraft] = useState<string | null>(null)
  // Ends an edit once: Enter or Escape unmounts the input, and a blur that
  // follows from the same render must not save (or save twice).
  const editing = useRef(false)
  const startEdit = () => {
    editing.current = true
    setDraft(s.text)
  }

  const finish = (save: boolean) => {
    if (!editing.current) return
    editing.current = false
    const t = draft?.trim()
    setDraft(null)
    if (save && t && t !== s.text) onEdit(t)
  }

  return (
    <Group
      ref={setNodeRef}
      data-subtask-sortable
      gap={6}
      wrap="nowrap"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
        position: "relative",
        opacity: isDragging ? 0.6 : 1,
      }}
    >
      <ActionIcon
        ref={setActivatorNodeRef}
        variant="subtle"
        color="gray"
        size="sm"
        style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
        {...attributes}
        {...listeners}
        aria-label={`Drag to reorder ${s.text}`}
      >
        <IconGripVertical size={14} />
      </ActionIcon>
      <Checkbox
        size="xs"
        aria-label={`Subtask done: ${s.text}`}
        checked={s.checked}
        onChange={(e) => onCheck(e.currentTarget.checked)}
      />
      <Box style={{ flex: 1, minWidth: 0 }}>
        {draft === null ? (
          <UnstyledButton
            aria-label={`Edit subtask: ${s.text}`}
            onClick={startEdit}
            style={{ width: "100%" }}
          >
            <Text
              size="sm"
              td={s.checked ? "line-through" : undefined}
              c={s.checked ? "dimmed" : undefined}
              style={{ overflowWrap: "anywhere" }}
            >
              {s.text}
            </Text>
          </UnstyledButton>
        ) : (
          <TextInput
            size="xs"
            aria-label="Subtask text"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={() => finish(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                finish(true)
              } else if (e.key === "Escape") {
                e.preventDefault()
                finish(false)
              }
            }}
            data-mantine-stop-propagation="true"
          />
        )}
      </Box>
      <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`Remove subtask: ${s.text}`} onClick={onRemove}>
        <IconX size={14} />
      </ActionIcon>
    </Group>
  )
}
