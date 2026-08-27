import { Button, Group, Stack, Text } from "@mantine/core"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api/client"
import { useCmux } from "../api/cmux"
import type { CmuxWorkspace } from "../api/types"
import { CreateWorkspaceModal } from "./CreateWorkspaceModal"

/** Neutral bar for a workspace with no colour set, so rows stay aligned. */
const NO_COLOR = "var(--mantine-color-dark-4)"

function ColorBar({ color }: { color?: string }) {
  return (
    <div
      aria-hidden
      style={{
        width: 3,
        alignSelf: "stretch",
        minHeight: 18,
        borderRadius: 2,
        background: color || NO_COLOR,
        flex: "none",
      }}
    />
  )
}

/**
 * The cmux workspace section, rendered above the worktree title on both the
 * home list card and the detail card.
 *
 * Renders NOTHING when the server is not running inside cmux — the card must
 * look exactly as it did before this feature existed. "cmux is up but no
 * workspace matches this worktree" is a normal state (7 of 10 matched when
 * measured), so it gets a Create button rather than an error.
 */
export function CmuxWorkspaceSection({ path, branch }: { path: string; branch: string }) {
  const cmux = useCmux()
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)

  const select = useMutation({
    mutationFn: (ref: string) => api.cmuxSelect(ref),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cmux"] }),
  })

  if (!cmux.data?.available) return null

  const matches: CmuxWorkspace[] = cmux.data.matches?.[path] ?? []

  // These buttons live inside the home page's card, which is one big
  // navigation target. Without stopPropagation, switching also navigates.
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    <div data-cmux-section>
      <Stack gap={4}>
        {matches.length === 0 ? (
          <Group gap={8} wrap="nowrap" justify="space-between">
            <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
              <ColorBar />
              <Text size="xs" c="dimmed">No cmux workspace</Text>
            </Group>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={(e) => { stop(e); setCreateOpen(true) }}
            >
              Create
            </Button>
          </Group>
        ) : (
          matches.map((ws) => (
            <Group key={ws.ref} gap={8} wrap="nowrap" justify="space-between">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                <ColorBar color={ws.color} />
                <Text size="xs" c="dimmed" lineClamp={1} style={{ minWidth: 0 }}>
                  {ws.title}
                </Text>
              </Group>
              <Button
                size="compact-xs"
                variant="subtle"
                disabled={ws.selected || select.isPending}
                onClick={(e) => { stop(e); select.mutate(ws.ref) }}
              >
                {ws.selected ? "Current" : "Switch"}
              </Button>
            </Group>
          ))
        )}
      </Stack>

      <CreateWorkspaceModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        path={path}
        branch={branch}
      />
    </div>
  )
}
