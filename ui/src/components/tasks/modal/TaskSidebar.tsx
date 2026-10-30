import { useState, type ReactNode } from "react"
import { ActionIcon, Button, Checkbox, Group, Select, Stack, Text, TextInput } from "@mantine/core"
import type { Priority, TaskDetail, TaskState } from "../../../api/types"
import { relativeTime } from "../../../lib/relativeTime"
import { StateBox, TASK_STATE_LABEL, TASK_STATES } from "../TaskStateCheckbox"
import { PRIORITY_LABEL, PriorityGlyph } from "../TaskPriorityMenu"
import { BlockersSection } from "./BlockersSection"
import type { TaskPatch } from "./useOptimisticTask"

const STATES: { value: TaskState; label: string }[] = TASK_STATES.map((value) => ({ value, label: TASK_STATE_LABEL[value] }))

/** The sidebar lists the priorities lowest first, as it always has. */
const PRIORITIES: { value: Priority; label: string }[] = (["none", "low", "medium", "high"] as const).map((value) => ({
  value,
  label: PRIORITY_LABEL[value],
}))

/** An option with its icon on the left, as the row's menus show them. */
function option(icon: ReactNode, label: string) {
  return (
    <Group gap={8} wrap="nowrap">
      {icon}
      <span>{label}</span>
    </Group>
  )
}

/** Visible on both tabs. Every control saves on change. */
export function TaskSidebar({ task, onUpdate, onState, onDelete }: {
  task: TaskDetail
  onUpdate: (patch: TaskPatch) => void
  onState: (s: TaskState) => void
  onDelete: () => void
}) {
  return (
    <Stack gap="sm">
      <Select
        label="State"
        size="xs"
        data={STATES}
        value={task.state}
        allowDeselect={false}
        leftSection={<StateBox state={task.state} size={14} priority={task.priority} />}
        renderOption={({ option: o }) => option(<StateBox state={o.value as TaskState} size={14} priority={task.priority} />, o.label)}
        onChange={(v) => v && onState(v as TaskState)}
      />
      <Select
        label="Priority"
        size="xs"
        data={PRIORITIES}
        value={task.priority}
        allowDeselect={false}
        leftSection={<PriorityGlyph priority={task.priority} />}
        renderOption={({ option: o }) => option(<PriorityGlyph priority={o.value as Priority} />, o.label)}
        onChange={(v) => v && onUpdate({ priority: v as Priority })}
      />
      <Group gap={4} align="flex-end" wrap="nowrap">
        <TextInput
          type="date"
          label="Due date"
          size="xs"
          style={{ flex: 1 }}
          value={task.due ?? ""}
          // A cleared native date input reports "": the clear button is the
          // way to send that, so an emptied field is ignored here.
          onChange={(e) => {
            const v = e.currentTarget.value
            if (v && v !== task.due) onUpdate({ due: v })
          }}
        />
        <ActionIcon
          variant="subtle"
          color="gray"
          size="md"
          aria-label="Clear due date"
          disabled={!task.due}
          onClick={() => onUpdate({ due: "" })}
        >
          ×
        </ActionIcon>
      </Group>
      <Checkbox
        label="Starred"
        size="xs"
        checked={task.starred}
        onChange={(e) => onUpdate({ starred: e.currentTarget.checked })}
      />
      <BlockersSection task={task} />
      <Stack gap={2}>
        <Stamp label="Created" ts={task.created_at} />
        <Stamp label="Started" ts={task.started_at} />
        <Stamp label="Updated" ts={task.updated_at} />
        <Stamp label="Completed" ts={task.completed_at} />
      </Stack>
      <DeleteControl onDelete={onDelete} />
    </Stack>
  )
}

/**
 * Asks first, inline (Mantine's modals manager isn't installed), even though
 * the delete also offers an undo: a task can carry a lot.
 */
function DeleteControl({ onDelete }: { onDelete: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <Button variant="subtle" color="red" size="xs" onClick={() => setAsking(true)}>
        Delete task
      </Button>
    )
  }
  return (
    <Group gap="xs" wrap="nowrap">
      <Text size="sm">Delete?</Text>
      <Button size="xs" color="red" onClick={onDelete}>Yes</Button>
      <Button size="xs" variant="default" onClick={() => setAsking(false)}>No</Button>
    </Group>
  )
}

function Stamp({ label, ts }: { label: string; ts?: string }) {
  return (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <Text size="xs" c="dimmed">{label}</Text>
      {ts ? (
        <Text size="xs" title={new Date(ts).toLocaleString()}>{relativeTime(ts)}</Text>
      ) : (
        <Text size="xs" c="dimmed">—</Text>
      )}
    </Group>
  )
}
