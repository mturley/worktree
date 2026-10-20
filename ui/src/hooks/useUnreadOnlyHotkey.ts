import { useEffect } from "react"
import { isEditable, overlayOpen } from "../lib/keyTargets"

/**
 * U flips Unreads only. Page-level rather than in the toggle, because the
 * worktree page's toggle lives in its resource list, which a narrow
 * drilldown unmounts — the key should work wherever the value applies.
 *
 * Not while typing, nor while a modal or menu is open: those own the
 * keyboard, and a U there must not narrow the page behind them.
 */
export function useUnreadOnlyHotkey(value: boolean, onChange: (v: boolean) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== "u" && e.key !== "U") return
      if (isEditable(document.activeElement) || overlayOpen()) return
      e.preventDefault()
      onChange(!value)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [value, onChange])
}
