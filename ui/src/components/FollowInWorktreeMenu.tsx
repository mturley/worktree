import { Button, Group, Menu, ScrollArea, Stack, Text } from "@mantine/core"
import { IconChevronDown } from "@tabler/icons-react"
import { useCmux } from "../api/cmux"
import type { WorktreeSummary } from "../api/types"
import { useWorktrees } from "../hooks/useWorktrees"
import { ColorBar } from "./CmuxWorkspaceSection"

/**
 * Picks a worktree to follow a resource in. Each worktree is named the way
 * the detail page's header names it: its cmux workspaces, colour bar and
 * title, heading the branch — or just the branch outside cmux.
 */
export function FollowInWorktreeMenu({ onPick }: { onPick: (w: WorktreeSummary) => void }) {
  const worktrees = useWorktrees()
  const cmux = useCmux()
  const matches = cmux.data?.available ? cmux.data.matches ?? {} : {}
  const items = [...(worktrees.data ?? [])].sort((a, b) => a.branch.localeCompare(b.branch))

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
            {items.map((w) => {
              const workspaces = matches[w.path] ?? []
              return (
                <Menu.Item key={w.path} onClick={() => onPick(w)}>
                  <Stack gap={2}>
                    {workspaces.map((ws) => (
                      <Group key={ws.ref} gap={8} wrap="nowrap">
                        <ColorBar color={ws.color} />
                        <Text size="sm" fw={600}>{ws.title}</Text>
                      </Group>
                    ))}
                    <Text size={workspaces.length ? "xs" : "sm"} c={workspaces.length ? "dimmed" : undefined}>
                      {w.branch}
                    </Text>
                  </Stack>
                </Menu.Item>
              )
            })}
          </ScrollArea.Autosize>
        )}
      </Menu.Dropdown>
    </Menu>
  )
}
