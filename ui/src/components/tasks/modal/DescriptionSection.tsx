import { useEffect, useState } from "react"
import { Alert, Button, Group, Stack, Text, Textarea, Title } from "@mantine/core"
import { useQueryClient } from "@tanstack/react-query"
import type { TaskDetail } from "../../../api/types"
import { taskDetailKey, useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { useUnsavedChanges } from "../../../lib/unsavedChanges"
import { NotesMarkdown } from "../../NotesMarkdown"
import { errorText } from "./sectionAction"

/**
 * Where an unsaved description draft is kept, per task, for this browser
 * tab. The modal can't stop the browser's Back button from closing it, so
 * the draft outlives the modal here and comes back when the task is opened
 * again. Storage can be missing or refuse (a private window): every access
 * is wrapped, and without it a draft simply isn't kept.
 */
const draftKey = (id: number) => `task-description-draft:${id}`

function readDraft(id: number): string | null {
  try {
    return sessionStorage.getItem(draftKey(id))
  } catch {
    return null
  }
}

function writeDraft(id: number, text: string | null) {
  try {
    if (text === null) sessionStorage.removeItem(draftKey(id))
    else sessionStorage.setItem(draftKey(id), text)
  } catch {
    // Not kept; the editor still holds it while it is open.
  }
}

/** Forgets task id's kept description draft: the user chose to discard it. */
export function discardDescriptionDraft(id: number) {
  writeDraft(id, null)
}

/**
 * The task's description, rendered as Markdown. Edit switches to a textarea;
 * the editor stays open until the save lands, so a failure never loses what
 * was typed. While the text differs from the saved description it is
 * "dirty": reported through onDirtyChange (the modal then asks before
 * closing), registered with useUnsavedChanges, and kept in sessionStorage
 * until it is saved or cancelled.
 */
export function DescriptionSection({ task, onDirtyChange }: {
  task: TaskDetail
  onDirtyChange?: (dirty: boolean) => void
}) {
  const m = useTaskDetailMutations(task.id)
  const qc = useQueryClient()
  const [restored] = useState(() => {
    const kept = readDraft(task.id)
    return kept !== null && kept !== task.description ? kept : null
  })
  const [draft, setDraft] = useState<string | null>(restored)
  const [showRestored, setShowRestored] = useState(restored !== null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = draft !== null && draft !== task.description

  useUnsavedChanges(dirty)
  useEffect(() => {
    writeDraft(task.id, dirty ? draft : null)
  }, [task.id, dirty, draft])
  // Not reset on unmount: switching to the Activity tab unmounts this, and
  // the draft it keeps is still unsaved.
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const save = async () => {
    if (draft === null) return
    setSaving(true)
    setError(null)
    try {
      await m.update({ description: draft })
      // update answers with the list shape, not the detail: show the saved
      // text now rather than the old one until the refetch lands.
      qc.setQueryData<TaskDetail>(taskDetailKey(task.id), (cur) => (cur ? { ...cur, description: draft } : cur))
      setDraft(null)
      setShowRestored(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setDraft(null)
    setError(null)
    setShowRestored(false)
  }

  return (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap">
        <Title order={6}>Description</Title>
        {draft === null && (
          <Button size="compact-xs" variant="subtle" aria-label="Edit description" onClick={() => setDraft(task.description)}>
            Edit
          </Button>
        )}
      </Group>
      {draft === null ? (
        task.description.trim() ? (
          <NotesMarkdown text={task.description} />
        ) : (
          <Text size="sm" c="dimmed">No description.</Text>
        )
      ) : (
        <Stack gap={6}>
          {showRestored && (
            <Alert color="blue" variant="light" py={4} withCloseButton onClose={() => setShowRestored(false)}>
              <Text size="xs">Unsaved draft restored</Text>
            </Alert>
          )}
          <Textarea
            aria-label="Description"
            autosize
            minRows={4}
            maxRows={20}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                cancel()
              }
            }}
            // Mantine's Modal closes on Escape from a capture-phase window
            // listener; this attribute is what makes it leave the key alone.
            data-mantine-stop-propagation="true"
          />
          {error && (
            <Alert color="red" variant="light" py={4}>
              <Text size="xs">Couldn't save: {error}</Text>
            </Alert>
          )}
          <Group gap="xs">
            <Button size="xs" onClick={() => void save()} loading={saving}>Save</Button>
            <Button size="xs" variant="default" onClick={cancel} disabled={saving}>Cancel</Button>
          </Group>
        </Stack>
      )}
    </Stack>
  )
}
