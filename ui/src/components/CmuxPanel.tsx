import { ActionIcon, Button, Group, Popover, Stack, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core"
import { IconPencil } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "../api/client"
import { useCmuxAction, useCmuxMove, useCmuxTree } from "../api/cmuxTree"
import type { CmuxActionResult, CmuxTreeWorkspace } from "../api/types"
import { CreateWorkspaceModal } from "./CreateWorkspaceModal"
import { PaneDiagram } from "./PaneDiagram"

const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * The details card's cmux tab: for each cmux workspace matching this
 * worktree, its title and colour (both editable) and a diagram of its panes
 * and tabs. Mounted only while the tab is selected, so its 5s poll and its
 * expanded "Show N more tabs" groups both end when you leave the tab.
 */
export function CmuxPanel({ path, branch }: { path: string; branch: string }) {
  const { move, moving } = useCmuxMove(path)
  // A poll mid-drag would refresh the diagram's data (and cmux focusing the
  // target pane on every move blurs/refocuses the UI's own webview) out from
  // under dnd-kit, so it pauses for the drag's duration too, not just the
  // settle wait after it.
  const [dragging, setDragging] = useState(false)
  const tree = useCmuxTree(path, moving || dragging)
  const [createOpen, setCreateOpen] = useState(false)

  if (tree.isPending) return <Text size="xs" c="dimmed">Loading cmux workspace…</Text>
  // In React Query v5, isError stays true after a failed BACKGROUND refetch
  // even though the earlier successful data is still cached (isError and
  // data are independent flags) — keep showing that cached panel rather than
  // replacing it with a full-panel error over a transient poll failure.
  if (tree.isError && !tree.data) return <Text size="xs" c="red">Could not load the cmux workspace: {tree.error.message}</Text>
  if (!tree.data.available) return <Text size="xs" c="dimmed">cmux is not reachable.</Text>

  if (tree.data.workspaces.length === 0) {
    return (
      <Group gap="xs">
        <Text size="xs" c="dimmed">No cmux workspace</Text>
        <Button size="compact-xs" variant="subtle" onClick={() => setCreateOpen(true)}>Create cmux workspace</Button>
        <CreateWorkspaceModal opened={createOpen} onClose={() => setCreateOpen(false)} path={path} branch={branch} />
      </Group>
    )
  }
  return (
    <Stack gap="md">
      {tree.data.workspaces.map((ws) => (
        <WorkspaceBlock key={ws.id} path={path} ws={ws} onMove={move} onDragActiveChange={setDragging} />
      ))}
    </Stack>
  )
}

function WorkspaceBlock({ path, ws, onMove, onDragActiveChange }: {
  path: string
  ws: CmuxTreeWorkspace
  onMove: ReturnType<typeof useCmuxMove>["move"]
  onDragActiveChange: (active: boolean) => void
}) {
  const run = useCmuxAction(path)
  // One line under the header; cleared by the next action that succeeds.
  const [error, setError] = useState<string | null>(null)
  const act = async (action: () => Promise<CmuxActionResult>) => setError(await run(action))

  return (
    <Stack gap={6}>
      <Group gap={8} wrap="nowrap">
        <ColorPicker color={ws.color} onPick={(c) => act(() => api.cmuxColor(ws.id, c))} />
        <EditableTitle title={ws.title} onSave={(t) => act(() => api.cmuxRename(ws.id, t))} />
      </Group>
      {error && <Text size="xs" c="red">{error}</Text>}
      {ws.error ? (
        <Text size="xs" c="red">Could not read panes: {ws.error}</Text>
      ) : ws.layout && ws.panes ? (
        <PaneDiagram
          layout={ws.layout}
          panes={ws.panes}
          onSelect={(tab) => act(() => api.cmuxFocusTab(ws.id, tab.ref))}
          onClose={(tab) => act(() => api.cmuxCloseTab(ws.id, { surface: tab.ref, type: tab.type, title: tab.title }))}
          onMove={async (m) => setError(await onMove(ws, m))}
          onDragActiveChange={onDragActiveChange}
        />
      ) : null}
    </Stack>
  )
}

/** Enter saves, Esc or leaving the field cancels. Saving empty hands the title back to cmux. */
function EditableTitle({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft === null) {
    return (
      <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
        <Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>{title}</Text>
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Rename workspace" onClick={() => setDraft(title)}>
          <IconPencil size={14} />
        </ActionIcon>
      </Group>
    )
  }
  return (
    <TextInput
      size="xs"
      aria-label="Workspace title"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          onSave(draft)
          setDraft(null)
        } else if (e.key === "Escape") {
          e.preventDefault()
          setDraft(null)
        }
      }}
    />
  )
}

/**
 * The 16 named swatches (from the server, as in the create modal), any
 * #RRGGBB — the user's workspaces use colours outside the named set — and
 * Clear.
 */
function ColorPicker({ color, onPick }: { color?: string; onPick: (color: string) => void }) {
  const [opened, setOpened] = useState(false)
  const [hex, setHex] = useState("")
  const meta = useQuery({ queryKey: ["cmux-groups"], queryFn: () => api.cmuxGroups(), enabled: opened })
  const pick = (c: string) => {
    setOpened(false)
    onPick(c)
  }
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" withArrow shadow="md">
      <Popover.Target>
        <UnstyledButton
          aria-label="Workspace color"
          onClick={() => {
            setHex(color ?? "")
            setOpened((o) => !o)
          }}
          style={{
            width: 14,
            height: 14,
            flex: "none",
            borderRadius: "50%",
            background: color || "var(--mantine-color-dark-4)",
            border: "2px solid var(--mantine-color-default-border)",
          }}
        />
      </Popover.Target>
      <Popover.Dropdown>
        <Group gap={6} maw={204}>
          {(meta.data?.colors ?? []).map((c) => (
            <Tooltip key={c.name} label={c.name}>
              <UnstyledButton
                aria-label={c.name}
                onClick={() => pick(c.hex)}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  background: c.hex,
                  border: color?.toLowerCase() === c.hex.toLowerCase()
                    ? "2px solid var(--mantine-color-text)"
                    : "2px solid transparent",
                }}
              />
            </Tooltip>
          ))}
        </Group>
        <Group gap={6} mt={8} wrap="nowrap">
          <TextInput
            size="xs"
            w={96}
            aria-label="Custom color"
            placeholder="#RRGGBB"
            value={hex}
            error={hex !== "" && !HEX.test(hex)}
            onChange={(e) => setHex(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && HEX.test(hex)) pick(hex)
            }}
          />
          <Button size="compact-xs" variant="subtle" disabled={!HEX.test(hex)} onClick={() => pick(hex)}>Set</Button>
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => pick("")}>Clear</Button>
        </Group>
      </Popover.Dropdown>
    </Popover>
  )
}
