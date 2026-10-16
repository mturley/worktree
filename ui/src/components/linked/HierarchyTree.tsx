import { useState } from "react"
import { ActionIcon, Anchor, Badge, Box, Loader, Text } from "@mantine/core"
import { IconChevronDown, IconChevronRight, IconDots } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { LinkedTreeNode } from "../../api/types"
import { ICON_GAP, LinkedResourceRow, ROW_PY, TOGGLE_GAP, TOGGLE_W } from "./LinkedResourceRow"

// Also the divider inset in cards.css (.linked-item::before), so the lines
// between items start at the tree's first level.
const INDENT_PX = 20

function MoreRow({ url, depth }: { url: string; depth: number }) {
  return (
    <Box pl={depth * INDENT_PX + TOGGLE_W + TOGGLE_GAP} py={4} className="linked-item">
      <Anchor href={url} target="_blank" rel="noreferrer" size="sm">More on Jira…</Anchor>
    </Box>
  )
}

/** Whether this node is the current issue or one of its ancestors. */
function leadsToCurrent(node: LinkedTreeNode): boolean {
  return !!node.current || (node.children ?? []).some(leadsToCurrent)
}

/**
 * Stands in for an ancestor's other children (the current issue's siblings,
 * or an ancestor's): the tree opens on the path to the current issue and its
 * descendants, and the rest of each level is one click away.
 */
function ShowMoreChildrenRow({ parentKey, depth, onShow }: { parentKey: string; depth: number; onShow: () => void }) {
  return (
    // Laid out like a row (icon where the issue-type icon goes) so it reads as
    // a stand-in for the siblings it hides.
    <Box pl={depth * INDENT_PX + TOGGLE_W + TOGGLE_GAP} py={ROW_PY} className="linked-item" style={{ display: "flex", alignItems: "center", gap: ICON_GAP }}>
      <IconDots size={16} aria-hidden style={{ color: "var(--mantine-color-dimmed)", flexShrink: 0 }} />
      <Anchor component="button" type="button" size="sm" onClick={onShow}>
        Show more children of {parentKey}…
      </Anchor>
    </Box>
  )
}

function TreeNodeView({ node, depth, path, unfold }: { node: LinkedTreeNode; depth: number; path?: string; unfold: boolean }) {
  const [expanded, setExpanded] = useState(node.expanded)
  // An ancestor of the current issue starts out showing only the child on the
  // way down to it. Remounting the panel (leaving the tab and coming back)
  // folds them up again.
  const [showAllChildren, setShowAllChildren] = useState(false)
  const lazy = !node.children && node.has_children !== false
  // Children the server didn't send are fetched as soon as the node is shown,
  // not when it's expanded: whether a node HAS children decides whether it
  // gets a chevron, and a chevron that vanishes once you click it (because
  // the answer was "none") is worse than one that appears a moment late.
  // Nodes folded behind "Show more children of …" aren't rendered, so they
  // fetch nothing until unfolded.
  const kids = useQuery({
    queryKey: ["linked-children", node.id],
    queryFn: () => api.linkedChildren(node.id),
    enabled: lazy,
    staleTime: 2 * 60_000,
  })
  const children = node.children ?? kids.data?.items
  const more = node.more ?? kids.data?.more ?? undefined
  const canExpand = node.children
    ? node.children.length > 0
    // An error still offers the chevron, so expanding shows what went wrong.
    : lazy && ((kids.data?.items.length ?? 0) > 0 || kids.isError)

  const highlightInset = node.current && depth > 0 ? INDENT_PX : 0

  return (
    <>
      <Box
        // The current issue's highlight starts at the tree's first level,
        // like the dividers, rather than at the panel edge. The box itself is
        // moved in, so its divider is moved back out to match the others.
        ml={highlightInset}
        pl={depth * INDENT_PX - highlightInset}
        className={highlightInset ? "linked-item linked-item-inset" : "linked-item"}
        style={node.current ? {
          borderLeft: "3px solid var(--mantine-primary-color-filled)",
          background: "var(--mantine-primary-color-light)",
          borderRadius: 4,
        } : undefined}
      >
        <LinkedResourceRow
          item={node}
          path={path}
          hideFollow={node.current}
          marker={node.current ? <Badge size="sm" variant="filled">this issue</Badge> : undefined}
          // On the key line, before the icon.
          toggle={canExpand ? (
            <ActionIcon
              variant="subtle" size="sm" color="gray"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${node.id}`}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ActionIcon>
          ) : (
            <Box w={TOGGLE_W} />
          )}
        />
      </Box>
      {expanded && kids.isLoading && <Box pl={(depth + 1) * INDENT_PX + TOGGLE_W + TOGGLE_GAP}><Loader size="xs" /></Box>}
      {expanded && kids.error && (
        <Text size="xs" c="red" pl={(depth + 1) * INDENT_PX + TOGGLE_W + TOGGLE_GAP}>Couldn't load child issues</Text>
      )}
      {expanded && (() => {
        const folding = !unfold && !node.current && !showAllChildren && leadsToCurrent(node)
        const shown = folding ? (children ?? []).filter(leadsToCurrent) : (children ?? [])
        const hidden = (children?.length ?? 0) - shown.length + (more ? 1 : 0)
        return (
          <>
            {/* Above the child on the path, so the path reads as one unbroken
                run down to the current issue. */}
            {folding && hidden > 0 && (
              <ShowMoreChildrenRow parentKey={node.id} depth={depth + 1} onShow={() => setShowAllChildren(true)} />
            )}
            {shown.map((c) => <TreeNodeView key={c.id} node={c} depth={depth + 1} path={path} unfold={unfold} />)}
            {!folding && more && <MoreRow url={more.url} depth={depth + 1} />}
          </>
        )
      })()}
    </>
  )
}

/** The Jira hierarchy as an indented tree; collapsed nodes load lazily. */
/**
 * `unfold` turns off folding siblings behind "Show more children of …":
 * while searching, every node left in the tree is a match or on the way to
 * one, so none may hide.
 */
export function HierarchyTree({ roots, path, unfold = false }: { roots: LinkedTreeNode[]; path?: string; unfold?: boolean }) {
  return <>{roots.map((n) => <TreeNodeView key={n.id} node={n} depth={0} path={path} unfold={unfold} />)}</>
}
