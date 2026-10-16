import type { LinkedSection, LinkedTreeNode } from "../api/types"
import { matchLinkedItem } from "./search"

/**
 * The Linked Resources tab narrowed to the search. Pure: the panel renders
 * whatever comes back.
 *
 * - Items and group items: only matches stay; empty groups and sections go.
 * - The hierarchy: a node stays if it matches or a loaded descendant does,
 *   so each match keeps the path to it, expanded. A match keeps none of its
 *   non-matching children.
 * - Children the server never sent (fetched lazily on expand) can't be
 *   searched: their nodes lose the chevron while searching, and `unsearched`
 *   says some branches were skipped.
 * - A section that failed to load keeps its error.
 *
 * `count` is the number of matching items, or null with no terms.
 */
export function filterLinkedSections(
  sections: LinkedSection[],
  terms: string[],
): { sections: LinkedSection[]; count: number | null; unsearched: boolean } {
  if (terms.length === 0) return { sections, count: null, unsearched: false }
  let count = 0
  let unsearched = false
  const hits = <T extends Parameters<typeof matchLinkedItem>[0]>(xs?: T[]) =>
    xs?.filter((x) => matchLinkedItem(x, terms) !== null)

  const pruneTree = (nodes: LinkedTreeNode[]): LinkedTreeNode[] =>
    nodes.flatMap((n) => {
      if (!n.children && n.has_children !== false) unsearched = true
      const kids = pruneTree(n.children ?? [])
      const self = matchLinkedItem(n, terms) !== null
      if (!self && kids.length === 0) return []
      if (self) count++
      return [{ ...n, children: kids, has_children: kids.length > 0, expanded: kids.length > 0 }]
    })

  const out: LinkedSection[] = []
  for (const s of sections) {
    const items = hits(s.items)
    const groups = s.groups
      ?.map((g) => ({ label: g.label, items: hits(g.items)! }))
      .filter((g) => g.items.length > 0)
    const tree = s.tree && pruneTree(s.tree)
    count += (items?.length ?? 0) + (groups?.reduce((n, g) => n + g.items.length, 0) ?? 0)
    const kept: LinkedSection = { ...s, items, groups, tree }
    if (!s.error && !items?.length && !groups?.length && !tree?.length) continue
    out.push(kept)
  }
  return { sections: out, count, unsearched }
}
