/**
 * The worktree this browser TAB was opened for.
 *
 * `worktree ui` run from inside a worktree, and the UI pane of a cmux
 * workspace, both open a detail URL carrying `?home=<path>` (see cmd's
 * detailPathForToplevel and webui's worktreeDetailURL). That marks the tab as
 * belonging to that worktree, so the UI can offer a way back once you wander
 * off to the listing or to some other worktree.
 *
 * THE URL IS THE CARRIER, and the parameter is deliberately never stripped.
 * The first version stored the worktree in sessionStorage and cleaned the URL,
 * which reads better but does not survive a cmux pane sleeping and being
 * restored: the pane comes back with a URL and a brand new JS context, so
 * anything held only in storage is gone. The URL is the one thing that
 * crosses that gap.
 *
 * It carries the PATH, not a bare flag. A flag works only while the path is
 * still in the pathname; the moment you navigate to "/" there is nothing left
 * for it to point at.
 *
 * The consequence, accepted deliberately: a URL copied out of the address bar
 * carries the home with it and will home whoever pastes it. For a localhost
 * tool that is a fair price for surviving restore.
 *
 * sessionStorage stays on as a SECOND copy, not the source of truth. It heals
 * the case where a navigation arrives without the parameter in a tab that
 * already knows its home — the param is put back rather than the home lost.
 */
const KEY = "worktree.homePath"

/** The query parameter carrying the home worktree's path. */
export const HOME_PARAM = "home"

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(KEY)
  } catch {
    // sessionStorage throws outright in some contexts (private windows with
    // site data blocked). A missing banner is never worth a blank page.
    return null
  }
}

function store(path: string): void {
  try {
    window.sessionStorage.setItem(KEY, path)
  } catch {
    // The URL still carries it; this copy is only a convenience.
  }
}

/**
 * Resolves this tab's home from the current URL, falling back to the stored
 * copy, and makes sure the URL ends up carrying it either way.
 *
 * Call once before the app renders, and let the router keep it from there.
 */
export function captureHomeWorktree(): string | null {
  const url = new URL(window.location.href)
  const fromURL = url.searchParams.get(HOME_PARAM)

  if (fromURL) {
    store(fromURL)
    return fromURL
  }

  // No parameter, but this tab has been homed before: re-attach it rather
  // than lose the home, so the next navigation carries it onward.
  const stored = readStored()
  if (stored) {
    url.searchParams.set(HOME_PARAM, stored)
    try {
      window.history.replaceState(
        window.history.state,
        "",
        url.pathname + url.search + url.hash,
      )
    } catch {
      // Non-fatal: the banner still renders from the stored copy.
    }
  }
  return stored
}

/** This tab's home worktree path, or null if it was not opened for one. */
export function getHomeWorktree(): string | null {
  try {
    const fromURL = new URL(window.location.href).searchParams.get(HOME_PARAM)
    if (fromURL) return fromURL
  } catch {
    // Fall through to the stored copy.
  }
  return readStored()
}

/**
 * Adds the home parameter to a destination the app is navigating to.
 *
 * Applied by the router's location hook rather than at each navigate() call,
 * so no call site can forget and no future page has to remember. wouter routes
 * on pathname alone, so the extra parameter is invisible to matching.
 */
export function withHomeParam(to: string): string {
  const home = getHomeWorktree()
  if (!home) return to
  // A relative URL needs a base to parse; the origin is discarded below.
  const url = new URL(to, window.location.origin)
  if (url.searchParams.get(HOME_PARAM) === home) return to
  url.searchParams.set(HOME_PARAM, home)
  return url.pathname + url.search + url.hash
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
