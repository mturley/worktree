import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { getDefaultZIndex } from "@mantine/core"

export interface Layer {
  /** How many modals this one is stacked over: 0 for one opened over no other. */
  depth: number
  /** Registers an open child modal; the returned function unregisters it. */
  register(): () => void
}

const LayerCtx = createContext<Layer | null>(null)

export interface ModalLayer {
  /**
   * False while a child modal is open over this one. Pass it as the Modal's
   * closeOnEscape: every open Mantine Modal closes on Escape from its own
   * capture-phase window listener, so without this one Esc would close every
   * modal in the stack at once instead of only the top one.
   */
  topmost: boolean
  /**
   * The Modal's zIndex: one above the modal it opened over, so it paints on
   * top whatever the order of their portals. Undefined (Mantine's default)
   * for a modal opened over no other.
   */
  zIndex: number | undefined
  /** Hand to ModalLayerProvider around the Modal's children. */
  layer: Layer
}

/**
 * Stacks Mantine modals that open over one another (the task modal, event
 * details opened from its Activity tab, a confirm over either), so only the
 * top one takes Escape and it paints above the rest.
 *
 * A modal calls this with whether it is open, passes `topmost` and `zIndex`
 * to its Modal, and renders its children inside a ModalLayerProvider given
 * `layer`. Opened inside another layer's provider, it tells that layer while
 * it is open; opened anywhere else it is a bottom layer, and nothing about
 * it changes.
 */
export function useModalLayer(opened: boolean): ModalLayer {
  const parent = useContext(LayerCtx)
  const [children, setChildren] = useState(0)

  useEffect(() => {
    if (!opened || !parent) return
    return parent.register()
  }, [opened, parent])

  const register = useCallback(() => {
    setChildren((n) => n + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      setChildren((n) => n - 1)
    }
  }, [])

  const depth = parent ? parent.depth + 1 : 0
  const layer = useMemo<Layer>(() => ({ depth, register }), [depth, register])
  return {
    topmost: children === 0,
    zIndex: parent ? getDefaultZIndex("modal") + depth : undefined,
    layer,
  }
}

/** Makes modals opened inside `children` stack over the modal `layer` belongs to. */
export function ModalLayerProvider({ layer, children }: { layer: Layer; children: ReactNode }) {
  return <LayerCtx.Provider value={layer}>{children}</LayerCtx.Provider>
}
