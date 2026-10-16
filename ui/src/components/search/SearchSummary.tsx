import { Text } from "@mantine/core"
import { SeeEverythingLink } from "./SeeEverythingLink"
import { useSearchQuery } from "../../hooks/useSearchQuery"

/**
 * "3 worktrees match your search. See everything Esc" — the line directly
 * above a pane's results while a search narrows it, so the count and the
 * way out sit with the list itself rather than only in the tab badge.
 */
export function SearchSummary({
  count,
  more = false,
  noun,
  qualifier,
}: {
  count: number
  /** The feed has more pages, so the count is a floor: "50+ events". */
  more?: boolean
  /** Singular and plural, e.g. ["worktree", "worktrees"]. */
  noun: [string, string]
  /** What else narrows the count, after the noun: "with unread events". */
  qualifier?: string
}) {
  const one = count === 1 && !more
  // With no search the list is narrowed only by Unreads only (the qualifier
  // or noun says so): "3 worktrees with unread events."
  const searching = useSearchQuery().terms.length > 0
  return (
    <Text
      size="sm"
      c="dimmed"
      data-testid="search-summary"
    >
      <Text span fw={600} c="var(--mantine-color-text)">
        {`${count}${more ? "+" : ""} ${one ? noun[0] : noun[1]}`}
      </Text>
      {qualifier && ` ${qualifier}`}
      {searching ? ` ${one ? "matches" : "match"} your search. ` : ". "}
      <SeeEverythingLink />
    </Text>
  )
}
