import { useCallback, useMemo } from "react"
import { useBrowserLocation } from "wouter/use-browser-location"
import { hasMacBridge, postToMac } from "./macBridge"

/** The route the macOS menu bar app loads. */
export const MINI_PATH = "/mini"

export function isMiniRoute(pathname: string = window.location.pathname): boolean {
  return pathname === MINI_PATH
}

/**
 * Opens a URL outside the mini view: through the macOS app when it hosts the
 * page (it hands it to the default browser), else in a new browser tab.
 */
export function openExternal(url: string): void {
  const abs = new URL(url, window.location.origin).href
  if (hasMacBridge()) {
    postToMac({ type: "open", url: abs })
    return
  }
  window.open(abs, "_blank", "noopener")
}

/**
 * wouter's browser location for /mini: navigation that stays on /mini
 * (query changes, such as the task modal's ?task=) happens in place; anything
 * else leaves the mini view for the full UI, opened externally.
 */
export function useMiniLocation(): ReturnType<typeof useBrowserLocation> {
  const [location, navigate] = useBrowserLocation()
  // Stable identity: consumers (the task modal) list navigate in hook deps.
  const navigateMini: typeof navigate = useCallback((to, options) => {
    const target = new URL(typeof to === "string" ? to : String(to), window.location.origin)
    if (target.pathname === MINI_PATH) {
      navigate(to, options)
      return
    }
    openExternal(target.href)
  }, [navigate])
  return useMemo(() => [location, navigateMini], [location, navigateMini])
}
