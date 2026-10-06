import type { CmuxLayout, CmuxMove, CmuxPane, CmuxTab, CmuxTreeWorkspace } from "../api/types"

function findTab(panes: CmuxPane[], ref: string): { pane: CmuxPane; tab: CmuxTab; index: number } | null {
  for (const pane of panes) {
    const index = pane.tabs.findIndex((t) => t.ref === ref)
    if (index >= 0) return { pane, tab: pane.tabs[index], index }
  }
  return null
}

const asRef = (t: CmuxTab) => ({ surface: t.ref, type: t.type, title: t.title })

/**
 * Turns a dnd-kit drop (the dragged tab's ref, and the id it was dropped on:
 * a tab ref or a pane ref) into the server's move request, following
 * dnd-kit sortable's own semantics so the result matches what the user saw:
 * within a pane, dragging down lands after the tab dropped on and dragging up
 * lands before it (arrayMove); in another pane it takes that tab's slot
 * (before it); on a pane's empty space it goes to the end. Null when the drop
 * changes nothing.
 */
export function dropTarget(panes: CmuxPane[], activeRef: string, overId: string): CmuxMove | null {
  const from = findTab(panes, activeRef)
  if (!from) return null
  const dragged = asRef(from.tab)
  if (overId.startsWith("pane:")) {
    const pane = panes.find((p) => p.ref === overId)
    if (!pane) return null
    if (pane.ref === from.pane.ref && from.index === pane.tabs.length - 1) return null
    return { ...dragged, pane: pane.ref }
  }
  if (overId === activeRef) return null
  const over = findTab(panes, overId)
  if (!over) return null
  const position = over.pane.ref !== from.pane.ref || from.index > over.index ? "before" : "after"
  return { ...dragged, pane: over.pane.ref, anchor: { ...asRef(over.tab), position } }
}

/** The layout without `ref`, a split left with one child collapsing into it. */
export function removePane(node: CmuxLayout, ref: string): CmuxLayout | null {
  if (node.pane !== undefined) return node.pane === ref ? null : node
  if (!node.children) return node
  const [a, b] = node.children
  const na = removePane(a, ref)
  const nb = removePane(b, ref)
  if (!na) return nb
  if (!nb) return na
  return { ...node, children: [na, nb] }
}

/**
 * The workspace as cmux will show it after `move`, for the optimistic update:
 * the tab moved, selected in its new pane, that pane focused, and a pane the
 * move emptied removed with its split collapsed (cmux closes it). Which tab
 * cmux selects in the source pane is not knowable here; a neighbour stands in
 * until the refetch says.
 */
export function applyMove(ws: CmuxTreeWorkspace, move: CmuxMove): CmuxTreeWorkspace {
  if (!ws.panes || !ws.layout) return ws
  const from = findTab(ws.panes, move.surface)
  if (!from) return ws
  const moved: CmuxTab = { ...from.tab, selected: true }

  let panes = ws.panes.map((p) => {
    const tabs = p.tabs.filter((t) => t.ref !== move.surface)
    if (p.ref === from.pane.ref && p.ref !== move.pane && from.tab.selected && tabs.length > 0) {
      const i = Math.min(from.index, tabs.length - 1)
      return { ...p, focused: false, tabs: tabs.map((t, j) => ({ ...t, selected: j === i })) }
    }
    return { ...p, focused: false, tabs }
  })
  panes = panes.map((p) => {
    if (p.ref !== move.pane) return p
    const tabs = p.tabs.map((t) => ({ ...t, selected: false }))
    let at = tabs.length
    if (move.anchor) {
      const i = tabs.findIndex((t) => t.ref === move.anchor!.surface)
      if (i >= 0) at = move.anchor.position === "before" ? i : i + 1
    }
    tabs.splice(at, 0, moved)
    return { ...p, focused: true, tabs }
  })

  let layout: CmuxLayout = ws.layout
  const source = panes.find((p) => p.ref === from.pane.ref)
  if (source && source.tabs.length === 0 && source.ref !== move.pane) {
    panes = panes.filter((p) => p.ref !== source.ref)
    layout = removePane(layout, source.ref) ?? layout
  }
  return { ...ws, layout, panes }
}
