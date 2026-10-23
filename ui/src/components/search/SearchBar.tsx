import { useEffect, useRef, useState } from "react"
import { CloseButton, Group, Kbd, TextInput } from "@mantine/core"
import { IconSearch } from "@tabler/icons-react"
import { SearchSuggestions } from "./SearchSuggestions"
import { isEditable, isHidden } from "../../lib/keyTargets"
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
  onEscape,
  escapeActive,
  onEscapeIdle,
  onEscapeFirst,
}: {
  value: string
  onChange: (q: string) => void
  placeholder?: string
  suggestions?: Suggestion[]
  /**
   * What Esc does: by default it clears the query; a page passes its "see
   * everything" (the query AND Unreads only) instead.
   */
  onEscape?: () => void
  /** Whether Esc has anything to clear; defaults to "there is a query". */
  escapeActive?: boolean
  /**
   * What Esc does on the page with nothing to clear: the page's next step
   * back out (deselect, then leave for home). Not from inside the bar, where
   * an Esc with nothing to clear only leaves the bar.
   */
  onEscapeIdle?: () => void
  /**
   * A step the page's Esc takes before clearing anything (the worktree page's
   * details card back to Notes), while there is one. Not from inside the bar,
   * where Esc stays the search's.
   */
  onEscapeFirst?: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const canEscape = escapeActive ?? Boolean(value)
  const escape = onEscape ?? (() => onChange(""))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === "/" && !isEditable(document.activeElement) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        ref.current?.focus()
        return
      }
      if (e.key === "Escape" && document.activeElement !== ref.current && !escOwnedElsewhere(ref.current)) {
        if (onEscapeFirst) onEscapeFirst()
        else if (canEscape) escape()
        else onEscapeIdle?.()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [canEscape, escape, onEscapeIdle, onEscapeFirst])

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const count = suggestions?.length ?? 0
  useEffect(() => setActive(-1), [value, count])
  // Open with no results too: an empty dropdown says so, where a missing
  // one looks like the search did nothing.
  const showList = open && !!value.trim() && suggestions !== undefined

  const pick = (s: Suggestion) => { s.onPick(); setOpen(false); ref.current?.blur() }

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = suggestions?.length ?? 0
    // -1 (no row highlighted: Enter shows all results) is a stop in the
    // cycle: ↑ from the first row and ↓ from the last both land on it.
    if (showList && e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a >= n - 1 ? -1 : a + 1)); return }
    if (showList && e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a === -1 ? n - 1 : a - 1)); return }
    if (e.key === "Enter") {
      e.preventDefault()
      const picked = suggestions?.[active]
      if (showList && picked) { pick(picked); return }
      setOpen(false)
      return
    }
    if (e.key !== "Escape") return
    e.preventDefault()
    // Esc means "see everything" here as on the page: it clears the search,
    // and an empty bar has no dropdown. Only with nothing to clear does it
    // just close the list, then leave the bar.
    if (canEscape) escape()
    else if (showList) setOpen(false)
    else ref.current?.blur()
  }

  return (
    <div data-search-root style={{ position: "relative", flex: "1 1 240px", minWidth: 0, maxWidth: 520 }}>
      <TextInput
        ref={ref}
        type="text"
        role="searchbox"
        aria-label="Search"
        // Queries are keys, branch names and fragments, not prose: no
        // autocorrect (iOS), autocapitalize (mobile keyboards), spellcheck
        // (and the autocorrect Chrome ties to it), or the browser's own
        // history dropdown over ours.
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        size="xs"
        placeholder={placeholder}
        value={value}
        aria-expanded={showList}
        aria-autocomplete="list"
        onChange={(e) => { onChange(e.currentTarget.value); setOpen(true) }}
        onFocus={() => { setOpen(true); setFocused(true) }}
        onBlur={() => { setOpen(false); setFocused(false) }}
        onKeyDown={onInputKey}
        leftSection={<IconSearch size={14} />}
        // Esc beside the ✕: the key does what the button does (and, with
        // Unreads only on, turns that off too). Empty and unfocused, the
        // key that gets you here instead; clicks pass through it to the input.
        rightSectionWidth={value ? 64 : undefined}
        rightSectionPointerEvents={value ? "all" : "none"}
        rightSection={value ? (
          <Group gap={6} wrap="nowrap">
            <CloseButton size="xs" aria-label="Clear search" onClick={() => onChange("")} />
            <Kbd size="xs" data-testid="search-esc-hint">Esc</Kbd>
          </Group>
        ) : focused ? null : (
          <Kbd size="xs" data-testid="search-slash-hint">/</Kbd>
        )}
      />
      {showList && (
        <SearchSuggestions
          items={suggestions!}
          active={active}
          onHover={setActive}
          onPick={pick}
          onViewAll={() => setOpen(false)}
        />
      )}
    </div>
  )
}
