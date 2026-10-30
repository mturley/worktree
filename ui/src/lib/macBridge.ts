export type MacMessage =
  | { type: "unread"; unread: boolean; count: number }
  | { type: "open"; url: string }
  | { type: "ready" }
  | { type: "login" }
  | { type: "unreachable" }
  // The width the page needs for now, or null when it needs nothing more
  // than the user's own (see useMacTaskModalWidth).
  | { type: "minWidth"; width: number | null }

interface MacHandler {
  postMessage: (m: unknown) => void
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { worktree?: MacHandler } }
  }
}

function handler(): MacHandler | undefined {
  const h = window.webkit?.messageHandlers?.worktree
  return h && typeof h.postMessage === "function" ? h : undefined
}

/** Whether the page is hosted by the macOS menu bar app. */
export function hasMacBridge(): boolean {
  return handler() !== undefined
}

/** Tells the macOS app something. A no-op in a browser; never throws. */
export function postToMac(m: MacMessage): void {
  try {
    handler()?.postMessage(m)
  } catch {
    // The host going away mid-call is not the page's problem.
  }
}
