import type { ReactElement } from "react"
import { Group, HoverCard, Loader, Stack, Text } from "@mantine/core"
import { useCmuxMatches } from "../../api/cmux"
import { useAllResources } from "../../hooks/useAllResources"
import type { CmuxWorkspace, OpenBlocker } from "../../api/types"
import { worktreeName } from "../../lib/homeWorktree"
import { tildify, useHomeDir } from "../../lib/tildify"
import { shortResourceRef } from "../../lib/resourceRef"
import { AllResourceSummary } from "../AllResourceRow"
import { ColorBar } from "../CmuxWorkspaceSection"

/**
 * Keeps a click inside a hover card from reaching what holds its target (a
 * task row opens its modal on click). React bubbles portalled events along
 * the component tree, so the dropdown's clicks would otherwise arrive there.
 */
const keepInside = (e: React.SyntheticEvent) => e.stopPropagation()

/** A hover preview: opens after a pause, and is something to read, not use. */
function Preview({ target, width, children }: { target: ReactElement; width: number; children: React.ReactNode }) {
  return (
    <HoverCard openDelay={0} closeDelay={100} position="bottom-start" shadow="md" withinPortal>
      <HoverCard.Target>{target}</HoverCard.Target>
      <HoverCard.Dropdown p="xs" w={width} maw="90vw" onClick={keepInside}>
        {children}
      </HoverCard.Dropdown>
    </HoverCard>
  )
}

/**
 * A worktree named by its cmux workspace, as a short inline label: the
 * workspace's colour bar and its title, which truncates. `suffix` (a "+2")
 * never does.
 */
export function WorkspaceLabel({ ws, suffix }: { ws: CmuxWorkspace; suffix?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, maxWidth: "100%", verticalAlign: "bottom" }}>
      <span
        aria-hidden
        data-testid="workspace-color"
        style={{ width: 3, height: "1em", borderRadius: 2, background: ws.color || "var(--mantine-color-gray-6)", flex: "none" }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{ws.title}</span>
      {suffix && <span style={{ flex: "none", whiteSpace: "pre" }}>{suffix}</span>}
    </span>
  )
}

/** The full names behind a worktree link: its cmux workspaces, then the worktree itself. */
function WorktreeDetails({ path, branch }: { path: string; branch?: string }) {
  const workspaces = useCmuxMatches(path)
  const home = useHomeDir()
  const name = worktreeName(path)
  return (
    <Stack gap={4}>
      {workspaces.map((ws) => (
        <Group key={ws.ref} gap={8} wrap="nowrap">
          <ColorBar color={ws.color} />
          <Text size="sm" fw={600} style={{ wordBreak: "break-word" }}>{ws.title}</Text>
        </Group>
      ))}
      <Text size="sm" style={{ wordBreak: "break-word" }}>⎇ {name}</Text>
      {branch && branch !== name && (
        <Text size="xs" c="dimmed" style={{ wordBreak: "break-word" }}>branch {branch}</Text>
      )}
      <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>{tildify(path, home)}</Text>
    </Stack>
  )
}

/** Hovering `children` shows the worktree's full cmux workspace and worktree names. */
export function WorktreeHoverCard({ path, branch, children }: { path: string; branch?: string; children: ReactElement }) {
  return (
    <Preview target={children} width={320}>
      <WorktreeDetails path={path} branch={branch} />
    </Preview>
  )
}

/**
 * The resource as the home page's Resources tab shows it. Only followed
 * resources are in that list; anything else (an archived link) says so.
 */
function ResourceDetails({ type, id, label }: { type: string; id: string; label?: string }) {
  const all = useAllResources()
  if (all.isPending) return <Loader size="xs" />
  const r = all.data?.find((x) => x.type === type && x.id === id)
  if (!r) {
    // A blocker's own label names it better than a bare ref.
    if (label) return <Text size="xs">{label}</Text>
    return (
      <Text size="xs" c="dimmed">
        {shortResourceRef(type, id) || id} · no worktree follows it
      </Text>
    )
  }
  // No worktree previews: a hover card inside this one would close it.
  return <AllResourceSummary r={r} preview={false} />
}

/**
 * Hovering `children` (a task row's "blocked" chip) lists the unresolved
 * blockers: a resource as the Resources tab shows it, anything else by its
 * label.
 */
export function BlockersHoverCard({ blockers, children }: { blockers: OpenBlocker[]; children: ReactElement }) {
  const resources = blockers.some((b) => b.resource_type && b.resource_id)
  return (
    <Preview target={children} width={resources ? 420 : 320}>
      <Stack gap={6}>
        <Text size="xs" fw={600}>Blocked by</Text>
        {blockers.map((b, i) =>
          b.resource_type && b.resource_id ? (
            <div key={i}>
              <ResourceDetails type={b.resource_type} id={b.resource_id} label={b.label} />
            </div>
          ) : (
            <Text size="xs" key={i}>{b.label}</Text>
          ),
        )}
      </Stack>
    </Preview>
  )
}

/** Hovering `children` shows the resource's card, as on the home page's Resources tab. */
export function ResourceHoverCard({ type, id, children }: { type: string; id: string; children: ReactElement }) {
  return (
    <Preview target={children} width={420}>
      <ResourceDetails type={type} id={id} />
    </Preview>
  )
}
