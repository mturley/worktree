import { useBrowserLocation } from "wouter/use-browser-location"
import { withHomeParam } from "./homeWorktree"

/**
 * wouter's browser location, with this tab's home worktree kept in the URL.
 *
 * The home parameter is the only thing that survives a cmux pane sleeping and
 * being restored (see homeWorktree.ts), so it has to be on EVERY URL, not just
 * the one the server opened. Doing that here rather than at each navigate()
 * call means no call site can drop it and no future page has to remember it —
 * including the worktree cards, whose <a href> clicks route through this same
 * hook.
 *
 * The returned location is still a bare pathname, so route matching is
 * untouched by the extra parameter.
 */
export function useHomeLocation(): ReturnType<typeof useBrowserLocation> {
  const [location, navigate] = useBrowserLocation()
  const navigateKeepingHome: typeof navigate = (to, options) =>
    navigate(typeof to === "string" ? withHomeParam(to) : to, options)
  return [location, navigateKeepingHome]
}
