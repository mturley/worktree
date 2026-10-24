import { useState } from "react"
import { Button, Group, Stack, Text, Textarea } from "@mantine/core"

/**
 * A comment's text box. Cmd/Ctrl+Enter submits and Escape cancels; Escape is
 * stopped here so it does not also close whatever the editor sits inside.
 */
export function CommentEditor({ initial, onChange, submitLabel, onSubmit, onCancel, busy, error }: {
  /** The text it opens with; later values are ignored. */
  initial: string
  /** Each change to the text, for whoever keeps it beyond this editor's life. */
  onChange?: (text: string) => void
  submitLabel: string
  onSubmit: (text: string) => void
  onCancel: () => void
  busy?: boolean
  error?: string
}) {
  const [text, setText] = useState(initial)
  const empty = !text.trim()
  const submit = () => {
    if (!empty && !busy) onSubmit(text)
  }
  return (
    <Stack gap={4}>
      <Textarea
        aria-label="Comment"
        size="xs"
        resize="vertical"
        rows={Math.min(Math.max(text.split("\n").length + 1, 3), 20)}
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value)
          onChange?.(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {error && <Text size="xs" c="red">{error}</Text>}
      <Group gap="xs">
        <Button size="compact-xs" disabled={empty} loading={busy} onClick={submit}>{submitLabel}</Button>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onCancel}>Cancel</Button>
      </Group>
    </Stack>
  )
}
