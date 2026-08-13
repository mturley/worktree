import { Badge, Group, NavLink, Stack, Text } from "@mantine/core"
import { Link } from "wouter"
import type { WorktreeSummary } from "../api/types"
import { resourceSummary } from "../lib/resourceSummary"

export function WorktreeList({ items }: { items: WorktreeSummary[] }) {
  if (items.length === 0) return <Text c="dimmed" size="sm">No worktrees. Create one with `worktree add`.</Text>
  return (
    <Stack gap={4}>
      {items.map((w) => {
        const summary = resourceSummary(w.primary_by_type, w.related_count)
        return (
          <NavLink
            key={w.path}
            component={Link}
            href={`/worktree/${encodeURIComponent(w.path)}`}
            label={<Group gap="xs"><Text size="sm" fw={600}>{w.branch}</Text>{!w.on_disk && <Badge size="xs" color="red">missing</Badge>}</Group>}
            description={<Text size="xs" c="dimmed">{w.repo}{summary ? ` · ${summary}` : ""}</Text>}
          />
        )
      })}
    </Stack>
  )
}
