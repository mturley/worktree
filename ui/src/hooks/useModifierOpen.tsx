import type { MouseEvent, ReactNode } from "react"
import { useCmux } from "../api/cmux"
import { useCmuxSelect } from "../components/CmuxSwitchButton"
import { isMiniRoute, openExternal } from "../lib/miniMode"

export const CMD_CLICK_HINT = "Cmd+click to open in full UI"
export const SHIFT_CLICK_HINT = "Shift+click to switch cmux"

/**
 * The modifier clicks an event or task row answers besides its plain click:
 *
 * - Cmd+click, in the mini view only, opens it in the full UI in the default
 *   browser — what its modal's "Open in full UI" button does, without the
 *   modal.
 * - Shift+click switches cmux to the first workspace matching one of its
 *   worktrees (in `paths` order), when cmux is available and one matches.
 *
 * `handle` returns true when it took the click, so the row skips its own.
 * `hints` names the modifiers that apply, for the row's tooltip.
 * `onMouseDown` keeps a Shift+click from extending a text selection.
 */
export function useModifierOpen(paths: readonly string[], fullUiHref: () => string) {
  const cmux = useCmux()
  const select = useCmuxSelect()
  const mini = isMiniRoute()
  const matches = cmux.data?.available ? cmux.data.matches : undefined
  let wsRef: string | undefined
  for (const p of paths) {
    wsRef = matches?.[p]?.[0]?.ref
    if (wsRef) break
  }
  const hints: string[] = []
  if (mini) hints.push(CMD_CLICK_HINT)
  if (wsRef) hints.push(SHIFT_CLICK_HINT)

  const handle = (e: MouseEvent): boolean => {
    if (mini && e.metaKey) {
      e.preventDefault()
      openExternal(fullUiHref())
      return true
    }
    if (wsRef && e.shiftKey) {
      e.preventDefault()
      select.mutate(wsRef)
      return true
    }
    return false
  }
  const onMouseDown = (e: MouseEvent) => {
    if (wsRef && e.shiftKey) e.preventDefault()
  }
  return { hints, handle, onMouseDown }
}

/** A tooltip's main line, then its modifier hints beneath it, smaller. */
export function TooltipWithHints({ main, hints }: { main: ReactNode; hints: readonly string[] }) {
  return (
    <>
      <div>{main}</div>
      {hints.map((h) => (
        <div key={h} style={{ fontSize: "0.85em", opacity: 0.75 }}>{h}</div>
      ))}
    </>
  )
}
