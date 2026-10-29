import { useEffect } from "react"
import { postToMac } from "../lib/macBridge"
import { unreadBadge } from "../lib/unreadBadge"
import { useWorktrees } from "./useWorktrees"

/** Tells the macOS app the app-wide unread state, on mount and on change. */
export function useMacUnreadBridge(): void {
  const { unread, count } = unreadBadge(useWorktrees().data)
  useEffect(() => {
    postToMac({ type: "unread", unread, count })
  }, [unread, count])
}
