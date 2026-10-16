import { useEffect, useRef } from "react"
import { CloseButton, TextInput } from "@mantine/core"
import { IconSearch } from "@tabler/icons-react"

export interface Suggestion {
  key: string
  /** Group heading: "Worktrees", "Resources" or "Activity". */
  group: string
  label: string
  detail?: string
  onPick: () => void
}

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable
}

/**
 * Whether an Esc belongs to something other than the search: an open
 * modal, menu or listbox (except our own dropdown), or typing in another
 * field (the Slack composer, the notes editor). Those keep their own Esc.
 */
function escOwnedElsewhere(input: HTMLInputElement | null): boolean {
  const own = input?.closest("[data-search-root]")
  const open = document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')
  for (const el of open) if (!own || !own.contains(el)) return true
  const active = document.activeElement
  return isEditable(active) && active !== input
}

export function SearchBar({
  value,
  onChange,
  placeholder = "Search worktrees, resources, activity…",
  suggestions,
}: {
  value: string
  onChange: (q: string) => void
  placeholder?: string
  suggestions?: Suggestion[]
}) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === "/" && !isEditable(document.activeElement) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        ref.current?.focus()
        return
      }
      if (e.key === "Escape" && value && document.activeElement !== ref.current && !escOwnedElsewhere(ref.current)) {
        onChange("")
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [value, onChange])

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return
    e.preventDefault()
    if (value) onChange("")
    else ref.current?.blur()
  }

  void suggestions // wired in Task 9
  return (
    <div data-search-root style={{ flex: "1 1 240px", minWidth: 0, maxWidth: 520 }}>
      <TextInput
        ref={ref}
        type="search"
        role="searchbox"
        aria-label="Search"
        size="xs"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={onInputKey}
        leftSection={<IconSearch size={14} />}
        rightSection={value ? <CloseButton size="xs" aria-label="Clear search" onClick={() => onChange("")} /> : null}
      />
    </div>
  )
}
