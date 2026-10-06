/**
 * This tab's identity for the notification registry: new per page load, so a
 * reload is a new tab and a duplicated tab is a different one. The server
 * uses it to send a browser notification to exactly one tab per session.
 */
function makeTabId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    // randomUUID needs a secure context; the plain-HTTP listener is
    // loopback (secure), but stay safe everywhere.
    return Math.random().toString(36).slice(2) + Date.now().toString(36)
  }
}

export const TAB_ID = makeTabId()
