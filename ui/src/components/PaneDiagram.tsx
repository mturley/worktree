import { ActionIcon, Box, Button, Group, Popover, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core"
import { IconFile, IconMarkdown, IconTerminal2, IconWorld, IconX } from "@tabler/icons-react"
import { useState, type CSSProperties, type ReactNode } from "react"
import type { CmuxLayout, CmuxMove, CmuxPane, CmuxTab } from "../api/types"
import { windowTabs } from "../lib/windowTabs"

/** Tabs listed per pane before the rest collapse into "Show N more tabs". */
export const VISIBLE_TABS = 10

const BORDER = "1px solid var(--mantine-color-default-border)"

const TAB_ICONS: Record<string, typeof IconFile> = {
  terminal: IconTerminal2,
  browser: IconWorld,
  markdown: IconMarkdown,
}

interface Handlers {
  onSelect: (tab: CmuxTab) => void
  onClose: (tab: CmuxTab) => void
}

interface Props extends Handlers {
  layout: CmuxLayout
  panes: CmuxPane[]
  onMove: (move: CmuxMove) => void
}

/**
 * A cmux workspace's panes drawn in their real arrangement: side-by-side
 * splits share the width by cmux's ratio; heights follow the content, so a
 * short pane never leaves a tall empty box. Each pane lists up to
 * VISIBLE_TABS tabs (see windowTabs) with the rest behind "Show N more tabs"
 * links that expand in place.
 *
 * Expansion lives here, so it resets whenever the diagram remounts — which
 * the card arranges by unmounting the cmux tab when it is not selected.
 */
export function PaneDiagram({ layout, panes, onSelect, onClose }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const setGroup = (key: string, open: boolean) =>
    setExpanded((cur) => {
      const next = new Set(cur)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  const byRef = new Map(panes.map((p) => [p.ref, p]))
  return (
    <Box style={{ display: "flex", border: BORDER, borderRadius: "var(--mantine-radius-sm)", overflow: "hidden" }}>
      <LayoutView node={layout} grow={1} byRef={byRef} expanded={expanded} setGroup={setGroup} onSelect={onSelect} onClose={onClose} />
    </Box>
  )
}

interface ViewProps extends Handlers {
  byRef: Map<string, CmuxPane>
  expanded: ReadonlySet<string>
  setGroup: (key: string, open: boolean) => void
}

function LayoutView({ node, grow, edge, ...rest }: ViewProps & { node: CmuxLayout; grow: number; edge?: "left" | "top" }) {
  const style: CSSProperties = {
    flex: `${grow} 1 0`,
    minWidth: 0,
    display: "flex",
    borderLeft: edge === "left" ? BORDER : undefined,
    borderTop: edge === "top" ? BORDER : undefined,
  }
  if (node.pane !== undefined) {
    const pane = rest.byRef.get(node.pane) ?? { ref: node.pane, focused: false, tabs: [] }
    return <PaneBox pane={pane} style={style} {...rest} />
  }
  const [a, b] = node.children ?? []
  const split = node.split ?? 0.5
  const vertical = node.direction === "vertical"
  return (
    <div data-split={node.direction} style={{ ...style, flexDirection: vertical ? "column" : "row" }}>
      {a && <LayoutView node={a} grow={split} {...rest} />}
      {b && <LayoutView node={b} grow={1 - split} edge={vertical ? "top" : "left"} {...rest} />}
    </div>
  )
}

function PaneBox({ pane, style, expanded, setGroup, onSelect, onClose }: ViewProps & { pane: CmuxPane; style: CSSProperties }) {
  const { before, shown, after } = windowTabs(pane.tabs, VISIBLE_TABS)
  const rows = (list: CmuxTab[]) => list.map((tab) => <TabRow key={tab.ref} tab={tab} onSelect={onSelect} onClose={onClose} />)
  // A collapsed group is one link standing exactly where its tabs would be,
  // so cmux's order survives; "Show fewer" takes the link's place when open.
  const group = (list: CmuxTab[], side: "before" | "after"): ReactNode => {
    if (list.length === 0) return null
    const key = `${pane.ref}:${side}`
    if (!expanded.has(key)) {
      return <MoreLink onClick={() => setGroup(key, true)}>{`Show ${list.length} more tab${list.length === 1 ? "" : "s"}`}</MoreLink>
    }
    const fewer = <MoreLink onClick={() => setGroup(key, false)}>Show fewer</MoreLink>
    return side === "before" ? <>{fewer}{rows(list)}</> : <>{rows(list)}{fewer}</>
  }
  return (
    <Stack
      gap={1}
      p={4}
      data-pane={pane.ref}
      style={{
        ...style,
        flexDirection: "column",
        // The focused pane is the one cmux sends keystrokes to.
        boxShadow: pane.focused ? "inset 0 0 0 1px var(--mantine-color-blue-filled)" : undefined,
      }}
    >
      {pane.tabs.length === 0 && <Text size="xs" c="dimmed" fs="italic" px={4}>No tabs</Text>}
      {group(before, "before")}
      {rows(shown)}
      {group(after, "after")}
    </Stack>
  )
}

function MoreLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <UnstyledButton onClick={onClick} px={4} pl={22}>
      <Text size="xs" c="blue">{children}</Text>
    </UnstyledButton>
  )
}

function TabRow({ tab, onSelect, onClose }: Handlers & { tab: CmuxTab }) {
  const [confirming, setConfirming] = useState(false)
  const Icon = TAB_ICONS[tab.type] ?? IconFile
  // A terminal may be running something (a dev server, an agent); everything
  // else closes like clicking ✕ in cmux.
  const close = () => (tab.type === "terminal" ? setConfirming(true) : onClose(tab))
  return (
    <Group gap={2} wrap="nowrap" className="cmux-tab-row" style={{ borderRadius: 4, minWidth: 0 }}>
      <Tooltip
        // Not the native title attribute: cmux's embedded browser does not
        // show those.
        label={
          <>
            <Text size="xs" fw={600}>{tab.title}</Text>
            {tab.url && <Text size="xs" style={{ wordBreak: "break-all" }}>{tab.url}</Text>}
          </>
        }
        openDelay={400}
        multiline
        maw={360}
      >
        <UnstyledButton
          aria-label={`Switch to ${tab.title}`}
          onClick={() => onSelect(tab)}
          style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4, padding: "1px 4px" }}
        >
          <Icon size={12} style={{ flex: "none" }} color={tab.selected ? "var(--mantine-color-blue-filled)" : "var(--mantine-color-dimmed)"} />
          <Text size="xs" truncate fw={tab.selected ? 700 : 400} data-selected={tab.selected || undefined}>
            {tab.title}
          </Text>
        </UnstyledButton>
      </Tooltip>
      <Popover opened={confirming} onChange={setConfirming} position="bottom-end" withArrow shadow="md">
        <Popover.Target>
          <ActionIcon variant="subtle" color="gray" size="xs" className="cmux-tab-close" aria-label={`Close ${tab.title}`} onClick={close}>
            <IconX size={10} />
          </ActionIcon>
        </Popover.Target>
        <Popover.Dropdown>
          <Text size="xs">Close terminal "{tab.title}"?</Text>
          <Group gap="xs" justify="flex-end" mt={6}>
            <Button size="compact-xs" variant="subtle" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button size="compact-xs" color="red" onClick={() => { setConfirming(false); onClose(tab) }}>Close</Button>
          </Group>
        </Popover.Dropdown>
      </Popover>
    </Group>
  )
}
