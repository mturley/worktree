import { useRef, useState } from "react"
import { ActionIcon, CloseButton, Group, Modal, Text, TextInput, UnstyledButton } from "@mantine/core"
import type { TaskDetail, TaskState } from "../../../api/types"
import { TaskStateCheckbox } from "../TaskStateCheckbox"
import type { TaskPatch } from "./useOptimisticTask"

/** State checkbox · star · title (editable in place) · close. */
export function TaskModalHeader({ task, onUpdate, onState, onClose }: {
  task: TaskDetail
  onUpdate: (patch: TaskPatch) => void
  onState: (s: TaskState) => void
  onClose: () => void
}) {
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
