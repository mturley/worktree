import { useEffect, useRef, useState } from "react"
import { CloseButton, TextInput } from "@mantine/core"
import { IconSearch } from "@tabler/icons-react"
import { SearchSuggestions } from "./SearchSuggestions"
import type { ResourceDTO, TimelineEvent, WorktreeSummary } from "../../api/types"

export interface Suggestion {
  key: string
  /** Group heading: "Worktrees", "Resources" or "Activity". */
  group: string
  label: string
  detail?: string
  /**
   * What the row shows, rendered as it is elsewhere in the UI. Without one
   * the row is the plain label and detail.
   */
  item?: SuggestionItem
  onPick: () => void
}

export type SuggestionItem =
  | { kind: "worktree"; w: WorktreeSummary }
  | { kind: "resource"; r: ResourceDTO }
  | { kind: "event"; e: TimelineEvent }

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable
}

/** Hidden (or inside something hidden): a closed or exiting overlay owns no Esc. */
function isHidden(el: Element): boolean {
  if (el.closest('[aria-hidden="true"], [hidden]')) return true
  for (let n: Element | null = el; n; n = n.parentElement) {
    const st = getComputedStyle(n)
    if (st.display === "none" || st.visibility === "hidden") return true
  }
  return false
}

/**
 * Whether an Esc belongs to something other than the search: an open
 * modal, menu or listbox (except our own dropdown), or typing in another
 * field (the Slack composer, the notes editor). Those keep their own Esc.
 */
function escOwnedElsewhere(input: HTMLInputElement | null): boolean {
  const own = input?.closest("[data-search-root]")
  const open = document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')
  for (const el of open) if ((!own || !own.contains(el)) && !isHidden(el)) return true
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

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const count = suggestions?.length ?? 0
  useEffect(() => setActive(-1), [value, count])
  const showList = open && !!value && (suggestions?.length ?? 0) > 0

  const pick = (s: Suggestion) => { s.onPick(); setOpen(false); ref.current?.blur() }

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = suggestions?.length ?? 0
    if (showList && e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % n); return }
    if (showList && e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a <= 0 ? n - 1 : a - 1)); return }
    if (e.key === "Enter") {
      e.preventDefault()
      const picked = suggestions?.[active]
      if (showList && picked) { pick(picked); return }
      setOpen(false)
      return
    }
    if (e.key !== "Escape") return
    e.preventDefault()
    if (showList) { setOpen(false); return }
    if (value) onChange("")
    else ref.current?.blur()
  }

  return (
    <div data-search-root style={{ position: "relative", flex: "1 1 240px", minWidth: 0, maxWidth: 520 }}>
      <TextInput
        ref={ref}
        type="text"
        role="searchbox"
        aria-label="Search"
        size="xs"
        placeholder={placeholder}
        value={value}
        aria-expanded={showList}
        aria-autocomplete="list"
        onChange={(e) => { onChange(e.currentTarget.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onInputKey}
        leftSection={<IconSearch size={14} />}
        rightSection={value ? <CloseButton size="xs" aria-label="Clear search" onClick={() => onChange("")} /> : null}
      />
      {showList && <SearchSuggestions items={suggestions!} active={active} onHover={setActive} onPick={pick} />}
    </div>
  )
}
