import { useRef, useState } from "react"
import { ActionIcon, Button, Group, Select, TextInput } from "@mantine/core"
import type { Priority } from "../../api/types"

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
export function TaskQuickAdd({ onAdd }: {
  onAdd(input: { title: string; priority: Priority; starred: boolean }): Promise<unknown>
}) {
  const [title, setTitle] = useState("")
  const [starred, setStarred] = useState(false)
  const [priority, setPriority] = useState<Priority>("none")
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
            aria-label={starred ? "Unstar new task" : "Star new task"}
            aria-pressed={starred}
            disabled={busy}
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
        <Button size="xs" variant="light" disabled={busy || title.trim() === ""} loading={busy} onClick={() => void submit()}>
          Add
        </Button>
      )}
    </Group>
  )
}
