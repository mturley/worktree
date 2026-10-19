import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { type CrossHoverItem, type CrossHoverStore, createCrossHoverStore, crossHoverKey, crossLit } from "../lib/crossHover"

/**
 * The page's cross-hover store (see lib/crossHover). The home page and the
 * worktree page each provide one; with no provider nothing lights up and
 * hovering does nothing, so a row rendered anywhere else (the search
 * dropdown, a test) behaves as it always did.
 */
const CrossHoverContext = createContext<CrossHoverStore | null>(null)

export function CrossHoverProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createCrossHoverStore)
  return <CrossHoverContext.Provider value={store}>{children}</CrossHoverContext.Provider>
}

const noSubscribe = () => () => {}

/**
 * Pauses cross-hover while `active` is true — see CrossHoverStore.suspend.
 */
export function useSuspendCrossHover(active: boolean) {
  const store = useContext(CrossHoverContext)
  useEffect(() => (active && store ? store.suspend() : undefined), [active, store])
}

/**
 * Keyboard focus counts as hovering, but not the focus a mouse click leaves
 * behind (or a modal hands back after one): that would keep a row's partners
 * lit after the pointer has gone. Browsers already draw that line for the
 * focus ring, so this asks the same question.
 */
function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible")
  } catch {
    return false
  }
}

/**
 * Takes part in cross-hover as `self`, or not at all when it is null (a row
 * with nowhere to go neither lights anything nor gets lit).
 *
 * Spread the result onto the element that carries the row's hover style.
 * data-cross-hover is what styles/cards.css turns into that same style.
 *
 * Mouse pointers only. A tap on a touch screen emulates a hover that never
 * ends, which would leave the tapped row's partners lit after a modal it
 * opened is closed.
 */
export function useCrossHover(self: CrossHoverItem | null) {
  const store = useContext(CrossHoverContext)
  const selfRef = useRef(self)
  selfRef.current = self
  const key = self ? crossHoverKey(self) : null

  const lit = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    () => !!store && !!selfRef.current && crossLit(store.get(), selfRef.current),
  )

  // Only clear what is still ours: leaving one row and entering the next
  // can arrive in either order, and focus can sit on one row while the
  // mouse hovers another.
  const release = useCallback(() => {
    const current = store?.get()
    if (current && key && crossHoverKey(current) === key) store?.set(null)
  }, [store, key])

  // A click that navigates or filters can unmount the hovered row without
  // a pointerleave, which would leave its partners lit.
  useEffect(() => release, [release])

  const claim = useCallback(() => {
    if (store && selfRef.current) store.set(selfRef.current)
  }, [store])
  const onPointerEnter = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "mouse") claim()
  }, [claim])
  // Focus events bubble in React, so this covers the row's own button and
  // the actions inside it alike; moving focus between them is a blur then
  // a focus, which ends lit.
  const onFocus = useCallback((e: React.FocusEvent) => {
    if (isKeyboardFocus(e.target)) claim()
  }, [claim])

  if (!store || !self) return {}
  return {
    onPointerEnter,
    onPointerLeave: release,
    onFocus,
    onBlur: release,
    "data-cross-hover": lit ? "true" : undefined,
  }
}
