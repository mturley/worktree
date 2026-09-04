/**
 * The worktree this browser TAB was opened for.
 *
 * `worktree ui` run from inside a worktree, and the UI pane of a cmux
 * workspace, both open a detail URL carrying `?home=1` (see cmd's
 * detailPathForToplevel and webui's worktreeDetailURL). That marks the tab as
 * belonging to that worktree, so the UI can offer a way back once you wander
 * off to the home page or to some other worktree.
 *
 * sessionStorage, deliberately:
 *   - per TAB, so every cmux pane and every window you open yourself has its
 *     own answer, and one `worktree ui` cannot re-home the others;
 *   - survives reloads and client-side navigation, which a React state would
 *     not;
 *   - dies with the tab, which is exactly the lifetime of "the worktree this
 *     pane is about".
 *
 * Every access is guarded: sessionStorage throws outright in some contexts
 * (private windows with site data blocked, embedded previews), and a banner is
 * never worth taking the page down for.
 */
const KEY = "worktree.homePath"

/** The marker the server appends. Must match cmd's HomeMarkerParam. */
export const HOME_MARKER = "home"

function read(): string | null {
  try {
    return window.sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

function write(path: string): void {
  try {
    window.sessionStorage.setItem(KEY, path)
  } catch {
    // No home for this tab, so no banner. Strictly a lost convenience.
  }
}

/**
 * Reads `?home=1` off the current URL and, on a worktree detail route, records
 * that worktree as this tab's home — then strips the parameter.
 *
 * Stripping matters for two reasons. A URL copied out of the address bar must
 * not re-home whoever pastes it, and the marker must not survive into the
 * history entry, or going Back to this page would silently re-assert a home
 * the user may have replaced since.
 *
 * Call once, before the app renders. Returns the home path in effect.
 */
export function captureHomeWorktree(loc: Location = window.location): string | null {
  const url = new URL(loc.href)
  if (url.searchParams.get(HOME_MARKER) !== "1") return read()

  const match = /^\/worktree\/(.+)$/.exec(url.pathname)
  if (match) {
    try {
      write(decodeURIComponent(match[1]))
    } catch {
      // A malformed escape in the path: no home rather than a wrong one.
    }
  }

  url.searchParams.delete(HOME_MARKER)
  const clean = url.pathname + (url.search || "") + url.hash
  try {
    window.history.replaceState(window.history.state, "", clean)
  } catch {
    // Non-fatal: the marker stays in the bar but the home is already stored.
  }
  return read()
}

/** This tab's home worktree path, or null if it was not opened for one. */
export function getHomeWorktree(): string | null {
  return read()
}

/** The name shown in the banner: the worktree's own directory name. */
export function worktreeName(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] || path
}

/**
 * Whether the banner belongs on the current route.
 *
 * Everywhere except the home worktree's OWN detail page — including the
 * listing at "/" and other worktrees' detail pages, which are exactly the
 * places it is easy to lose track of where you started.
 */
export function shouldShowHomeBanner(home: string | null, pathname: string): boolean {
  if (!home) return false
  const match = /^\/worktree\/(.+)$/.exec(pathname)
  if (!match) return true
  try {
    return decodeURIComponent(match[1]) !== home
  } catch {
    return true
  }
}

/** The route this tab's home worktree lives at. */
export function homeWorktreeHref(home: string): string {
  return `/worktree/${encodeURIComponent(home)}`
}
