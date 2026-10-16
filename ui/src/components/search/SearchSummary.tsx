import { Anchor, Text } from "@mantine/core"

/**
 * "3 worktrees match your search. Clear search" — the line at the top of a
 * pane while a search narrows it, so the count and the way out sit with the
 * list itself rather than only in the tab badge and the bar's ✕.
 */
export function SearchSummary({
  count,
  more = false,
  noun,
  onClear,
}: {
  count: number
  /** The feed has more pages, so the count is a floor: "50+ events". */
  more?: boolean
  /** Singular and plural, e.g. ["worktree", "worktrees"]. */
  noun: [string, string]
  onClear: () => void
}) {
  const one = count === 1 && !more
  return (
    <Text size="sm" c="dimmed" data-testid="search-summary">
      <Text span fw={600} c="var(--mantine-color-text)">
        {`${count}${more ? "+" : ""} ${one ? noun[0] : noun[1]}`}
      </Text>
      {` ${one ? "matches" : "match"} your search. `}
      <Anchor component="button" type="button" size="sm" onClick={onClear}>Clear search</Anchor>
    </Text>
  )
}
