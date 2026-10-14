import { useEffect, useState } from "react"
import { useCmux } from "../api/cmux"

export type DetailTab = "notes" | "env" | "cmux"

/**
 * The details card's selected tab, remembered per browser tab so switching
 * worktrees keeps it. sessionStorage, like "Follow cmux": a choice for this
 * tab, not for every tab in the browser. Storage throws in some contexts
 * (private windows); the card then just starts on Notes.
 */
const DETAIL_TAB_KEY = "worktree.detailTab"

function readDetailTab(): DetailTab {
  try {
    const v = window.sessionStorage.getItem(DETAIL_TAB_KEY)
    if (v === "env" || v === "cmux") return v
  } catch {
    // fall through
  }
  return "notes"
}

function writeDetailTab(tab: DetailTab): void {
  try {
    window.sessionStorage.setItem(DETAIL_TAB_KEY, tab)
  } catch {
    // not remembered; the selection still applies to this card
  }
}

export function isDetailTab(v: string | null): v is DetailTab {
  return v === "notes" || v === "env" || v === "cmux"
}

/**
 * The worktree detail page's details-card tab. Owned by the page rather than
 * the card because the tab decides where the card goes: Notes sits in the
 * resource column, the other tabs span the page under the header.
 */
export function useDetailTab(): { tab: DetailTab; select: (next: DetailTab) => void } {
  const [tab, setTab] = useState<DetailTab>(readDetailTab)
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
  // loads, a remembered tab (see readDetailTab) is waiting to be shown, not
  // missing. And never written back to sessionStorage — this tab being
  // gone for now says nothing about the next card.
  const absenceKnown = tab === "cmux" && cmuxQuery.data !== undefined
  useEffect(() => {
    if (activeTab !== tab && absenceKnown) setTab(activeTab)
  }, [activeTab, tab, absenceKnown])

  return {
    tab: activeTab,
    select: (next) => {
      setTab(next)
      writeDetailTab(next)
    },
  }
}
