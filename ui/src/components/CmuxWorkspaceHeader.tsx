import { Button, Group, Title } from "@mantine/core"
import { IconPrompt } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api/client"
import { useCmux } from "../api/cmux"
import type { CmuxWorkspace } from "../api/types"
import { ACTION_MIN_WIDTH, ColorBar } from "./CmuxWorkspaceSection"
import { CreateWorkspaceModal } from "./CreateWorkspaceModal"

/**
 * The detail page's header splits what CmuxWorkspaceSection renders as one
 * strip: the workspace name sits beside the worktree name on the left, and
 * its action sits with the page's other controls on the right. Both halves
 * read the same shared cmux query, and like the section they render nothing
 * outside cmux, so the header looks as it did before cmux support.
 */
function useMatches(path: string): CmuxWorkspace[] | null {
  const cmux = useCmux()
  if (!cmux.data?.available) return null
  return cmux.data.matches?.[path] ?? []
}

export function CmuxWorkspaceTitles({ path }: { path: string }) {
  const matches = useMatches(path)
  if (!matches?.length) return null
  return (
    <>
      {matches.map((ws) => (
        <Group key={ws.ref} gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <ColorBar color={ws.color} />
          {/* Same size as the worktree name: the workspace is how you think
              about the work, so it is not a subtitle here. */}
          <Title order={4} style={{ minWidth: 0, overflowWrap: "anywhere" }}>{ws.title}</Title>
        </Group>
      ))}
    </>
  )
}

export function CmuxWorkspaceActions({ path, branch }: { path: string; branch: string }) {
  const matches = useMatches(path)
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const select = useMutation({
    mutationFn: (ref: string) => api.cmuxSelect(ref),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cmux"] }),
  })

  if (!matches) return null

  return (
    <>
      {matches.length === 0 ? (
        <Button
          size="compact-sm"
          variant="subtle"
          miw={ACTION_MIN_WIDTH}
          style={{ flex: "none" }}
          onClick={() => setCreateOpen(true)}
        >
          Create cmux workspace
        </Button>
      ) : (
        matches.map((ws) => (
          <Button
            key={ws.ref}
            size="compact-sm"
            variant="subtle"
            miw={ACTION_MIN_WIDTH}
            style={{ flex: "none" }}
            leftSection={<IconPrompt size={14} />}
            disabled={ws.selected || select.isPending}
            onClick={() => select.mutate(ws.ref)}
          >
            {ws.selected ? "Current" : "Switch cmux"}
          </Button>
        ))
      )}
      <CreateWorkspaceModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        path={path}
        branch={branch}
      />
    </>
  )
}
