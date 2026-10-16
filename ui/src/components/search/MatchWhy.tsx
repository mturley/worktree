import { Text } from "@mantine/core"
import { VISIBLE_FIELDS, type SearchMatch } from "../../lib/search"
import { SearchHighlight } from "./SearchHighlight"

/**
 * The dimmed "why it matched" line, for a match the item's title doesn't
 * already show (an assignee, notes, an event body, a resource it follows).
 */
export function MatchWhy({ match }: { match: SearchMatch | null | undefined }) {
  if (!match || VISIBLE_FIELDS.has(match.field)) return null
  const label = match.field === "resource" ? `via ${match.viaKey ?? match.snippet}` : match.field
  const text = match.field === "resource" && match.viaKey ? match.snippet : match.field === "resource" ? "" : match.snippet
  return (
    <Text size="xs" c="dimmed" fs="italic" data-testid="match-why" style={{ overflowWrap: "anywhere" }}>
      {text ? <>{label}: <SearchHighlight text={text} /></> : label}
    </Text>
  )
}
