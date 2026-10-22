import { useEffect, useRef, useState } from "react"
import { ActionIcon, Button, Group, Select, TextInput } from "@mantine/core"
import type { Priority } from "../../api/types"

/**
 * WebKit (Safari, the cmux browser pane) does not focus a button on click, so
 * pressing one blurs the input to the body, the row collapses, and the button
 * is gone before its click lands. Preventing mousedown's default keeps focus
 * in the input. The priority picker needs none of this: it is an input, and
 * takes focus inside the row.
 */
const keepInputFocus = (e: React.MouseEvent) => e.preventDefault()

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "None" },
]

/**
 * The input at the bottom of every task list. Just the input until it is
 * focused or holds text; then a star toggle and a priority picker appear to
 * its left and Add to its right. Enter or Add creates the task, clears the
 * input and keeps focus for the next one.
 *
 * While a create is in flight the controls are disabled, but the input is
 * only read-only: disabling it would drop focus, and Enter must keep it.
 */
export function TaskQuickAdd({ onAdd, defaultPriority = "none" }: {
  onAdd(input: { title: string; priority: Priority; starred: boolean }): Promise<unknown>
  /**
   * The picker's starting value: the list's priority filter, when one is on,
   * so a new task is not created straight into hiding. It follows the filter
   * when that changes.
   */
  defaultPriority?: Priority
}) {
  const [title, setTitle] = useState("")
  const [starred, setStarred] = useState(false)
  const [priority, setPriority] = useState<Priority>(defaultPriority)
  useEffect(() => {
    setPriority(defaultPriority)
  }, [defaultPriority])
  const [focused, setFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const expanded = focused || title !== ""

  const submit = async () => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      await onAdd({ title: t, priority, starred })
      setTitle("")
    } catch {
      // Left in the input to retry; the list reports the error.
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  return (
    <Group
      gap={6}
      wrap="nowrap"
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        // Focus moving to the star or the picker keeps the controls open.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      {expanded && (
        <>
          <ActionIcon
            variant="transparent"
            size="sm"
            // A fixed name: aria-pressed alone says whether it is on.
            aria-label="Star new task"
            aria-pressed={starred}
            disabled={busy}
            onMouseDown={keepInputFocus}
            onClick={() => setStarred((s) => !s)}
            style={{ color: starred ? "var(--task-accent)" : "var(--mantine-color-dark-3)", flex: "none" }}
          >
            {starred ? "★" : "☆"}
          </ActionIcon>
          <Select
            size="xs"
            w={95}
            aria-label="New task priority"
            data={PRIORITY_OPTIONS}
            value={priority}
            allowDeselect={false}
            disabled={busy}
            // In place, so picking an option never moves focus out of this group.
            comboboxProps={{ withinPortal: false }}
            onChange={(v) => v && setPriority(v as Priority)}
          />
        </>
      )}
      <TextInput
        ref={inputRef}
        size="xs"
        style={{ flex: 1 }}
        aria-label="New task"
        placeholder="Add a task…"
        value={title}
        readOnly={busy}
        aria-busy={busy}
        onChange={(e) => setTitle(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      {expanded && (
        <Button size="xs" variant="light" disabled={busy || title.trim() === ""} loading={busy} onMouseDown={keepInputFocus} onClick={() => void submit()}>
          Add
        </Button>
      )}
    </Group>
  )
}
