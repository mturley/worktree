import { Anchor } from "@mantine/core"

/**
 * "No unread events. See all" — an empty list's way out of Unreads only,
 * so an empty pane offers the fix rather than only describing the problem.
 */
export function SeeAllLink({ onClick }: { onClick: () => void }) {
  return (
    <Anchor component="button" type="button" size="sm" onClick={onClick}>
      See all
    </Anchor>
  )
}
