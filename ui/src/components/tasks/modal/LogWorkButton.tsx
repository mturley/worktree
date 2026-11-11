import { useState } from "react"
import { Alert, Button, Group, Popover, Stack, Text, Textarea } from "@mantine/core"
import { useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { errorText } from "./sectionAction"

const MAX_LEN = 4000

/** "Log work": a popover with a note box that records a work log entry on the task. */
export function LogWorkButton({ taskId }: { taskId: number }) {
  const { logWork } = useTaskDetailMutations(taskId)
  const [opened, setOpened] = useState(false)
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const close = () => {
    setOpened(false)
    setError(null)
  }
  const canSave = text.trim() !== "" && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await logWork(text)
      setText("")
      setOpened(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover
      opened={opened}
      onChange={(o) => (o ? setOpened(true) : close())}
      trapFocus
      closeOnEscape={false}
      withinPortal
      position="bottom-start"
      width={320}
    >
      <Popover.Target>
        <Button variant="default" size="xs" onClick={() => (opened ? close() : setOpened(true))}>
          Log work
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Textarea
            aria-label="Work log note"
            placeholder="What did you do?"
            autosize
            minRows={3}
            maxLength={MAX_LEN}
            data-autofocus
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                close()
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void save()
              }
            }}
            // Mantine's Modal closes on Escape from a capture-phase window
            // listener; this attribute is what it checks to leave the key alone.
            data-mantine-stop-propagation="true"
          />
          {error && (
            <Alert color="red" variant="light" py={4}>
              <Text size="xs">Couldn't save: {error}</Text>
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="default" onClick={close}>Cancel</Button>
            <Button size="xs" disabled={!canSave} loading={saving} onClick={() => void save()}>Save</Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  )
}
