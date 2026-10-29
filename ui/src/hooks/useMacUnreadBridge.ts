import { useEffect } from "react"
import { postToMac } from "../lib/macBridge"
import { unreadBadge } from "../lib/unreadBadge"
import { useWorktrees } from "./useWorktrees"

/**
 * Tells the macOS app the app-wide unread state, once the worktree list has
 * loaded and on every change after. Nothing is posted before then: "not
 * known yet" is not "nothing unread", and saying so would show the plain icon.
 */
export function useMacUnreadBridge(): void {
  const data = useWorktrees().data
  const known = Array.isArray(data)
  const { unread, count } = unreadBadge(data)
  useEffect(() => {
    if (known) postToMac({ type: "unread", unread, count })
  }, [known, unread, count])
}
