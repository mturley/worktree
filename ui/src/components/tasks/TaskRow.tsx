import type { ReactNode } from "react"
import { ActionIcon, Badge, Group, Text, Tooltip } from "@mantine/core"
import type { Priority, Task, TaskState } from "../../api/types"
import { dueLabel, linkChip } from "../../lib/taskSections"
import { TaskStateCheckbox } from "./TaskStateCheckbox"

const PRIORITY_MARK: Record<Priority, { text: string; color: string } | null> = {
  high: { text: "!!!", color: "var(--mantine-color-red-4)" },
  medium: { text: "!!", color: "var(--mantine-color-amber-4, var(--mantine-color-yellow-4))" },
  low: { text: "!", color: "var(--mantine-color-gray-5)" },
  none: null,
}

const DUE_COLOR = {
  overdue: "red",
  today: "yellow",
  neutral: "gray",
} as const

/** One compact task line. A row click does nothing yet (the modal is Phase 3). */
export function TaskRow({ task, ownResource, dragHandle, onState, onToggleStar }: {
  task: Task
  ownResource?: { type: string; id: string }
  dragHandle?: ReactNode
  onState: (s: TaskState) => void
  onToggleStar: () => void
}) {
  const mark = PRIORITY_MARK[task.priority]
  const due = task.due ? dueLabel(task.due, new Date()) : null
  const link = linkChip(task, ownResource)
  return (
    <Group data-task-row gap="xs" wrap="nowrap" py={4} px="xs">
      <span className="task-grip" style={{ width: 14, flex: "none" }}>{dragHandle}</span>
      <TaskStateCheckbox state={task.state} title={task.title} onPick={onState} />
      <ActionIcon
        variant="transparent"
        size="sm"
        aria-label={task.starred ? `Unstar “${task.title}”` : `Star “${task.title}”`}
        aria-pressed={task.starred}
        onClick={onToggleStar}
        style={{ color: task.starred ? "var(--task-accent)" : "var(--mantine-color-dark-3)", flex: "none" }}
      >
        {task.starred ? "★" : "☆"}
      </ActionIcon>
      <Text
        span
        fw={700}
        size="sm"
        style={{ width: 22, flex: "none", color: mark?.color, visibility: mark ? "visible" : "hidden" }}
      >
        {mark?.text ?? "!"}
      </Text>
      <Text
        size="sm"
        truncate="end"
        style={{ flex: 1, minWidth: 0, opacity: task.state === "done" ? 0.6 : 1 }}
        td={task.state === "done" ? "line-through" : undefined}
      >
        {task.title}
      </Text>
      {due && (
        <Tooltip label={due.title}>
          <Badge size="xs" variant="light" color={DUE_COLOR[due.tone]} style={{ flex: "none" }}>
            {due.text}
          </Badge>
        </Tooltip>
      )}
      {task.subtasks_total > 0 && (
        <Badge size="xs" variant="light" color="gray" style={{ flex: "none" }}>
          {task.subtasks_done}/{task.subtasks_total}
        </Badge>
      )}
      {link && (
        <Badge
          data-testid="task-link-chip"
          size="xs"
          variant="outline"
          color="gray"
          style={{ flex: "none", borderStyle: link.archived ? "dashed" : "solid", textTransform: "none" }}
        >
          {link.archived ? `${link.text} · archived` : link.text}
        </Badge>
      )}
    </Group>
  )
}
