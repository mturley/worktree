import { Modal, TextInput, Textarea, Button, Stack, Group } from '@mantine/core'

interface UrlFieldProps {
  value: string
  onChange: (value: string) => void
  error: string | null
}

interface TabDetailsModalProps {
  opened: boolean
  onClose: () => void
  title: string
  name: string
  onNameChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  onSubmit: () => void
  submitLabel: string
  /** When present, renders a Thread URL field above name/description (used
   * by the "add tab" flow, absent for the "edit details" flow). */
  urlField?: UrlFieldProps
}

/**
 * Presentational name+description (+ optional URL) form shared by
 * AddTabModal (creating a tab from a Slack URL) and EditTabModal (editing an
 * existing tab's title/description), so the two stay visually consistent.
 */
export function TabDetailsModal({
  opened,
  onClose,
  title,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  onSubmit,
  submitLabel,
  urlField,
}: TabDetailsModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title={title}>
      <Stack>
        {urlField && (
          <TextInput
            label="Thread URL"
            placeholder="https://your-workspace.slack.com/archives/C0.../p..."
            value={urlField.value}
            onChange={(event) => urlField.onChange(event.currentTarget.value)}
            error={urlField.error}
            data-autofocus
          />
        )}
        <TextInput
          label="Name (optional)"
          placeholder="Tab name"
          value={name}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          data-autofocus={urlField ? undefined : true}
        />
        <Textarea
          label="Description (optional)"
          placeholder="What is this thread about?"
          value={description}
          onChange={(event) => onDescriptionChange(event.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit}>{submitLabel}</Button>
        </Group>
      </Stack>
    </Modal>
  )
}
