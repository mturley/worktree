import { useRef, useState } from "react"
import { ActionIcon, Button, CloseButton, Group, Modal, Text, TextInput, UnstyledButton } from "@mantine/core"
import { notifications } from "@mantine/notifications"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../api/client"
import type { TaskDetail, TaskState } from "../../../api/types"
import { showUndoToast, UNDO_WINDOW_MS } from "../../UndoToast"
import { TaskStateCheckbox } from "../TaskStateCheckbox"
import type { TaskPatch } from "./useOptimisticTask"

/**
 * Marks one task's activity read, offering an undo, as Mark all read does
 * for a feed.
 *
 * It marks through the task's unread_through_ts: the newest of the unread
 * events its unread_count counted, from the same server snapshot. So it
 * clears exactly what the header promised, and an agent event that arrived
 * after render stays unread (the through_ts contract; see "Unread" in
 * docs/web-ui-architecture.md). A task without one, or a mark that moved
 * nothing (read further elsewhere since), says "Already read" rather than
 * offering an undo of nothing. Opening the modal marks nothing.
 */
function useMarkTaskRead(task: TaskDetail) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tasks"] })
    void qc.invalidateQueries({ queryKey: ["worktrees"] })
    void qc.invalidateQueries({ queryKey: ["resources"] })
    void qc.invalidateQueries({ queryKey: ["timeline"] })
  }
  const alreadyRead = () => notifications.show({ message: "Already read", autoClose: 3000 })
  return useMutation({
    mutationFn: async () => {
      const { id, unread_through_ts: through } = task
      const count = task.unread_count ?? 0
      if (!through) return alreadyRead()
      const change = await api.taskRead({ id, through_ts: through })
      if (change.previous_ts === change.last_read_ts) return alreadyRead()
      showUndoToast({
        message: `Marked ${count} task ${count === 1 ? "event" : "events"} read`,
        undo: () => api.taskReadRestore({ id, ...change }),
        onSettled: refresh,
      })
    },
    onError: (err) =>
      notifications.show({
        color: "red",
        autoClose: UNDO_WINDOW_MS,
        message: `Couldn't mark read: ${err instanceof Error ? err.message : String(err)}`,
      }),
    onSettled: refresh,
  })
}

/** State checkbox · star · title (editable in place) · Mark read (while unread) · close. */
export function TaskModalHeader({ task, onUpdate, onState, onClose }: {
  task: TaskDetail
  onUpdate: (patch: TaskPatch) => void
  onState: (s: TaskState) => void
  onClose: () => void
}) {
  // Here, not in a child that renders only while unread: the mark's own
  // refetch removes the button, and the mutation must outlive it.
  const markRead = useMarkTaskRead(task)
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      <TaskStateCheckbox state={task.state} title={task.title} onPick={onState} />
      <ActionIcon
        variant="transparent"
        size="md"
        aria-label={task.starred ? `Unstar “${task.title}”` : `Star “${task.title}”`}
        aria-pressed={task.starred}
        onClick={() => onUpdate({ starred: !task.starred })}
        style={{ color: task.starred ? "var(--task-accent)" : "var(--mantine-color-dark-3)", flex: "none" }}
      >
        {task.starred ? "★" : "☆"}
      </ActionIcon>
      <EditableTitle title={task.title} onSave={(title) => onUpdate({ title })} />
      <Text size="xs" c="dimmed" style={{ flex: "none" }}>{task.ref}</Text>
      {(task.unread_count ?? 0) > 0 && (
        <Button
          size="compact-xs"
          variant="filled"
          color="blue"
          loading={markRead.isPending}
          onClick={() => markRead.mutate()}
          style={{ flex: "none" }}
        >
          Mark read
        </Button>
      )}
      <CloseButton aria-label="Close task" onClick={onClose} style={{ flex: "none" }} />
    </Group>
  )
}

/**
 * The draft lives only while editing, seeded from the title at the moment the
 * edit starts, so a refetch that changes the title underneath can never touch
 * what's being typed. Enter or blur saves; Esc reverts.
 */
function EditableTitle({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  // Enter and Esc both end the edit, and the input's unmount can then fire a
  // blur; this makes sure only the first of them counts.
  const ended = useRef(false)

  const start = () => {
    ended.current = false
    setDraft(title)
  }
  const finish = (save: boolean) => {
    if (ended.current || draft === null) return
    ended.current = true
    const next = draft.trim()
    if (save && next && next !== title) onSave(next)
    setDraft(null)
  }

  if (draft === null) {
    return (
      <UnstyledButton
        aria-label={`Edit title: ${title}`}
        onClick={start}
        style={{ flex: 1, minWidth: 0 }}
      >
        <ModalTitleText title={title} />
      </UnstyledButton>
    )
  }
  return (
    <>
      {/* Keeps the dialog named by the saved title while it is edited. */}
      <ModalTitleText title={title} hidden />
      <TextInput
        aria-label="Title"
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
        // Mantine's Modal closes on Escape from a capture-phase window listener;
        // this attribute is the one thing it checks to leave the key alone.
        data-mantine-stop-propagation="true"
        style={{ flex: 1, minWidth: 0 }}
        styles={{ input: { fontWeight: 600, fontSize: "var(--mantine-font-size-lg)" } }}
      />
    </>
  )
}

/**
 * The title as the modal's Modal.Title: Mantine points the dialog's
 * aria-labelledby at it, so the dialog is named by the task's title. A span,
 * since it sits inside the title's button.
 */
function ModalTitleText({ title, hidden }: { title: string; hidden?: boolean }) {
  return (
    <Modal.Title
      component="span"
      hidden={hidden}
      fw={600}
      fz="lg"
      style={{ display: hidden ? "none" : "block", lineHeight: 1.55, overflowWrap: "anywhere" }}
    >
      {title}
    </Modal.Title>
  )
}
