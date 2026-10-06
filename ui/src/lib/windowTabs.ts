/**
 * Which of a pane's tabs the diagram lists, in cmux's order, always including
 * the selected one.
 *
 * The list starts at the top whenever the selected tab is among the first
 * `visible`; only when it is further down does the window move, centring on
 * it (clamped to the end). That keeps the pane stable while the selection
 * moves around near the top. Whatever falls outside becomes the "before" and
 * "after" groups, which the diagram collapses into "Show N more tabs".
 */
export function windowTabs<T extends { selected: boolean }>(
  tabs: T[],
  visible: number,
): { before: T[]; shown: T[]; after: T[] } {
  if (tabs.length <= visible) return { before: [], shown: tabs, after: [] }
  const sel = tabs.findIndex((t) => t.selected)
  let start = 0
  if (sel >= visible) start = Math.min(sel - Math.floor((visible - 1) / 2), tabs.length - visible)
  return {
    before: tabs.slice(0, start),
    shown: tabs.slice(start, start + visible),
    after: tabs.slice(start + visible),
  }
}
