import { Button, Menu, ScrollArea } from "@mantine/core"
import { IconChevronDown } from "@tabler/icons-react"
import type { WorktreeSummary } from "../api/types"
import { useWorktrees } from "../hooks/useWorktrees"
import { WorktreeWorkspaceName } from "./WorktreeWorkspaceName"
import { worktreeName } from "../lib/homeWorktree"

/**
 * Picks a worktree to follow a resource in, each named by
 * WorktreeWorkspaceName.
 */
export function FollowInWorktreeMenu({ onPick }: { onPick: (w: WorktreeSummary) => void }) {
  const worktrees = useWorktrees()
  const items = [...(worktrees.data ?? [])].sort((a, b) => worktreeName(a.path).localeCompare(worktreeName(b.path)))

  return (
    <Menu position="bottom-end" withinPortal shadow="md">
      <Menu.Target>
        <Button size="compact-sm" variant="light" rightSection={<IconChevronDown size={14} />}>
          Follow
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Follow in worktree</Menu.Label>
        {items.length === 0 ? (
          <Menu.Item disabled>{worktrees.isLoading ? "Loading…" : "No worktrees"}</Menu.Item>
        ) : (
          <ScrollArea.Autosize mah={320} type="auto">
            {items.map((w) => (
              <Menu.Item key={w.path} onClick={() => onPick(w)}>
                <WorktreeWorkspaceName path={w.path} />
              </Menu.Item>
            ))}
          </ScrollArea.Autosize>
        )}
      </Menu.Dropdown>
    </Menu>
  )
}
