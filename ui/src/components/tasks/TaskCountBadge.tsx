import { Badge } from "@mantine/core"

/**
 * The lime count of open tasks. Same shape as UnreadBadge, but in the task
 * accent (never blue: blue means unread). Nothing for zero.
 */
export function TaskCountBadge({ count, ...rest }: { count: number; ml?: string }) {
  if (count <= 0) return null
  return (
    <Badge
      size="xs"
      variant="filled"
      className="task-count-badge"
      // Inline too: Mantine's own badge background would otherwise tie with
      // the class on specificity and win by stylesheet order.
      style={{ flex: "none", background: "var(--task-accent)", color: "var(--mantine-color-dark-9)" }}
      {...rest}
    >
      {count}
    </Badge>
  )
}
