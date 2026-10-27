import { Badge } from "@mantine/core"

/** "1 open task" / "N open tasks": names a card's bare-number badge on hover. */
export function openTasksLabel(count: number): string {
  return count === 1 ? "1 open task" : `${count} open tasks`
}

/**
 * The lime count of open tasks, "N tasks". Same shape as UnreadBadge, but in the task
 * accent (never blue: blue means unread). Nothing for zero.
 */
export function TaskCountBadge({ count, qualifier, ...rest }: {
  count: number
  /** A word before "task(s)": "other" reads "3 other tasks". */
  qualifier?: string
  ml?: string
  /** Hover text, for a card where a bare number beside "N unreads" needs naming. */
  title?: string
}) {
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
      {`${count} ${qualifier ? `${qualifier} ` : ""}${count === 1 ? "task" : "tasks"}`}
    </Badge>
  )
}

/** "Blocks 1 open task" / "Blocks N open tasks": the blocks badge's hover text. */
export function blocksLabel(count: number): string {
  return count === 1 ? "Blocks 1 open task" : `Blocks ${count} open tasks`
}

/**
 * "⛔ blocks N": the open tasks a resource blocks, unresolved blockers only.
 * Red-tinted, in the overdue chip's style; it sits beside TaskCountBadge.
 * Nothing for zero.
 */
export function BlocksBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <Badge
      data-testid="blocks-badge"
      size="xs"
      variant="light"
      color="red"
      title={blocksLabel(count)}
      style={{ flex: "none", textTransform: "none" }}
    >
      ⛔ blocks {count}
    </Badge>
  )
}
