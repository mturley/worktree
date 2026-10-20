import { useEffect, useRef, type RefObject } from "react"
import { isEditable, isHidden, overlayOpen } from "../lib/keyTargets"

/**
 * Presses a button from the keyboard: `key` (one letter, either case) calls
 * `onPress` while the button is enabled and on screen. Returns the ref to put
 * on the button, which is how "on screen" is known.
 *
 * Several buttons can share a key — R is every mark-read button — and only
 * the visible one answers: one in a hidden tab panel or behind a closed
 * collapse stays quiet. With a modal or menu open, only a button inside a
 * dialog answers, so R in the Mark all read preview confirms it rather than
 * reaching through to the page behind.
 *
 * Not while typing, nor with a modifier held (Cmd+R reloads).
 */
export function useButtonHotkey<T extends HTMLElement = HTMLButtonElement>(
  key: string,
  onPress: () => void,
  enabled: boolean,
): RefObject<T | null> {
  const ref = useRef<T>(null)
  const press = useRef(onPress)
  press.current = onPress

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key.toLowerCase() !== key.toLowerCase()) return
      const el = ref.current
      if (!el || !el.isConnected || isHidden(el)) return
      if (isEditable(document.activeElement)) return
      if (overlayOpen() && !el.closest('[role="dialog"]')) return
      e.preventDefault()
      press.current()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [key, enabled])

  return ref
}
