import type { MouseEvent, ReactNode } from "react"
import { useCmux } from "../api/cmux"
import type { CmuxWorkspace } from "../api/types"
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
 *   Not in the full UI when that workspace is already cmux's current one:
 *   the full UI is most likely being viewed inside it, so there is nothing
 *   to switch to. The mini view keeps it, since switching also brings cmux
 *   to the front.
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
  let ws: CmuxWorkspace | undefined
  for (const p of paths) {
    ws = matches?.[p]?.[0]
    if (ws) break
  }
  const wsRef = ws && (mini || !ws.selected) ? ws.ref : undefined
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
