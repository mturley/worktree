import type { ReactNode } from "react"
import { ActionIcon, Badge, Group, Text, Tooltip, UnstyledButton } from "@mantine/core"
import type { Priority, Task, TaskState } from "../../api/types"
import { dueLabel, linkChip } from "../../lib/taskSections"
import { TaskStateCheckbox } from "./TaskStateCheckbox"
import { TaskPriorityMenu } from "./TaskPriorityMenu"
import { UnreadMarkerDot } from "../UnreadMarkerDot"

const DUE_COLOR = {
  overdue: "red",
  today: "yellow",
  neutral: "gray",
} as const

/**
 * Stops a control's click from reaching the row, which would open the modal.
 * React bubbles synthetic events along the component tree, so this also
 * catches clicks inside portals rendered beneath it.
 */
const keepFromRow = (e: React.SyntheticEvent) => e.stopPropagation()

/**
 * One compact task line. With `onOpen`, a click anywhere on the row opens the
 * task, and the title is a real button so the keyboard can too. The row's
 * controls (state checkbox and its portalled menu, star, grip, link chip)
 * keep their clicks to themselves.
 */
export function TaskRow({ task, ownResource, dragHandle, flush, onState, onPriority, onToggleStar, onOpen }: {
  task: Task
  ownResource?: { type: string; id: string }
  dragHandle?: ReactNode
  /** No padding before the grip: the list has no section labels, so rows sit flush with the panel's edge. */
  flush?: boolean
  onState: (s: TaskState) => void
  onPriority: (p: Priority) => void
  onToggleStar: () => void
  /** Opens the task's modal. Absent for the drag overlay's copy of the row. */
  onOpen?: () => void
}) {
  const due = task.due ? dueLabel(task.due, new Date()) : null
  const link = linkChip(task, ownResource)
  const titleText = (
    <Text
      span
      size="sm"
      truncate="end"
      style={{ display: "block", opacity: task.state === "done" ? 0.6 : 1 }}
      td={task.state === "done" ? "line-through" : undefined}
    >
      {task.title}
    </Text>
  )
  return (
    <Group
      data-task-row
      gap="xs"
      wrap="nowrap"
      py={4}
      pl={flush ? 0 : "xs"}
      pr="xs"
      onClick={onOpen ? () => onOpen() : undefined}
      style={onOpen ? { cursor: "pointer" } : undefined}
    >
      {/* The grip is dnd-kit's activator. Its press must not reach the row
          (a plain click on it would open the modal); dnd-kit's own listeners
          sit on the grip itself, below this, so they still run. The click
          after a real drag is swallowed by dnd-kit at the document. */}
      <span
        className="task-grip"
        style={{ width: 14, flex: "none" }}
        onClick={keepFromRow}
        onPointerDown={keepFromRow}
      >
        {dragHandle}
      </span>
      <TaskStateCheckbox state={task.state} title={task.title} onPick={onState} />
      <ActionIcon
        className="task-row-control"
        variant="transparent"
        size="sm"
        aria-label={task.starred ? `Unstar “${task.title}”` : `Star “${task.title}”`}
        aria-pressed={task.starred}
        onClick={(e) => {
          keepFromRow(e)
          onToggleStar()
        }}
        style={{ color: task.starred ? "var(--task-accent)" : "var(--mantine-color-dark-3)", flex: "none" }}
      >
        {task.starred ? "★" : "☆"}
      </ActionIcon>
      <TaskPriorityMenu priority={task.priority} title={task.title} onPick={onPriority} />
      {onOpen ? (
        <UnstyledButton
          className="task-title-link"
          style={{ flex: 1, minWidth: 0, display: "block" }}
          onClick={(e) => {
            // The row would open it too; once is enough.
            keepFromRow(e)
            onOpen()
          }}
        >
          {titleText}
        </UnstyledButton>
      ) : (
        <div style={{ flex: 1, minWidth: 0 }}>{titleText}</div>
      )}
      {(task.unread_count ?? 0) > 0 && (
        // An agent's events newer than the task's read cursor. Opening the
        // modal does not clear it; only a mark read does.
        <UnreadMarkerDot label="unread task activity" />
      )}
      {task.blocked && task.state !== "done" && (
        // Never red for a resolved blocker: the server sends only the
        // unresolved ones' labels, and blocked only while one is left.
        // A done task is never blocked (the server agrees).
        <Tooltip
          multiline
          maw={320}
          label={
            <>
              <Text size="xs" fw={600}>Blocked by</Text>
              {task.blocker_labels.map((l, i) => (
                <Text size="xs" key={i}>{l}</Text>
              ))}
            </>
          }
        >
          <Badge
            data-testid="task-blocked-chip"
            size="xs"
            variant="light"
            color="red"
            style={{ flex: "none", textTransform: "none" }}
          >
            ⛔ blocked
          </Badge>
        </Tooltip>
      )}
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
          onClick={keepFromRow}
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
