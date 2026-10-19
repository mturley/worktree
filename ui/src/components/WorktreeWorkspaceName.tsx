import { Group, Stack, Text } from "@mantine/core"
import { useCmux } from "../api/cmux"
import { ColorBar } from "./CmuxWorkspaceSection"

/**
 * A worktree named the way the detail page's header names it: its cmux
 * workspaces, colour bar and title, heading the branch — or just the branch
 * outside cmux.
 */
export function WorktreeWorkspaceName({ path, branch }: { path: string; branch: string }) {
  const cmux = useCmux()
  const workspaces = cmux.data?.available ? cmux.data.matches?.[path] ?? [] : []
  return (
    <Stack gap={2}>
      {workspaces.map((ws) => (
        <Group key={ws.ref} gap={8} wrap="nowrap">
          <ColorBar color={ws.color} />
          <Text size="sm" fw={600}>{ws.title}</Text>
        </Group>
      ))}
      <Text size={workspaces.length ? "xs" : "sm"} c={workspaces.length ? "dimmed" : undefined}>
        {branch}
      </Text>
    </Stack>
  )
}
