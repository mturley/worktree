import { Button, Group, Stack, Text } from "@mantine/core"
import { IconPrompt } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api/client"
import { useCmux } from "../api/cmux"
import type { CmuxWorkspace } from "../api/types"
import { CreateWorkspaceModal } from "./CreateWorkspaceModal"

/** Neutral bar for a workspace with no colour set, so rows stay aligned. */
const NO_COLOR = "var(--mantine-color-dark-4)"

/**
 * Shared floor for the row's action button.
 *
 * Two jobs. It stops a long workspace name squeezing the button into an
 * ellipsis (the name wraps instead — it is the flexible half of the row), and
 * it keeps the buttons in a column the same width even though their labels
 * differ in length: a selected workspace reads "Current" while its neighbours
 * read "Switch cmux". Sized to fit the longer of the two, so the column edge
 * stays straight.
 */
const ACTION_MIN_WIDTH = 128

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
 *
 * Inside cmux, a matched workspace name is the card's HEADLINE: the workspace
 * is how you actually think about the work, and the worktree title steps down
 * to a subtitle (see WorktreeCard, which reads the same shared query to size
 * itself). The no-match row stays small and dimmed — "No cmux workspace" is
 * not a heading worth shouting.
 *
 * The section sits OUTSIDE the card's anchor, so it sets its own default
 * cursor: the card lights up on hover as one surface, but this strip is not
 * itself a navigation target.
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

  // The home card is one big navigation target. Without stopPropagation a
  // click here would bubble to the card and navigate as well as act.
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  return (
    // The margin lives here rather than on either card, so the gap under the
    // workspace header is the same wherever the section is used. The list
    // card places the section as a bare sibling of its content (no Stack gap
    // to inherit), so without this the header sat flush against the title.
    <div data-cmux-section style={{ cursor: "default", marginBottom: 8 }}>
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
              miw={ACTION_MIN_WIDTH}
              style={{ flex: "none" }}
              onClick={(e) => { stop(e); setCreateOpen(true) }}
            >
              Create cmux workspace
            </Button>
          </Group>
        ) : (
          matches.map((ws) => (
            <Group
              key={ws.ref}
              gap={8}
              wrap="nowrap"
              justify="space-between"
              // Top-aligned so the button stays put when a long name wraps.
              align="flex-start"
            >
              <Group gap={8} wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
                <ColorBar color={ws.color} />
                <Text
                  fw={700}
                  size="md"
                  // Wraps rather than truncating: a workspace title often
                  // carries the status a person actually needs to read
                  // ("… (waiting for review)"), which an ellipsis would eat.
                  style={{ minWidth: 0, overflowWrap: "anywhere" }}
                >
                  {ws.title}
                </Text>
              </Group>
              <Button
                size="compact-xs"
                variant="subtle"
                miw={ACTION_MIN_WIDTH}
                style={{ flex: "none" }}
                leftSection={<IconPrompt size={14} />}
                disabled={ws.selected || select.isPending}
                onClick={(e) => { stop(e); select.mutate(ws.ref) }}
              >
                {ws.selected ? "Current" : "Switch cmux"}
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
