import type { CSSProperties } from "react"
import type { CmuxLayout } from "../api/types"

const WIDTH = 120
const HEIGHT = 72
const GAP = 2

/**
 * A thumbnail of a cmux workspace's splits with one pane filled in: the
 * switch-to-tab tooltip uses it to show where the tab is before you jump.
 * Unlike PaneDiagram it lists no tabs, so both dimensions follow cmux's
 * ratios. Outlines use currentColor, which keeps them visible on the
 * tooltip's background in either colour scheme.
 */
export function PaneMiniMap({ layout, highlight }: { layout: CmuxLayout; highlight: string }) {
  return (
    <div
      role="img"
      aria-label="Workspace pane layout"
      style={{ display: "flex", width: WIDTH, height: HEIGHT }}
    >
      <Node node={layout} grow={1} highlight={highlight} />
    </div>
  )
}

function Node({ node, grow, highlight }: { node: CmuxLayout; grow: number; highlight: string }) {
  const style: CSSProperties = { flex: `${grow} 1 0`, minWidth: 0, minHeight: 0, display: "flex" }
  if (node.pane !== undefined) {
    const on = node.pane === highlight
    return (
      <div
        data-pane={node.pane}
        data-highlighted={on || undefined}
        style={{
          ...style,
          borderRadius: 2,
          border: on ? "1px solid var(--mantine-color-blue-filled)" : "1px solid currentColor",
          background: on ? "var(--mantine-color-blue-filled)" : undefined,
          opacity: on ? 1 : 0.6,
        }}
      />
    )
  }
  const [a, b] = node.children ?? []
  const split = node.split ?? 0.5
  return (
    <div
      data-split={node.direction}
      style={{ ...style, gap: GAP, flexDirection: node.direction === "vertical" ? "column" : "row" }}
    >
      {a && <Node node={a} grow={split} highlight={highlight} />}
      {b && <Node node={b} grow={1 - split} highlight={highlight} />}
    </div>
  )
}
