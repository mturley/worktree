import { useState } from "react"
import { ActionIcon, Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core"
import { IconX } from "@tabler/icons-react"
import type { TaskBlockerKind, TaskBlockerTarget, TaskDetail } from "../../../api/types"
import { useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { useTasks } from "../../../hooks/useTasks"
import { TASK_STATE_LABEL } from "../TaskStateCheckbox"
import { resourceSuggestion, SuggestPicker, useTaskScopeResources } from "./LinkPicker"
import { errorText } from "./sectionAction"

/**
 * Adds one blocker of `kind` to the task, then calls `onDone`. A refused add
 * (a blocking cycle, say) is shown inline and the picker stays open.
 */
export function BlockerPicker({ task, kind, onDone }: {
  task: TaskDetail
  kind: TaskBlockerKind
  onDone: () => void
}) {
  const m = useTaskDetailMutations(task.id)
  const add = async (target: TaskBlockerTarget) => {
    await m.addBlocker(target)
  }
  switch (kind) {
    case "task":
      return <TaskBlockerPicker task={task} add={add} onDone={onDone} />
    case "resource":
      return <ResourceBlockerPicker task={task} add={add} onDone={onDone} />
    case "other":
      return <OtherBlockerInput add={add} onDone={onDone} />
  }
}

type PickerProps = { task: TaskDetail; add: (t: TaskBlockerTarget) => Promise<void>; onDone: () => void }

const ERROR_PREFIX = "Couldn't add blocker"

/**
 * Open tasks from every scope, less the task itself, the tasks it blocks
 * (each would be a cycle at once) and those already blocking it. Other
 * cycles are the server's to refuse.
 */
function TaskBlockerPicker({ task, add, onDone }: PickerProps) {
  const tasks = useTasks({ kind: "all" }, { completed: false, archived: false })
  // task.blocks lists every task this one blocks, resolved or not. Only an
  // unresolved one would make a cycle, but offering a task this one blocks
  // as its blocker is never what is meant, so all of them are left out.
  const blocks = new Set(task.blocks.map((b) => b.id))
  const blocking = new Set(task.blockers.flatMap((b) => (b.kind === "task" && b.task_id ? [b.task_id] : [])))
  const suggestions = (tasks.data ?? [])
    .filter((t) => t.state !== "done" && t.id !== task.id && !blocks.has(t.id) && !blocking.has(t.id))
    .map((t) => ({ value: String(t.id), label: `${t.ref} ${t.title}`, detail: TASK_STATE_LABEL[t.state] }))
  return (
    <SuggestPicker
      ariaLabel="Blocking task"
      placeholder="Search open tasks"
      cancelLabel="Cancel adding blocker"
      emptyText="No matching open tasks."
      errorPrefix={ERROR_PREFIX}
      suggestions={suggestions}
      onChoose={(choice) => ("value" in choice ? add({ kind: "task", task_id: Number(choice.value) }) : Promise.resolve())}
      onDone={onDone}
    />
  )
}

/** LinkPicker's resource suggestions (no worktrees), plus a pasted URL. */
function ResourceBlockerPicker({ task, add, onDone }: PickerProps) {
  const resources = useTaskScopeResources(task)
  const already = new Set(
    task.blockers.flatMap((b) => (b.kind === "resource" ? [`${b.resource_type}:${b.resource_id}`] : [])),
  )
  const suggestions = resources.filter((r) => !already.has(`${r.type}:${r.id}`)).map(resourceSuggestion)
  return (
    <SuggestPicker
      ariaLabel="Blocking resource"
      cancelLabel="Cancel adding blocker"
      urlOption={(url) => `Blocked by ${url}`}
      emptyText="No matches. Paste a URL to add it."
      errorPrefix={ERROR_PREFIX}
      suggestions={suggestions}
      onChoose={async (choice) => {
        if ("url" in choice) return add({ kind: "resource", url: choice.url })
        const s = suggestions.find((x) => x.value === choice.value)
        if (s) await add({ kind: "resource", type: s.target.type, rid: s.target.rid })
      }}
      onDone={onDone}
    />
  )
}

/** Free text, added on Enter or Add. */
function OtherBlockerInput({ add, onDone }: Omit<PickerProps, "task">) {
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    setError(null)
    try {
      await add({ kind: "other", text: t })
      onDone()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <Stack gap={4}>
      <Group gap={4} wrap="nowrap">
        <TextInput
          size="xs"
          aria-label="Blocker text"
          placeholder="What is it waiting on?"
          autoFocus
          disabled={busy}
          style={{ flex: 1 }}
          value={text}
          onChange={(e) => {
            setText(e.currentTarget.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void submit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              onDone()
            }
          }}
          // Escape leaves the input, not the modal.
          data-mantine-stop-propagation="true"
        />
        <Button size="compact-xs" variant="light" disabled={busy || !text.trim()} onClick={() => void submit()}>
          Add
        </Button>
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Cancel adding blocker" onClick={onDone}>
          <IconX size={14} />
        </ActionIcon>
      </Group>
      {error && (
        <Alert color="red" variant="light" py={4}>
          <Text size="xs">{ERROR_PREFIX}: {error}</Text>
        </Alert>
      )}
    </Stack>
  )
}
