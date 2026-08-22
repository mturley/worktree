import { Stack, Text } from "@mantine/core"
import type { WorktreeSummary } from "../api/types"
import { WorktreeCard } from "./WorktreeCard"

export function WorktreeList({ items }: { items: WorktreeSummary[] }) {
  if (items.length === 0) return <Text c="dimmed" size="sm">No worktrees. Create one with `worktree add`.</Text>
  return (
    <Stack gap="xs">
      {items.map((w) => <WorktreeCard key={w.path} w={w} />)}
    </Stack>
  )
}
