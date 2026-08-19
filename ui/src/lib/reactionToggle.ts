import type { Message, Reaction } from '../api/slackApi'

/**
 * Returns a new messages array with the current user toggled in/out of the
 * reaction `name` on the message `ts`. Pure — used for optimistic UI. Only
 * existing reactions are toggled (there is no add-new-emoji flow). Adding when
 * already present, or removing when absent, is a no-op. Removing the last user
 * drops the reaction pill. Unknown ts/name leaves the input unchanged.
 */
export function applyReactionToggle(
  messages: Message[],
  ts: string,
  name: string,
  userId: string,
  add: boolean,
): Message[] {
  return messages.map((m) => {
    if (m.TS !== ts || !m.Reactions) {
      return m
    }
    let changed = false
    const next: Reaction[] = []
    for (const r of m.Reactions) {
      if (r.Name !== name) {
        next.push(r)
        continue
      }
      const ids = r.UserIDs ?? []
      const has = ids.includes(userId)
      if (add && !has) {
        next.push({ ...r, Count: r.Count + 1, UserIDs: [...ids, userId] })
        changed = true
      } else if (!add && has) {
        const remaining = ids.filter((id) => id !== userId)
        changed = true
        if (r.Count - 1 <= 0 || remaining.length === 0) {
          // drop the pill entirely
        } else {
          next.push({ ...r, Count: r.Count - 1, UserIDs: remaining })
        }
      } else {
        next.push(r) // no-op case
      }
    }
    return changed ? { ...m, Reactions: next } : m
  })
}
