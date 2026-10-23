import { useEffect, useMemo } from "react"
import { Box, Text, Tree, getTreeExpandedState, useTree, type TreeNodeData } from "@mantine/core"
import { IconChevronRight, IconFile } from "@tabler/icons-react"

export interface TreeFile {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

// Directory values carry a prefix so a directory never collides with a file
// of the same path (a file "a" replaced by a directory "a/").
const DIR = "dir:"

interface Dir {
  dirs: Map<string, Dir>
  files: TreeFile[]
}

function build(files: TreeFile[]): TreeNodeData[] {
  const root: Dir = { dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split("/")
    let d = root
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p)
      if (!next) d.dirs.set(p, (next = { dirs: new Map(), files: [] }))
      d = next
    }
    d.files.push(f)
  }
  return toNodes(root, "")
}

function toNodes(d: Dir, prefix: string): TreeNodeData[] {
  const dirs = [...d.dirs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, sub]) => {
    // Compact a chain of directories that each hold only one directory, as
    // GitHub does: "internal/webui" rather than "internal" › "webui".
    let label = name
    let full = prefix + name
    while (sub.files.length === 0 && sub.dirs.size === 1) {
      const [[childName, child]] = [...sub.dirs.entries()]
      label += "/" + childName
      full += "/" + childName
      sub = child
    }
    return { value: DIR + full, label, children: toNodes(sub, full + "/") }
  })
  const files = [...d.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ value: f.path, label: f.path.slice(prefix.length), nodeProps: { file: f } }))
  return [...dirs, ...files]
}

/**
 * The diff view sidebar's file tree: directories collapsible, single-child
 * directory chains compacted, `+x −y` per file. Clicking a file selects it
 * (the view scrolls the diff to it); clicking a directory only folds it.
 */
export function DiffFileTree({
  files,
  selected,
  onSelect,
}: {
  files: TreeFile[]
  selected: string | null
  onSelect: (path: string) => void
}) {
  const data = useMemo(() => build(files), [files])
  const tree = useTree({ initialExpandedState: getTreeExpandedState(data, "*") })
  const { setExpandedState } = tree
  // Directories that appear later (the filter narrowing and widening again,
  // a reload adding files) start open; ones already folded stay folded.
  useEffect(() => {
    setExpandedState((prev) => ({ ...getTreeExpandedState(data, "*"), ...prev }))
  }, [data, setExpandedState])

  return (
    <Tree
      data={data}
      tree={tree}
      levelOffset={12}
      renderNode={({ node, expanded, hasChildren, elementProps }) => {
        const file = node.nodeProps?.file as TreeFile | undefined
        if (!file || hasChildren) {
          return (
            <Box {...elementProps} style={{ ...elementProps.style, display: "flex", alignItems: "center", gap: 4, paddingBlock: 2, cursor: "pointer" }}>
              <IconChevronRight
                size={12}
                style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}
              />
              <Text size="xs" truncate>{node.label}</Text>
            </Box>
          )
        }
        const active = file.path === selected
        return (
          <Box
            {...elementProps}
            data-testid={`tree-file-${file.path}`}
            data-active={active || undefined}
            onClick={(e) => {
              elementProps.onClick(e)
              onSelect(file.path)
            }}
            title={file.path}
            style={{
              ...elementProps.style,
              display: "flex",
              alignItems: "center",
              gap: 4,
              paddingBlock: 2,
              paddingInline: 4,
              borderRadius: 4,
              cursor: "pointer",
              background: active ? "var(--mantine-color-default-hover)" : undefined,
            }}
          >
            <IconFile size={12} style={{ flexShrink: 0 }} />
            <Text size="xs" truncate style={{ flex: 1, minWidth: 0 }}>{node.label}</Text>
            <Text size="xs" ff="monospace" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
              {file.binary ? (
                <Text span inherit c="dimmed">bin</Text>
              ) : (
                <>
                  <Text span inherit c="green">{`+${file.additions}`}</Text>{" "}
                  <Text span inherit c="red">{`−${file.deletions}`}</Text>
                </>
              )}
            </Text>
          </Box>
        )
      }}
    />
  )
}
