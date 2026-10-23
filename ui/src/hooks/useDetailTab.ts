import { useEffect, useState } from "react"
import { useCmux } from "../api/cmux"
import { useFollowCmux } from "./useFollowCmux"

export type DetailTab = "notes" | "env" | "code" | "cmux"

export function isDetailTab(v: string | null): v is DetailTab {
  return v === "notes" || v === "env" || v === "code" || v === "cmux"
}

/**
 * The tab a worktree's card opens on. Not remembered across worktrees: a tab
 * chosen for one worktree says nothing about the next. While following cmux
 * the page is the terminal's companion, so it opens on cmux; landing in the
 * diff drill-down opens on Code, the tab that drill-down belongs to.
 */
function initialTab(following: boolean, inDiff: boolean): DetailTab {
  if (inDiff) return "code"
  return following ? "cmux" : "notes"
}

/**
 * The worktree detail page's details-card tab. Owned by the page rather than
 * the card because the tab decides where the card goes: Notes sits in the
 * resource column, the other tabs span the page under the header. The page
 * isn't remounted between worktrees, so the selection is held per path and
 * starts over (see initialTab) when the path changes.
 */
export function useDetailTab(path: string, inDiff: boolean): { tab: DetailTab; select: (next: DetailTab) => void } {
  const [following] = useFollowCmux()
  const [state, setState] = useState(() => ({ path, tab: initialTab(following, inDiff) }))
  // Adjusted during render rather than in an effect, so a new worktree's
  // first paint is already on its own tab.
  const current = state.path === path ? state : { path, tab: initialTab(following, inDiff) }
  if (current !== state) setState(current)
  const tab = current.tab
  const cmuxQuery = useCmux()
  const hasCmux = cmuxQuery.data?.available === true

  // The cmux tab only exists inside cmux; if it is selected and goes away,
  // fall back to Notes rather than showing no panel.
  const activeTab = tab === "cmux" && !hasCmux ? "notes" : tab

  // The fallback above is a per-render display computation, not a stored
  // selection: without this, `tab` itself would still say "cmux", so the
  // moment cmux reappears (a transient blip, a 5s poll) the card would jump
  // straight back to it instead of staying on Notes.
  //
  // Only once the data has actually said the tab is gone, though: before it
  // loads, the cmux tab a following page opens on is waiting to be shown,
  // not missing.
  const absenceKnown = tab === "cmux" && cmuxQuery.data !== undefined
  useEffect(() => {
    if (activeTab !== tab && absenceKnown) setState({ path, tab: activeTab })
  }, [activeTab, tab, absenceKnown, path])

  return {
    tab: activeTab,
    select: (next) => setState({ path, tab: next }),
  }
}
