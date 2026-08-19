import { useRef, useState } from 'react'
import { ActionIcon, Button, Group, Stack, Textarea, Tooltip } from '@mantine/core'

interface ComposerProps {
  onSend: (text: string) => void
  disabled?: boolean
}

interface ToolbarAction {
  label: string
  icon: string
  wrap: (selected: string) => string
}

// Minimal mrkdwn wrapping. Slack's full link syntax is `<url|text>`, but
// without prompting for a URL we just wrap the selection as `<selection>`
// (treated as the URL). The user can edit in a `|label` by hand if needed.
// (A richer link dialog is a later-phase enhancement.)
const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { label: 'Bold', icon: 'B', wrap: (s) => `*${s}*` },
  { label: 'Italic', icon: 'I', wrap: (s) => `_${s}_` },
  { label: 'Code', icon: '</>', wrap: (s) => `\`${s}\`` },
  { label: 'Strikethrough', icon: 'S', wrap: (s) => `~${s}~` },
  { label: 'Link', icon: '🔗', wrap: (s) => `<${s}>` },
]

export function Composer({ onSend, disabled }: ComposerProps) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement | null>(null)

  const trimmed = text.trim()
  const sendDisabled = trimmed.length === 0 || !!disabled

  function handleSend() {
    if (sendDisabled) {
      return
    }
    onSend(trimmed)
    setText('')
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  function handleToolbarClick(action: ToolbarAction) {
    const ta = ref.current
    if (!ta) {
      return
    }
    const start = ta.selectionStart ?? 0
    const end = ta.selectionEnd ?? 0
    const selected = text.slice(start, end)
    const wrapped = action.wrap(selected)
    const next = text.slice(0, start) + wrapped + text.slice(end)
    setText(next)
    // Restore focus and place the cursor after the wrapped text; done on the
    // next tick so the textarea's value has updated first.
    requestAnimationFrame(() => {
      ta.focus()
      const cursor = start + wrapped.length
      ta.setSelectionRange(cursor, cursor)
    })
  }

  return (
    <Stack gap={4}>
      <Group gap={4}>
        {TOOLBAR_ACTIONS.map((action) => (
          <Tooltip key={action.label} label={action.label}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={action.label}
              disabled={disabled}
              onClick={() => handleToolbarClick(action)}
            >
              {action.icon}
            </ActionIcon>
          </Tooltip>
        ))}
      </Group>
      <Group align="flex-end" gap="xs" wrap="nowrap">
        <Textarea
          ref={ref}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Reply…"
          autosize
          minRows={1}
          maxRows={8}
          disabled={disabled}
          style={{ flex: 1 }}
        />
        <Button onClick={handleSend} disabled={sendDisabled}>
          Send
        </Button>
      </Group>
    </Stack>
  )
}
