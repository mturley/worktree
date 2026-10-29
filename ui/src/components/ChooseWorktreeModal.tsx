import { Modal, Paper, Stack, Text } from "@mantine/core"
import type { ResourceDTO, ResourceWorktree } from "../api/types"
import { ResourceCardBody } from "./ResourceCard"
import { WorktreeWorkspaceName } from "./WorktreeWorkspaceName"
import { worktreeName } from "../lib/homeWorktree"

/**
 * Asks which worktree to view a resource in, when more than one follows it.
 * The home page's Resources rows and Activity events open it: both span
 * every worktree, so a click on either has no single destination.
 *
 * The resource heads the modal as its row shows it, so you can see what you
 * clicked; each choice below is a card named as the worktree cards are.
 */
export function ChooseWorktreeModal({ r, worktrees, onPick, onClose }: {
  /** The resource to view; the modal is closed while this is null. */
  r: ResourceDTO | null
  worktrees: Pick<ResourceWorktree, "path" | "branch">[]
  onPick: (path: string) => void
  onClose: () => void
}) {
  return (
    <Modal opened={!!r} onClose={onClose} title="Choose a worktree" size="lg">
      {r && (
        <Stack gap="sm">
          <Paper p="xs" withBorder>
            <ResourceCardBody r={r} />
          </Paper>
          <Text size="sm">
            This resource is followed by {worktrees.length} worktrees. Which one do you want to view it in?
          </Text>
          <Stack gap="xs">
            {worktrees.map((w) => (
              <Paper
                key={w.path}
                component="button"
                type="button"
                p="sm"
                withBorder
                data-interactive="true"
                aria-label={`view in ${worktreeName(w.path)}`}
                onClick={() => onPick(w.path)}
                style={{ display: "block", width: "100%", textAlign: "left", font: "inherit", color: "inherit" }}
              >
                <WorktreeWorkspaceName path={w.path} />
              </Paper>
            ))}
          </Stack>
        </Stack>
      )}
    </Modal>
  )
}
