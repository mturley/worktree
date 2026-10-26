import { useEffect, useRef, useState } from "react"
import { Button, Group, Stack, Text, Textarea, Tooltip } from "@mantine/core"

/** How long the editor keeps trying to take focus, in animation frames (about half a second). */
const FOCUS_FRAMES = 30

/**
 * A comment's text box. Cmd/Ctrl+Enter submits and Escape cancels; Escape is
 * stopped here so it does not also close whatever the editor sits inside.
 */
export function CommentEditor({ initial, onChange, submitLabel, submitTooltip, onSubmit, onCancel, busy, error }: {
  /** The text it opens with; later values are ignored. */
  initial: string
  /** Each change to the text, for whoever keeps it beyond this editor's life. */
  onChange?: (text: string) => void
  submitLabel: string
  submitTooltip?: string
  onSubmit: (text: string) => void
  onCancel: () => void
  busy?: boolean
  error?: string
}) {
  const [text, setText] = useState(initial)
  const empty = !text.trim()
  // Not autoFocus: in the diff, the editor mounts inside an annotation slot
  // that pierre attaches to the page only after React commits, and focusing
  // a detached element does nothing. So keep trying for a few frames.
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    let frames = 0
    let id = 0
    const tryFocus = () => {
      const el = box.current
      if (!el) return
      if (el.isConnected) {
        el.focus()
        if (document.activeElement === el) return
      }
      if (++frames < FOCUS_FRAMES) id = requestAnimationFrame(tryFocus)
    }
    tryFocus()
    return () => cancelAnimationFrame(id)
  }, [])
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
        ref={box}
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
        {/* A disabled button gets no hover, so a tooltip keeps it enabled-looking to events (data-disabled). */}
        {submitTooltip ? (
          <Tooltip label={submitTooltip} withArrow>
            <Button
              size="compact-xs"
              data-disabled={empty || undefined}
              aria-disabled={empty}
              loading={busy}
              onClick={submit}
            >
              {submitLabel}
            </Button>
          </Tooltip>
        ) : (
          <Button size="compact-xs" disabled={empty} loading={busy} onClick={submit}>{submitLabel}</Button>
        )}
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onCancel}>Cancel</Button>
      </Group>
    </Stack>
  )
}
