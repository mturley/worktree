import { hasMacBridge } from "./macBridge"

/**
 * Whether a hidden tab should close its long-lived streams (the app's
 * /api/stream and a Slack thread's /api/thread-events) and reopen them when
 * it is shown again.
 *
 * Over plain HTTP the browser speaks HTTP/1.1 and allows six connections per
 * host. Every open stream holds one for as long as it is open, so a handful
 * of background tabs (each cmux browser pane is one) can take all six, and
 * every other page load and fetch then queues in the browser indefinitely.
 *
 * HTTPS is served over HTTP/2, which multiplexes every request onto one
 * connection, so there tabs keep their streams while in the background — and
 * with them browser notifications and the blinking unread favicon, which
 * only a connected tab can deliver.
 */
export function streamsPauseWhenHidden(): boolean {
  // The macOS menu bar app's web view is hidden whenever its dropdown is
  // closed, which is most of the time, and its icon must still blink. It
  // has its own connections, not the browser's, so the six-per-host limit
  // these pauses protect is not at stake there.
  if (hasMacBridge()) return false
  return window.location.protocol === "http:"
}

export function pageHidden(): boolean {
  return document.visibilityState === "hidden"
}
