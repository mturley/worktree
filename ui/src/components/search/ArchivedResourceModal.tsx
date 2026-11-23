import { Anchor, Group, Modal, Paper, Stack, Text } from "@mantine/core"
import type { AllResourceDTO } from "../../api/types"
import { ResourceCardBody } from "../ResourceCard"
import { FollowInWorktreeMenu } from "../FollowInWorktreeMenu"
import { worktreeName } from "../../lib/homeWorktree"

/**
 * What an archived resource picked in the home page's search opens: no
 * worktree follows it, so there is no worktree page to route to. Read-only:
 * the resource as its row shows it, where it was last followed, a link out
 * and a menu to follow it again (the caller navigates, as the archived
 * event's details do).
 */
export function ArchivedResourceModal({ r, onFollow, onClose }: {
  /** Closed while null. */
  r: AllResourceDTO | null
  onFollow: (worktreePath: string) => void
  onClose: () => void
}) {
  const last = r?.last_followed_by ?? []
  return (
    <Modal opened={!!r} onClose={onClose} title="Archived resource" size="lg">
      {r && (
        <Stack gap="sm">
          <Paper p="xs" withBorder>
            <ResourceCardBody r={r} />
          </Paper>
          <Text size="sm" c="dimmed">
            No worktree follows this resource any more.
            {last.length > 0 && (
              <>
                {last.map((w) => (
                  <span key={w.path} style={{ display: "block" }}>
                    Last followed in {w.branch || worktreeName(w.path)}
                  </span>
                ))}
              </>
            )}
          </Text>
          <Group justify="space-between">
            {r.url ? <Anchor href={r.url} target="_blank" rel="noreferrer" size="sm">Open</Anchor> : <span />}
            <FollowInWorktreeMenu onPick={(w) => onFollow(w.path)} />
          </Group>
        </Stack>
      )}
    </Modal>
  )
}
