/**
 * Cross-hover: hovering one thing lights up the things elsewhere on the page
 * that a click on it would take you to (or that would take you to it).
 *
 * Four kinds of item take part. A worktree card, a resource (a home-page
 * Resources row, or a worktree page's resource card), an event row and a
 * task row. Each names itself, and whether two items answer each other
 * depends only on the pair:
 *
 *   worktree ↔ resource, event or task   the other lists that path
 *   resource ↔ event                     the same resource
 *   task     ↔ resource                  the task links that resource
 *   task     ↔ event                     the task's own event (type "task")
 *
 * A task's paths are every worktree it belongs to: the ones it links, and
 * the ones following a resource it links.
 *
 * Two items of the same kind never do: hovering one event does not light the
 * others on the same resource, and hovering a worktree card lights no other
 * card. Nor does it cascade: a task lights its resources, not their events.
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
  | {
      kind: "task"
      /** The task's id, as its events' resource_id spells it. */
      id: string
      /** The resources it links, each as crossResourceRef(type, id). */
      resources: readonly string[]
      /** Its worktrees, linked directly or following a linked resource. */
      paths: readonly string[]
    }

/** A resource's entry in a task item's `resources`. */
export function crossResourceRef(type: string, id: string): string {
  return `${type}\n${id}`
}

/** Whether `a` lights `b`, read in one direction; crossLit asks both. */
function answers(a: CrossHoverItem, b: CrossHoverItem): boolean {
  if (a.kind === "worktree") return b.kind !== "worktree" && b.paths.includes(a.path)
  if (a.kind === "task") {
    if (b.kind === "resource") return a.resources.includes(crossResourceRef(b.type, b.id))
    if (b.kind === "event") return b.type === "task" && b.id === a.id
    return false
  }
  return a.kind === "resource" && b.kind === "event" && a.type === b.type && a.id === b.id
}

export function crossLit(hovered: CrossHoverItem | null, self: CrossHoverItem): boolean {
  if (!hovered || hovered.kind === self.kind) return false
  return answers(hovered, self) || answers(self, hovered)
}

/**
 * Identity for comparing two descriptions of the same item. Rows rebuild
 * their item on every render, so "is the hovered item still me?" cannot be
 * an object comparison.
 */
export function crossHoverKey(item: CrossHoverItem): string {
  if (item.kind === "worktree") return `worktree:${item.path}`
  if (item.kind === "task") return `task:${item.id}:${item.resources.join("\t")}:${item.paths.join("\n")}`
  return `${item.kind}:${item.type}:${item.id}:${item.paths.join("\n")}`
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
