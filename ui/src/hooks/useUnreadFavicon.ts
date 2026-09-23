import { useEffect } from "react"
import { startBlink } from "../lib/blinkTicker"
import { BASE_TITLE, badgeTitle, unreadBadge } from "../lib/unreadBadge"
import { useWorktrees } from "./useWorktrees"

/** The resting icon. Must match the href in index.html, cache-buster included. */
export const BASE_FAVICON = "/favicon.svg?v=2"
/** The same tile with an unread dot on it. */
export const UNREAD_FAVICON = "/favicon-unread.svg"

function setIcon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement("link")
    link.rel = "icon"
    link.type = "image/svg+xml"
    document.head.appendChild(link)
  }
  link.href = href
}

/**
 * Flashes the favicon and badges the tab title while ANY worktree has unread
 * activity.
 *
 * Mounted once, app-wide, beside useSSE — not per page. It reads the same
 * ["worktrees"] query the pages do, which the event stream already
 * invalidates, so the tab starts flashing on the event that arrives and stops
 * on the mark-read that clears it, with no polling of its own.
 *
 * It flashes whether or not the tab is in front. That is deliberate: this
 * exists to be caught out of the corner of an eye, and a visibility check
 * would silence it on the focused tab where the unread bars are also visible
 * but the tab strip is still what someone is scanning.
 */
export function useUnreadFavicon(): void {
  const badge = unreadBadge(useWorktrees().data)
  const { unread } = badge
  const title = badgeTitle(badge)

  useEffect(() => {
    document.title = title
    return () => { document.title = BASE_TITLE }
  }, [title])

  useEffect(() => {
    // Set the icon unconditionally rather than only on the unread branch: this
    // effect owns the icon, so the read state has to be a value it writes, not
    // one it leaves behind.
    if (!unread) {
      setIcon(BASE_FAVICON)
      return
    }
    let on = true
    setIcon(UNREAD_FAVICON)
    const stop = startBlink(() => {
      on = !on
      setIcon(on ? UNREAD_FAVICON : BASE_FAVICON)
    })
    return () => {
      stop()
      setIcon(BASE_FAVICON)
    }
  }, [unread])
}
