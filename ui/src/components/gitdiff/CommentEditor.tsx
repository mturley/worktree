import { type ReactNode, useEffect, useRef, useState } from "react"
import { Button, Group, Stack, Text, Textarea, Tooltip } from "@mantine/core"

/** How long the editor keeps trying to take focus, in animation frames (about half a second). */
const FOCUS_FRAMES = 30

/** One of the editor's save buttons. */
export type EditorAction = {
  key: string
  label: string
  /** Shown on hover while the action is enabled. */
  tooltip: string
  /** Set, the button stays but does nothing, and its tooltip says this instead. */
  disabledReason?: string
  onSubmit: (text: string) => void
  variant?: "filled" | "light"
  /** This action's write is in flight. */
  busy?: boolean
}

type Submit =
  | {
      submitLabel: string
      submitTooltip?: string
      onSubmit: (text: string) => void
      actions?: undefined
    }
  | {
      /** The save buttons, in order; Cmd/Ctrl+Enter runs the first enabled one. */
      actions: EditorAction[]
      submitLabel?: undefined
      submitTooltip?: undefined
      onSubmit?: undefined
    }

/**
 * A comment's text box. Cmd/Ctrl+Enter submits and Escape cancels; Escape is
 * stopped here so it does not also close whatever the editor sits inside.
 */
export function CommentEditor({ initial, onChange, onCancel, busy, error, ...submitProps }: {
  /** The text it opens with; later values are ignored. */
  initial: string
  /** Each change to the text, for whoever keeps it beyond this editor's life. */
  onChange?: (text: string) => void
  onCancel: () => void
  busy?: boolean
  error?: string
} & Submit) {
  const [text, setText] = useState(initial)
  const empty = !text.trim()
  const anyBusy = !!busy || !!submitProps.actions?.some((a) => a.busy)
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
  const run = (onSubmit: (text: string) => void) => {
    if (!empty && !anyBusy) onSubmit(text)
  }
  const submit = () => {
    if (submitProps.actions) {
      const first = submitProps.actions.find((a) => !a.disabledReason)
      if (first) run(first.onSubmit)
    } else run(submitProps.onSubmit)
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
        {submitProps.actions ? (
          submitProps.actions.map((a) => {
            const off = empty || !!a.disabledReason
            return (
              <TooltipButton
                key={a.key}
                tooltip={a.disabledReason ?? a.tooltip}
                off={off}
                busy={a.busy}
                variant={a.variant}
                onClick={() => {
                  if (!a.disabledReason) run(a.onSubmit)
                }}
              >
                {a.label}
              </TooltipButton>
            )
          })
        ) : submitProps.submitTooltip ? (
          <TooltipButton tooltip={submitProps.submitTooltip} off={empty} busy={busy} onClick={submit}>
            {submitProps.submitLabel}
          </TooltipButton>
        ) : (
          <Button size="compact-xs" disabled={empty} loading={busy} onClick={submit}>{submitProps.submitLabel}</Button>
        )}
        <Button size="compact-xs" variant="subtle" color="gray" onClick={onCancel}>Cancel</Button>
      </Group>
    </Stack>
  )
}

/** A save button with a tooltip, which it keeps while off. */
function TooltipButton({ tooltip, off, busy, variant, onClick, children }: {
  tooltip: string
  off: boolean
  busy?: boolean
  variant?: "filled" | "light"
  onClick: () => void
  children: ReactNode
}) {
  return (
    // A disabled button gets no hover, so an off one stays enabled to events (data-disabled).
    <Tooltip label={tooltip} withArrow multiline maw={320} events={{ hover: true, focus: true, touch: true }}>
      <Button
        size="compact-xs"
        variant={variant}
        data-disabled={off || undefined}
        aria-disabled={off}
        loading={busy}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tooltip>
  )
}
