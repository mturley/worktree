import { useRef, useState } from "react"
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
 * its left and Add (and, with `onOpen`, "Add & open") to its right. Enter or
 * Add creates the task, clears the input and keeps focus for the next one;
 * "Add & open" creates it and opens its modal.
 *
 * While a create is in flight the controls are disabled, but the input is
 * only read-only: disabling it would drop focus, and Enter must keep it.
 */
export function TaskQuickAdd({ onAdd, onOpen }: {
  /** Creates the task; resolves to it (its id is what "Add & open" opens). */
  onAdd(input: { title: string; priority: Priority; starred: boolean }): Promise<{ id: number } | void>
  /**
   * Opens a task's modal. When given, "Add & open" appears beside Add: it
   * creates the task, then opens it. Enter still adds and stays.
   */
  onOpen?: (id: number) => void
}) {
  const [title, setTitle] = useState("")
  const [starred, setStarred] = useState(false)
  const [priority, setPriority] = useState<Priority>("none")
  const [focused, setFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const expanded = focused || title !== ""

  const submit = async (andOpen = false) => {
    const t = title.trim()
    if (!t || busy) return
    setBusy(true)
    let opened = false
    try {
      const created = await onAdd({ title: t, priority, starred })
      setTitle("")
      if (andOpen && onOpen && created) {
        onOpen(created.id)
        opened = true
      }
    } catch {
      // Left in the input to retry; the list reports the error.
    } finally {
      setBusy(false)
      // The modal takes focus when it opens; pulling it back here would
      // fight its focus trap.
      if (!opened) inputRef.current?.focus()
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
      {expanded && onOpen && (
        <Button
          size="xs"
          variant="subtle"
          style={{ flex: "none" }}
          disabled={busy || title.trim() === ""}
          onMouseDown={keepInputFocus}
          onClick={() => void submit(true)}
        >
          Add &amp; open
        </Button>
      )}
    </Group>
  )
}
