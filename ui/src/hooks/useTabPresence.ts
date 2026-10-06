import { useEffect } from "react"
import { useBrowserLocation } from "wouter/use-browser-location"
import { api } from "../api/client"
import { TAB_ID } from "../lib/tabId"

/**
 * Keeps the server's tab registry current: which page this tab is on and
 * whether it is visible, so a notification comes out of the best tab.
 * Browser location rather than the app Router's, because this is mounted
 * beside useSSE, outside the Router.
 */
export function useTabPresence(): void {
  const [location] = useBrowserLocation()
  useEffect(() => {
    const report = () => {
      void api
        .tabPresence({ tab: TAB_ID, route: location, visible: document.visibilityState === "visible" })
        .catch(() => {}) // unknown tab (stream not open yet): the stream URL carries the same facts
    }
    report()
    document.addEventListener("visibilitychange", report)
    window.addEventListener("focus", report)
    return () => {
      document.removeEventListener("visibilitychange", report)
      window.removeEventListener("focus", report)
    }
  }, [location])
}
