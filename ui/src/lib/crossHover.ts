/**
 * Cross-hover: hovering one thing lights up the things elsewhere on the page
 * that a click on it would take you to (or that would take you to it).
 *
 * Three kinds of item take part. A worktree card, a resource (a home-page
 * Resources row, or a worktree page's resource card) and an event row. Each
 * names itself, and whether two items answer each other depends only on the
 * pair:
 *
 *   worktree ↔ resource or event   the resource or event lists that path
 *   resource ↔ event               the same resource
 *
 * Two items of the same kind never do: hovering one event does not light the
 * others on the same resource, and hovering a worktree card lights no other
 * card.
 */
export type CrossHoverItem =
  | { kind: "worktree"; path: string }
  | {
      kind: "resource" | "event"
      type: string
      id: string
      /** The worktrees that follow this resource (or this event's resource). */
      paths: readonly string[]
    }

export function crossLit(hovered: CrossHoverItem | null, self: CrossHoverItem): boolean {
  if (!hovered || hovered.kind === self.kind) return false
  if (hovered.kind === "worktree") return self.kind !== "worktree" && self.paths.includes(hovered.path)
  if (self.kind === "worktree") return hovered.paths.includes(self.path)
  return hovered.type === self.type && hovered.id === self.id
}

/**
 * Identity for comparing two descriptions of the same item. Rows rebuild
 * their item on every render, so "is the hovered item still me?" cannot be
 * an object comparison.
 */
export function crossHoverKey(item: CrossHoverItem): string {
  return item.kind === "worktree"
    ? `worktree:${item.path}`
    : `${item.kind}:${item.type}:${item.id}:${item.paths.join("\n")}`
}

/**
 * What is hovered right now, outside React state. Every row on the page
 * reads it, and a context value would re-render all of them on each
 * pointer move; a store lets each row subscribe to its own lit/unlit answer
 * and re-render only when that flips.
 */
export interface CrossHoverStore {
  get: () => CrossHoverItem | null
  set: (item: CrossHoverItem | null) => void
  subscribe: (listener: () => void) => () => void
  /**
   * Pauses cross-hover until the returned function is called: clears what
   * is lit and ignores new hovers meanwhile. A drag sweeps the pointer
   * across cards it means nothing about.
   */
  suspend: () => () => void
}

export function createCrossHoverStore(): CrossHoverStore {
  let current: CrossHoverItem | null = null
  // A count, not a flag, so overlapping pauses cannot end each other early.
  let suspended = 0
  const listeners = new Set<() => void>()
  const set = (item: CrossHoverItem | null) => {
    if (item && suspended) return
    if (item === current) return
    current = item
    for (const l of listeners) l()
  }
  return {
    get: () => current,
    set,
    suspend: () => {
      suspended++
      set(null)
      let resumed = false
      return () => {
        if (!resumed) suspended--
        resumed = true
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
