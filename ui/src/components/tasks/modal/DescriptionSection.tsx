import { useState } from "react"
import { Alert, Button, Group, Stack, Text, Textarea, Title } from "@mantine/core"
import { useQueryClient } from "@tanstack/react-query"
import type { TaskDetail } from "../../../api/types"
import { taskDetailKey, useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { NotesMarkdown } from "../../NotesMarkdown"
import { errorText } from "./sectionAction"

/**
 * The task's description, rendered as Markdown. Edit switches to a textarea;
 * the editor stays open until the save lands, so a failure never loses what
 * was typed.
 */
export function DescriptionSection({ task }: { task: TaskDetail }) {
  const m = useTaskDetailMutations(task.id)
  const qc = useQueryClient()
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setDraft(null)
    setError(null)
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
