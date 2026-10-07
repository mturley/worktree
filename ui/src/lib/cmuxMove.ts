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
 * a tab ref, a pane ref, or a pane's collapsed-top-group id `${pane.ref}:top`)
 * into the server's move request, following dnd-kit sortable's own semantics
 * so the result matches what the user saw: within a pane, dragging down
 * lands after the tab dropped on and dragging up lands before it (arrayMove);
 * in another pane it takes that tab's slot (before it); on a pane's empty
 * space it goes to the end. Null when the drop changes nothing.
 *
 * `firstVisibleRef` is the target pane's first VISIBLE tab (over the "Show N
 * more tabs" link, cmux's order still starts above it) — the caller resolves
 * it (PaneDiagram, via windowTabs) because this function only sees the raw
 * tab list, not which ones the collapsed groups are hiding.
 */
export function dropTarget(panes: CmuxPane[], activeRef: string, overId: string, firstVisibleRef?: string): CmuxMove | null {
  const from = findTab(panes, activeRef)
  if (!from) return null
  const dragged = asRef(from.tab)
  if (overId.endsWith(":top")) {
    if (!firstVisibleRef || firstVisibleRef === activeRef) return null
    const paneRef = overId.slice(0, -":top".length)
    const pane = panes.find((p) => p.ref === paneRef)
    const anchor = findTab(panes, firstVisibleRef)
    if (!pane || !anchor) return null
    return { ...dragged, pane: pane.ref, anchor: { ...asRef(anchor.tab), position: "before" } }
  }
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
 * The workspace as it will look once the server's restore (see
 * cmux-tab-followup brief) has put the user's prior selection and pane focus
 * back — NOT cmux's own transient jump, which selects the moved tab and
 * focuses its new pane regardless of `--focus`. So: the moved tab lands in
 * its new slot unselected, the target pane keeps whichever tab was already
 * selected there, and neither pane's `focused` flag changes — UNLESS the
 * target pane had no selected tab of its own (it was empty, or otherwise had
 * nothing selected), in which case there's nothing for the server to restore
 * there and cmux's own selection of the moved tab stands, so it lands
 * selected. The one exception to the general "lands unselected" rule is a
 * same-pane reorder, where "the target pane's selection" IS the moved tab's
 * own prior selected state, since source and target are the same pane —
 * nothing elsewhere in it changes selection, so the moved tab simply carries
 * its `selected` flag over. If the moved tab was its SOURCE pane's selected
 * tab (and it left that pane), a neighbour stands in until the refetch says
 * what cmux actually picked. A pane the move emptied is removed with its
 * split collapsed (cmux closes it).
 */
export function applyMove(ws: CmuxTreeWorkspace, move: CmuxMove): CmuxTreeWorkspace {
  if (!ws.panes || !ws.layout) return ws
  const from = findTab(ws.panes, move.surface)
  if (!from) return ws
  const samePane = move.pane === from.pane.ref

  let panes = ws.panes.map((p) => {
    const tabs = p.tabs.filter((t) => t.ref !== move.surface)
    if (p.ref === from.pane.ref && !samePane && from.tab.selected && tabs.length > 0) {
      const i = Math.min(from.index, tabs.length - 1)
      return { ...p, tabs: tabs.map((t, j) => ({ ...t, selected: j === i })) }
    }
    return { ...p, tabs }
  })
  panes = panes.map((p) => {
    if (p.ref !== move.pane) return p
    const hadSelection = p.tabs.some((t) => t.selected)
    const moved: CmuxTab = { ...from.tab, selected: samePane ? from.tab.selected : !hadSelection }
    const tabs = p.tabs.slice()
    let at = tabs.length
    if (move.anchor) {
      const i = tabs.findIndex((t) => t.ref === move.anchor!.surface)
      if (i >= 0) at = move.anchor.position === "before" ? i : i + 1
    }
    tabs.splice(at, 0, moved)
    return { ...p, tabs }
  })

  let layout: CmuxLayout = ws.layout
  const source = panes.find((p) => p.ref === from.pane.ref)
  if (source && source.tabs.length === 0 && source.ref !== move.pane) {
    panes = panes.filter((p) => p.ref !== source.ref)
    layout = removePane(layout, source.ref) ?? layout
  }
  return { ...ws, layout, panes }
}

/**
 * The workspace as it will look once a close has gone through, for the
 * optimistic update (see cmux-tab-followup brief — close is now optimistic
 * like move): the tab removed; if it was its pane's selected tab, a
 * neighbour (same index, else the previous one) stands in until the refetch
 * says what cmux actually picked; a pane the close emptied is removed with
 * its split collapsed. Unknown surface: the workspace is returned unchanged.
 */
export function applyClose(ws: CmuxTreeWorkspace, surface: string): CmuxTreeWorkspace {
  if (!ws.panes || !ws.layout) return ws
  const from = findTab(ws.panes, surface)
  if (!from) return ws

  let panes = ws.panes.map((p) => {
    if (p.ref !== from.pane.ref) return p
    const tabs = p.tabs.filter((t) => t.ref !== surface)
    if (from.tab.selected && tabs.length > 0) {
      const i = Math.min(from.index, tabs.length - 1)
      return { ...p, tabs: tabs.map((t, j) => ({ ...t, selected: j === i })) }
    }
    return { ...p, tabs }
  })

  let layout: CmuxLayout = ws.layout
  const pane = panes.find((p) => p.ref === from.pane.ref)
  if (pane && pane.tabs.length === 0) {
    panes = panes.filter((p) => p.ref !== pane.ref)
    layout = removePane(layout, pane.ref) ?? layout
  }
  return { ...ws, layout, panes }
}
