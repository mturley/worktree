import { useState, type ReactNode } from "react"
import { ActionIcon, Anchor, Button, Checkbox, Group, Menu, Stack, Text, UnstyledButton } from "@mantine/core"
import { IconChecklist, IconNote, IconWorld, IconX } from "@tabler/icons-react"
import type { TaskBlocker, TaskBlockerKind, TaskDetail } from "../../../api/types"
import { useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { GitHubMark } from "../../icons/GitHubMark"
import { JiraMark } from "../../icons/JiraMark"
import { SlackMark } from "../../icons/SlackMark"
import { BlockerPicker } from "./BlockerPicker"
import { useSectionAction } from "./sectionAction"
import { useTaskModal } from "./TaskModalProvider"

const KINDS: { kind: TaskBlockerKind; label: string }[] = [
  { kind: "task", label: "Task" },
  { kind: "resource", label: "Resource" },
  { kind: "other", label: "Other" },
]

/** Keeps a control's click from reaching a clickable (task blocker) row. */
const keepFromRow = (e: React.SyntheticEvent) => e.stopPropagation()

function kindIcon(b: TaskBlocker): ReactNode {
  const props = { size: 14, "aria-hidden": true, style: { flexShrink: 0 } } as const
  if (b.kind === "task") return <IconChecklist {...props} />
  if (b.kind === "other") return <IconNote {...props} />
  switch (b.resource_type) {
    case "pr":
      return <GitHubMark {...props} />
    case "jira":
      return <JiraMark {...props} />
    case "slack":
      return <SlackMark {...props} />
  }
  return <IconWorld {...props} />
}

/**
 * The sidebar's "Blocked by": the task's blockers, unresolved first. Each
 * shows its kind, label and status; a resolved one is dimmed with a check and
 * never red. Free-text, Slack thread and link blockers carry a manual resolve
 * checkbox; every blocker can be removed. "+ Add" picks a Task, a Resource
 * or Other.
 *
 * Nothing here navigates inside the app: a resource blocker's label opens its
 * page in a new tab, and a task blocker opens that task in this modal, in
 * place of this one (open() replaces the history entry while the modal is
 * open).
 */
export function BlockersSection({ task }: { task: TaskDetail }) {
  const m = useTaskDetailMutations(task.id)
  const { run, alert } = useSectionAction()
  const [adding, setAdding] = useState<TaskBlockerKind | null>(null)
  // Stable: the server already sends unresolved first, but the order is what
  // the section promises, so it does not rest on that.
  const blockers = [...task.blockers].sort((a, b) => Number(a.resolved) - Number(b.resolved))

  return (
    <Stack gap={4}>
      <Text size="xs" fw={500}>Blocked by</Text>
      {alert}
      {blockers.length === 0 ? (
        <Text size="xs" c="dimmed">Not blocked.</Text>
      ) : (
        <Stack gap={2}>
          {blockers.map((b) => (
            <BlockerRow
              key={b.id}
              b={b}
              onRemove={() => run(m.removeBlocker(b.id))}
              onResolve={(resolved) => run(m.resolveBlocker(b.id, resolved))}
            />
          ))}
        </Stack>
      )}
      {adding ? (
        <BlockerPicker task={task} kind={adding} onDone={() => setAdding(null)} />
      ) : (
        <Group>
          <Menu position="bottom-start" withinPortal>
            <Menu.Target>
              <Button size="compact-xs" variant="subtle">+ Add</Button>
            </Menu.Target>
            <Menu.Dropdown>
              {KINDS.map((k) => (
                <Menu.Item key={k.kind} onClick={() => setAdding(k.kind)}>{k.label}</Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </Group>
      )}
    </Stack>
  )
}

function BlockerRow({ b, onRemove, onResolve }: {
  b: TaskBlocker
  onRemove: () => void
  onResolve: (resolved: boolean) => void
}) {
  const { open } = useTaskModal()
  const taskId = b.kind === "task" ? b.task_id : undefined
  const openTask = taskId ? () => open(taskId) : undefined

  let label: ReactNode
  if (openTask) {
    label = (
      <UnstyledButton
        onClick={(e) => {
          // The row would open it too; once is enough.
          keepFromRow(e)
          openTask()
        }}
        style={{ display: "block", minWidth: 0 }}
      >
        <Text size="xs" truncate="end">{b.label}</Text>
      </UnstyledButton>
    )
  } else if (b.url) {
    label = (
      <Anchor href={b.url} target="_blank" rel="noreferrer" size="xs" truncate="end" display="block" onClick={keepFromRow}>
        {b.label}
      </Anchor>
    )
  } else {
    label = <Text size="xs" truncate="end">{b.label}</Text>
  }

  return (
    <Group
      data-testid="blocker-row"
      data-blocker-id={b.id}
      data-resolved={b.resolved ? "true" : undefined}
      gap={6}
      wrap="nowrap"
      align="flex-start"
      onClick={openTask}
      style={{ opacity: b.resolved ? 0.6 : 1, cursor: openTask ? "pointer" : undefined }}
    >
      <span style={{ display: "inline-flex", marginTop: 2 }}>{kindIcon(b)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {label}
        {(b.status_label || b.resolved) && (
          <Group gap={4} wrap="nowrap">
            {b.resolved && (
              <Text span size="xs" c="teal" role="img" aria-label="resolved">✓</Text>
            )}
            {b.status_label && <Text span size="xs" c="dimmed" truncate="end">{b.status_label}</Text>}
          </Group>
        )}
      </div>
      {b.manual_resolvable && (
        <Checkbox
          size="xs"
          mt={2}
          aria-label={`Resolved: ${b.label}`}
          checked={b.resolved}
          onClick={keepFromRow}
          onChange={(e) => onResolve(e.currentTarget.checked)}
        />
      )}
      <ActionIcon
        variant="subtle"
        color="gray"
        size="xs"
        aria-label={`Remove blocker ${b.label}`}
        onClick={(e) => {
          keepFromRow(e)
          onRemove()
        }}
      >
        <IconX size={12} />
      </ActionIcon>
    </Group>
  )
}
