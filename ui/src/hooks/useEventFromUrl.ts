import { useEffect, useRef } from "react"
import type { TimelineEvent } from "../api/types"
import { api } from "../api/client"

/**
 * Hands over the event a link names in `?event=<id>`, once, at mount, for the
 * page to open its details. Unlike openEvent's history state, this works
 * arriving from outside this browser (the mini view's "Open in full UI").
 *
 * The param is dropped straight away, so a reload does not reopen it. An event
 * that is gone leaves the page as it is. Not cancelled on unmount: StrictMode's
 * second run finds no param, and the first run's fetch has to deliver.
 */
export function useEventFromUrl(onEvent: (e: TimelineEvent) => void, enabled = true): void {
  const latest = useRef(onEvent)
  latest.current = onEvent
  useEffect(() => {
    if (!enabled) return
    const params = new URLSearchParams(window.location.search)
    const id = params.get("event")
    if (!id) return
    // By hand, not params.toString(), which would re-encode the rest.
    const rest = window.location.search
      .slice(1).split("&").filter((p) => !p.startsWith("event=")).join("&")
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`)
    api.event(id).then((e) => latest.current(e), () => {})
  }, [enabled])
}
