import { Group, Text, Tooltip } from "@mantine/core"
import { IconHelpCircle } from "@tabler/icons-react"

/**
 * "Filter ?" over a list beside an activity feed, wide only: the list has no
 * filter controls of its own, because the feed's filters (sources, Unreads
 * only, …) narrow it too. This says so. `what` names the list's items: the
 * home page's worktrees, the worktree page's resources.
 */
export function FilterHint({ what }: { what: "worktrees" | "resources" }) {
  return (
    <Tooltip label={`Filters in the activity list on the right also filter ${what}`} multiline w={260}>
      <Group gap={4} wrap="nowrap" c="dimmed" style={{ cursor: "help", flex: "none" }} data-testid={`${what}-filter-hint`}>
        <Text size="sm" c="dimmed">Filter</Text>
        <IconHelpCircle size={14} aria-hidden />
      </Group>
    </Tooltip>
  )
}
