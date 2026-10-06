import { Stack, Text } from "@mantine/core"
import type { WorktreeSummary } from "../api/types"
import { WorktreeCard } from "./WorktreeCard"

export function WorktreeList({
  items,
  emptyText = "No worktrees. Create one with `worktree add`.",
}: {
  items: WorktreeSummary[]
  emptyText?: string
}) {
  if (items.length === 0) return <Text c="dimmed" size="sm">{emptyText}</Text>
  return (
    <Stack gap="xs">
      {items.map((w) => <WorktreeCard key={w.path} w={w} />)}
    </Stack>
  )
}
