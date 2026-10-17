import { Text } from "@mantine/core"
import { SeeEverythingLink } from "./SeeEverythingLink"
import { useNarrowing } from "./NarrowingContext"

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
  filtered = false,
}: {
  count: number
  /** The feed has more pages, so the count is a floor: "50+ events". */
  more?: boolean
  /** Singular and plural, e.g. ["worktree", "worktrees"]. */
  noun: [string, string]
  /** What else narrows the count, after the noun: "with unread events". */
  qualifier?: string
  /** Whether the page's filters narrow THIS pane (they don't all reach every pane). */
  filtered?: boolean
}) {
  const one = count === 1 && !more
  // "match your search", "… your filters", "… your search and filters", or,
  // narrowed by Unreads only alone (the qualifier or noun says so), nothing:
  // "3 worktrees with unread events."
  const by = [useNarrowing().search && "search", filtered && "filters"].filter(Boolean).join(" and ")
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
      {by ? ` ${one ? "matches" : "match"} your ${by}. ` : ". "}
      <SeeEverythingLink />
    </Text>
  )
}
