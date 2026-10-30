import { useMemo, useState, type ReactNode } from "react"
import { useLocation } from "wouter"
import { ActionIcon, Badge, Group, Text, Tooltip, UnstyledButton } from "@mantine/core"
import type { Priority, Task, TaskState } from "../../api/types"
import { dueLabel, linkChip } from "../../lib/taskSections"
import { serializeResourceKey } from "../../lib/resourceKey"
import { TaskStateCheckbox } from "./TaskStateCheckbox"
import { TaskPriorityMenu } from "./TaskPriorityMenu"
import { UnreadMarkerDot } from "../UnreadMarkerDot"
import { useCrossHover } from "../CrossHoverContext"
import { type CrossHoverItem, crossResourceRef } from "../../lib/crossHover"
import { useCmuxMatches } from "../../api/cmux"
import { BlockersHoverCard, ResourceHoverCard, WorkspaceLabel, WorktreeHoverCard } from "./LinkHoverCards"

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
 * The task as a cross-hover item (lib/crossHover): the resources it links,
 * and every worktree it belongs to — linked directly, or following one of
 * its linked resources.
 */
export function taskCrossHoverItem(task: Task): CrossHoverItem {
  const resources: string[] = []
  const paths = new Set(task.implicit_worktrees)
  for (const l of task.links) {
    if (l.kind === "worktree" && l.worktree) paths.add(l.worktree)
    if (l.kind === "resource" && l.resource_type && l.resource_id) {
      resources.push(crossResourceRef(l.resource_type, l.resource_id))
      for (const w of l.worktrees ?? []) paths.add(w)
    }
  }
  return { kind: "task", id: String(task.id), resources, paths: [...paths] }
}

/**
 * One compact task line. With `onOpen`, a click anywhere on the row opens the
 * task, and the title is a real button so the keyboard can too. The row's
 * controls (state checkbox and its portalled menu, star, grip, link chip)
 * keep their clicks to themselves.
 */
export function TaskRow({ task, ownResource, ownWorktree, dragHandle, onState, onPriority, onToggleStar, onOpen }: {
  task: Task
  ownResource?: { type: string; id: string }
  /** The worktree whose list this is: its own link chip is left out. */
  ownWorktree?: string
  dragHandle?: ReactNode
  onState: (s: TaskState) => void
  onPriority: (p: Priority) => void
  onToggleStar: () => void
  /** Opens the task's modal. Absent for the drag overlay's copy of the row. */
  onOpen?: () => void
}) {
  const due = task.due ? dueLabel(task.due, new Date()) : null
  const link = linkChip(task, ownResource, ownWorktree)
  const [, navigate] = useLocation()
  // Only a row that opens takes part in cross-hover: the drag overlay's copy
  // has no partners. Built once per task, so a hover elsewhere only tests it.
  const opens = !!onOpen
  const crossItem = useMemo(() => (opens ? taskCrossHoverItem(task) : null), [task, opens])
  const crossHover = useCrossHover(crossItem)
  // The full title on hover, only when the ellipsis cut it: measured as the
  // pointer arrives, so no observer runs per row.
  const [truncated, setTruncated] = useState(false)
  const measure = (e: React.SyntheticEvent<HTMLElement>) => {
    const el = e.currentTarget
    setTruncated(el.scrollWidth > el.clientWidth)
  }
  const titleText = (
    <Tooltip label={task.title} disabled={!truncated} openDelay={400} multiline maw={420}>
      <Text
        span
        size="sm"
        truncate="end"
        data-task-title
        onMouseEnter={measure}
        style={{ display: "block", opacity: task.state === "done" ? 0.6 : 1 }}
        td={task.state === "done" ? "line-through" : undefined}
      >
        {task.title}
      </Text>
    </Tooltip>
  )
  return (
    <Group
      data-task-row
      data-clickable={onOpen ? "true" : undefined}
      {...crossHover}
      gap="xs"
      wrap="nowrap"
      py={4}
      // No padding before the grip: rows sit at the panel's edge in every sort.
      pl={0}
      pr="xs"
      onClick={onOpen ? () => onOpen() : undefined}
      style={onOpen ? { cursor: "pointer" } : undefined}
    >
      {/* A plain click on the grip must not reach the row (it would open
          the modal). dnd-kit listens for mousedown, touchstart and keydown
          on the whole row (TaskList), which this leaves alone. The click
          after a real drag is swallowed by dnd-kit at the document. */}
      <span
        className="task-grip"
        style={{ width: 14, flex: "none" }}
        onClick={keepFromRow}
        onPointerDown={keepFromRow}
      >
        {dragHandle}
      </span>
      <TaskStateCheckbox state={task.state} priority={task.priority} title={task.title} onPick={onState} />
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
        <BlockersHoverCard blockers={task.open_blockers}>
          <Badge
            data-testid="task-blocked-chip"
            size="xs"
            variant="light"
            color="red"
            style={{ flex: "none", textTransform: "none" }}
          >
            ⛔ blocked
          </Badge>
        </BlockersHoverCard>
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
        <TaskLinkChip
          task={task}
          link={link}
          onClick={(e) => {
            keepFromRow(e)
            if (link.worktree) navigate(`/worktree/${encodeURIComponent(link.worktree)}`)
            else if (link.target) {
              const { worktree, resource } = link.target
              navigate(`/worktree/${encodeURIComponent(worktree)}?resource=${serializeResourceKey(resource)}`)
            }
          }}
        />
      )}
    </Group>
  )
}

/**
 * The row's link chip (linkChip). A worktree chip names the worktree's cmux
 * workspace when it has one, colour bar and all; hovering a worktree or
 * resource chip previews it. The chip truncates, and the preview has the
 * full names.
 */
function TaskLinkChip({ task, link, onClick }: {
  task: Task
  link: NonNullable<ReturnType<typeof linkChip>>
  onClick: (e: React.MouseEvent) => void
}) {
  // The chip names the first Focus link, when there is one.
  const focus = task.links.find((l) => l.focus)
  const more = task.links.length - 1
  // No path asks cmux about nothing: an empty path matches no workspace.
  const ws = useCmuxMatches(link.worktree ?? "")[0]
  const workspace = ws ? <WorkspaceLabel ws={ws} suffix={more > 0 ? ` +${more}` : undefined} /> : null
  const text = link.archived ? `${link.text} · archived` : link.text
  const chip = (
    <Badge
      data-testid="task-link-chip"
      // A worktree chip opens that worktree's page; a resource chip some
      // worktree follows opens that page with the resource selected; any
      // other chip just keeps its click from the row.
      {...(link.worktree || link.target
        ? {
            component: "button" as const,
            type: "button" as const,
            className: "task-link-chip-nav",
            "aria-label": link.worktree ? `Open worktree ${link.text}` : `Open ${link.text}`,
          }
        : {})}
      onClick={onClick}
      size="xs"
      variant="outline"
      color="gray"
      maw={200}
      style={{ flex: "none", borderStyle: link.archived ? "dashed" : "solid", textTransform: "none" }}
    >
      {workspace ?? text}
    </Badge>
  )
  if (link.worktree) return <WorktreeHoverCard path={link.worktree}>{chip}</WorktreeHoverCard>
  if (focus?.kind === "resource" && focus.resource_type && focus.resource_id) {
    return <ResourceHoverCard type={focus.resource_type} id={focus.resource_id}>{chip}</ResourceHoverCard>
  }
  return chip
}
