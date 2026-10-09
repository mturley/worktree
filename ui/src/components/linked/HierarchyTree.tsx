import { useState } from "react"
import { ActionIcon, Anchor, Badge, Box, Loader, Text } from "@mantine/core"
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { LinkedTreeNode } from "../../api/types"
import { LinkedResourceRow } from "./LinkedResourceRow"

const INDENT_PX = 20

function MoreRow({ url, depth }: { url: string; depth: number }) {
  return (
    <Box pl={depth * INDENT_PX + 26} py={4}>
      <Anchor href={url} target="_blank" rel="noreferrer" size="sm">More on Jira…</Anchor>
    </Box>
  )
}

function TreeNodeView({ node, depth, path }: { node: LinkedTreeNode; depth: number; path?: string }) {
  const [expanded, setExpanded] = useState(node.expanded)
  const lazy = !node.children && node.has_children !== false
  const kids = useQuery({
    queryKey: ["linked-children", node.id],
    queryFn: () => api.linkedChildren(node.id),
    enabled: expanded && lazy,
    staleTime: 2 * 60_000,
  })
  const children = node.children ?? kids.data?.items
  const more = node.more ?? kids.data?.more ?? undefined
  const canExpand = node.has_children !== false && (node.children ? node.children.length > 0 : true)
  const loadedEmpty = lazy && kids.isSuccess && (kids.data?.items.length ?? 0) === 0

  return (
    <>
      <Box
        pl={depth * INDENT_PX}
        style={node.current ? {
          borderLeft: "3px solid var(--mantine-primary-color-filled)",
          background: "var(--mantine-primary-color-light)",
          borderRadius: 4,
        } : undefined}
      >
        <Box style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {canExpand && !loadedEmpty ? (
            <ActionIcon
              variant="subtle" size="sm" color="gray"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${node.id}`}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ActionIcon>
          ) : (
            <Box w={22} />
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <LinkedResourceRow
              item={node}
              path={path}
              hideFollow={node.current}
              marker={node.current ? <Badge size="sm" variant="filled">this issue</Badge> : undefined}
            />
          </Box>
        </Box>
      </Box>
      {expanded && kids.isLoading && <Box pl={(depth + 1) * INDENT_PX + 26}><Loader size="xs" /></Box>}
      {expanded && kids.error && (
        <Text size="xs" c="red" pl={(depth + 1) * INDENT_PX + 26}>Couldn't load child issues</Text>
      )}
      {expanded && children?.map((c) => <TreeNodeView key={c.id} node={c} depth={depth + 1} path={path} />)}
      {expanded && more && <MoreRow url={more.url} depth={depth + 1} />}
    </>
  )
}

/** The Jira hierarchy as an indented tree; collapsed nodes load lazily. */
export function HierarchyTree({ roots, path }: { roots: LinkedTreeNode[]; path?: string }) {
  return <>{roots.map((n) => <TreeNodeView key={n.id} node={n} depth={0} path={path} />)}</>
}
