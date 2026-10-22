import { useEffect, useMemo, useState } from "react"
import { ActionIcon, Alert, Button, Combobox, Group, Stack, Text, TextInput, useCombobox } from "@mantine/core"
import { IconX } from "@tabler/icons-react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { api } from "../../../api/client"
import type { ResourceDTO, TaskDetail, TaskLinkTarget } from "../../../api/types"
import { useTaskDetailMutations } from "../../../hooks/useTaskDetail"
import { useWorktrees } from "../../../hooks/useWorktrees"
import { shortResourceRef } from "../../../lib/resourceRef"
import { linkKey, targetKey } from "./linkTargets"
import { errorText } from "./sectionAction"

const URL_VALUE = "__url__"
const MAX_OPTIONS = 50

interface Suggestion {
  value: string
  label: string
  detail: string
  target: TaskLinkTarget
}

const isURL = (s: string) => /^https?:\/\/\S+$/i.test(s)

function resourceSuggestion(r: ResourceDTO): Suggestion {
  const ref = shortResourceRef(r.type, r.id)
  const target: TaskLinkTarget = { kind: "resource", type: r.type, rid: r.id }
  return {
    value: targetKey(target),
    label: r.custom_name || r.title || ref || r.id,
    detail: ref || r.type,
    target,
  }
}

/**
 * "+ Link resource or worktree": a combobox suggesting the resources the
 * task's worktrees follow (its direct worktree links and its implicit ones),
 * or every followed resource for a task with no worktree, plus every
 * worktree. A pasted URL is linked as itself. Whatever is chosen is linked
 * as Related; dragging it to Focus is one move away.
 */
export function LinkPicker({ task }: { task: TaskDetail }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <Group>
        <Button size="compact-xs" variant="subtle" onClick={() => setOpen(true)}>
          + Link resource or worktree
        </Button>
      </Group>
    )
  }
  return <PickerInput task={task} onDone={() => setOpen(false)} />
}

function PickerInput({ task, onDone }: { task: TaskDetail; onDone: () => void }) {
  const m = useTaskDetailMutations(task.id)
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const store = useCombobox({ onDropdownClose: () => store.resetSelectedOption() })

  const paths = useMemo(() => {
    const direct = task.detail_links.flatMap((l) => (l.kind === "worktree" && l.worktree ? [l.worktree] : []))
    return [...new Set([...direct, ...task.implicit.map((w) => w.worktree)])]
  }, [task.detail_links, task.implicit])
  const global = paths.length === 0

  // The same keys as the worktree page and home page, so these share cache.
  const perWorktree = useQueries({
    queries: paths.map((path) => ({ queryKey: ["resources", path], queryFn: () => api.worktreeResources(path) })),
  })
  const all = useQuery({ queryKey: ["resources", "__all__"], queryFn: api.allResources, enabled: global })
  const worktrees = useWorktrees()

  const linked = useMemo(() => new Set(task.detail_links.map(linkKey)), [task.detail_links])

  // Recomputed each render: a few hundred entries at most, and useQueries
  // hands back a new array every render, so a memo would never hit.
  const suggestions = (() => {
    const out = new Map<string, Suggestion>()
    const resources = global ? all.data ?? [] : perWorktree.flatMap((q) => q.data ?? [])
    for (const r of resources) {
      const s = resourceSuggestion(r)
      if (!out.has(s.value)) out.set(s.value, s)
    }
    for (const w of worktrees.data ?? []) {
      const target: TaskLinkTarget = { kind: "worktree", path: w.path }
      const value = targetKey(target)
      if (!out.has(value)) out.set(value, { value, label: `⎇ ${w.branch}`, detail: w.path, target })
    }
    return [...out.values()].filter((s) => !linked.has(s.value))
  })()

  const q = query.trim()
  const needle = q.toLowerCase()
  const matches = (needle
    ? suggestions.filter((s) => `${s.label} ${s.detail} ${s.value}`.toLowerCase().includes(needle))
    : suggestions
  ).slice(0, MAX_OPTIONS)
  const url = isURL(q) ? q : null

  // While there is a query, the first option (the pasted URL's, or the best
  // match) is preselected, so Enter picks it. An empty query selects nothing.
  // After render, because selectFirstOption finds options in the DOM.
  // Keyed on the query and the first option, not every render, so arrowing to
  // another option sticks. (The store object is new each render; its methods
  // are stable.)
  const firstValue = url ? URL_VALUE : matches[0]?.value
  const { selectFirstOption, resetSelectedOption } = store
  useEffect(() => {
    if (q && firstValue !== undefined) selectFirstOption()
    else resetSelectedOption()
  }, [q, firstValue, selectFirstOption, resetSelectedOption])

  const choose = async (value: string) => {
    if (busy) return
    const target: { url: string } | TaskLinkTarget | undefined =
      value === URL_VALUE && url ? { url } : suggestions.find((s) => s.value === value)?.target
    if (!target) return
    setBusy(true)
    setError(null)
    store.closeDropdown()
    try {
      await m.addLink(target, false)
      onDone()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Stack gap={4}>
      <Group gap={4} wrap="nowrap">
        <Combobox store={store} onOptionSubmit={(v) => void choose(v)}>
          <Combobox.Target>
            <TextInput
              size="xs"
              aria-label="Link resource or worktree"
              placeholder="Search, or paste a URL"
              autoFocus
              disabled={busy}
              style={{ flex: 1 }}
              value={query}
              onChange={(e) => {
                setQuery(e.currentTarget.value)
                setError(null)
                store.openDropdown()
                store.resetSelectedOption()
              }}
              onClick={() => store.openDropdown()}
              onFocus={() => store.openDropdown()}
              onBlur={() => store.closeDropdown()}
              onKeyDown={(e) => {
                if (e.key === "Enter" && store.getSelectedOptionIndex() === -1 && url) {
                  e.preventDefault()
                  void choose(URL_VALUE)
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  onDone()
                }
              }}
              // Escape leaves the picker, not the modal.
              data-mantine-stop-propagation="true"
            />
          </Combobox.Target>
          <Combobox.Dropdown>
            <Combobox.Options mah={260} style={{ overflowY: "auto" }}>
              {url && (
                <Combobox.Option value={URL_VALUE}>
                  <Text size="sm" truncate>Link {url}</Text>
                </Combobox.Option>
              )}
              {matches.map((s) => (
                <Combobox.Option value={s.value} key={s.value}>
                  <Text size="sm" truncate>{s.label}</Text>
                  <Text size="xs" c="dimmed" truncate>{s.detail}</Text>
                </Combobox.Option>
              ))}
              {!url && matches.length === 0 && <Combobox.Empty>No matches. Paste a URL to link it.</Combobox.Empty>}
            </Combobox.Options>
          </Combobox.Dropdown>
        </Combobox>
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Cancel linking" onClick={onDone}>
          <IconX size={14} />
        </ActionIcon>
      </Group>
      {error && (
        <Alert color="red" variant="light" py={4}>
          <Text size="xs">Couldn't link: {error}</Text>
        </Alert>
      )}
    </Stack>
  )
}
