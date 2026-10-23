import { useState } from "react"
import { ActionIcon, Button, Checkbox, Group, NativeSelect, Stack, Text, TextInput } from "@mantine/core"
import type { Priority, TaskDetail, TaskState } from "../../../api/types"
import { relativeTime } from "../../../lib/relativeTime"
import { BlockersSection } from "./BlockersSection"
import type { TaskPatch } from "./useOptimisticTask"

const STATES: { value: TaskState; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
]

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]

/** Visible on both tabs. Every control saves on change. */
export function TaskSidebar({ task, onUpdate, onState, onDelete }: {
  task: TaskDetail
  onUpdate: (patch: TaskPatch) => void
  onState: (s: TaskState) => void
  onDelete: () => void
}) {
  return (
    <Stack gap="sm">
      <NativeSelect
        label="State"
        size="xs"
        data={STATES}
        value={task.state}
        onChange={(e) => onState(e.currentTarget.value as TaskState)}
      />
      <NativeSelect
        label="Priority"
        size="xs"
        data={PRIORITIES}
        value={task.priority}
        onChange={(e) => onUpdate({ priority: e.currentTarget.value as Priority })}
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

/** Mantine's modals manager isn't installed, so the confirmation is inline. */
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
