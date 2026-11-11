import { useEffect, useRef, useState } from "react"
import { Alert, Button, Group, Stack, Text, Textarea } from "@mantine/core"
import { useTaskDetailMutations } from "../hooks/useTaskDetail"
import { errorText } from "./tasks/modal/sectionAction"
import type { TimelineEvent } from "../api/types"
import { taskEventNumericId } from "../lib/taskEventKey"

const MAX_LEN = 4000

/**
 * Edits or deletes one work log entry in place of its body. Esc cancels the
 * edit only: Mantine's Modal closes on Escape from a capture-phase window
 * listener that checks just event.target for data-mantine-stop-propagation,
 * so every focusable control here carries it and the wrapper handles Escape.
 */
export function WorkLogEditor({ event, onSaved, onDeleted, onCancel }: {
  event: TimelineEvent
  onSaved: (next: TimelineEvent) => void
  onDeleted: () => void
  onCancel: () => void
}) {
  const eventId = taskEventNumericId(event)
  const { editWorkLog, deleteWorkLog } = useTaskDetailMutations(Number(event.resource_id))
  const [text, setText] = useState(event.body ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The Edit button that opened this is gone, so focus would otherwise fall to
  // the page and Esc would reach the modal instead of this editor.
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    box.current?.focus()
  }, [])
  // Delete / Yes / No swap in place of each other, unmounting the focused
  // button; move focus explicitly so Esc keeps landing on a control that
  // carries the stop attribute instead of falling to the page (and the modal).
  const yesRef = useRef<HTMLButtonElement>(null)
  const deleteRef = useRef<HTMLButtonElement>(null)
  // Only on a change: not on mount (the textarea has focus then), however
  // many times the effect runs for it (StrictMode runs it twice).
  const prevConfirm = useRef(confirmDelete)
  useEffect(() => {
    if (prevConfirm.current === confirmDelete) return
    prevConfirm.current = confirmDelete
    ;(confirmDelete ? yesRef : deleteRef).current?.focus()
  }, [confirmDelete])
  const trimmed = text.trim()
  const canSave = eventId !== null && trimmed !== "" && !busy

  const save = async () => {
    if (!canSave || eventId === null) return
    // The server would write nothing (and stamp no edited_at), so neither
    // does this: an unchanged save just closes the editor.
    if (trimmed === (event.body ?? "")) {
      onCancel()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await editWorkLog(eventId, text)
      // The task detail response does not carry the event, so the edited copy
      // is patched locally (the server trims and stamps edited_at the same
      // way); the invalidation the mutation does corrects the feeds.
      onSaved({ ...event, body: trimmed, edited_at: new Date().toISOString() })
    } catch (e) {
      setError(`Couldn't save: ${errorText(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (eventId === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteWorkLog(eventId)
      onDeleted()
    } catch (e) {
      setError(`Couldn't delete: ${errorText(e)}`)
      setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }

  const stop = { "data-mantine-stop-propagation": "true" } as const

  return (
    <Stack
      gap="xs"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
    >
      <Textarea
        aria-label="Work log note"
        autosize
        minRows={3}
        maxLength={MAX_LEN}
        ref={box}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void save()
          }
        }}
        {...stop}
      />
      {error && (
        <Alert color="red" variant="light" py={4}>
          <Text size="xs">{error}</Text>
        </Alert>
      )}
      <Group justify="space-between" gap="xs">
        {confirmDelete ? (
          <Group gap={6}>
            <Text size="sm">Delete?</Text>
            <Button ref={yesRef} size="xs" color="red" loading={busy} {...stop} onClick={() => void remove()}>Yes</Button>
            <Button size="xs" variant="default" disabled={busy} {...stop} onClick={() => setConfirmDelete(false)}>No</Button>
          </Group>
        ) : (
          <Button ref={deleteRef} size="xs" variant="subtle" color="red" disabled={busy} {...stop} onClick={() => setConfirmDelete(true)}>Delete</Button>
        )}
        <Group gap="xs">
          <Button size="xs" variant="default" disabled={busy} {...stop} onClick={onCancel}>Cancel</Button>
          <Button size="xs" disabled={!canSave} loading={busy && !confirmDelete} {...stop} onClick={() => void save()}>Save</Button>
        </Group>
      </Group>
    </Stack>
  )
}
