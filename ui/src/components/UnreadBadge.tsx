import { Badge } from "@mantine/core"

/**
 * The "N unreads" badge a card wears when something inside it is new.
 *
 * `count` and `unread` are separate on purpose: the yes/no and the number
 * come from different fields, and an older cached response can carry one
 * without the other. With no count the badge says "unread" rather than the
 * lie "0 unreads". (Slack threads used to be that case permanently; they now
 * carry a count of at least 1 while unread — see the server's
 * unreadIndex.fill.)
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
