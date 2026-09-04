import { Badge } from "@mantine/core"

/**
 * The "N unreads" badge a card wears when something inside it is new.
 *
 * `count` and `unread` are separate on purpose. Slack threads have unread
 * state but no COUNT — worktree mirrors Slack's cursor, not a tally of
 * messages behind it — so a thread can be unread with nothing to number. The
 * badge says "unread" in that case rather than the lie "0 unreads".
 *
 * Filled rather than light, unlike the WORKTREE badge beside it on the
 * worktree card: this one is a notification, and a second pale-blue pill
 * would read as another label.
 */
export function UnreadBadge({ unread, count = 0, ...rest }: {
  unread: boolean
  count?: number
  ml?: string
}) {
  if (!unread) return null
  const label = count === 0 ? "unread" : count === 1 ? "1 unread" : `${count} unreads`
  return (
    <Badge size="xs" color="blue" variant="filled" style={{ flex: "none" }} {...rest}>
      {label}
    </Badge>
  )
}
