import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { getDefaultZIndex } from "@mantine/core"

/**
 * One modal's place in a stack. Every layer opened over a bottom layer, at
 * any depth, registers with that bottom layer's stack, in the order they
 * opened, so "which is on top" has one answer even for two modals opened
 * over the same one (event details and a confirm, both over the task modal).
 */
export interface Layer {
  /** Adds an open layer to the top of the bottom layer's stack; the returned function removes it. */
  register(token: number): () => void
  /** The open layers over the bottom layer, oldest first. */
  stack: readonly number[]
  /** This layer's token in `stack`; null for the bottom layer itself. */
  self: number | null
}

const LayerCtx = createContext<Layer | null>(null)

/** The bottom layer is on top while nothing is open over it; any other while it is the newest. */
const isTop = (l: Layer) => (l.self === null ? l.stack.length === 0 : l.stack[l.stack.length - 1] === l.self)

let nextToken = 0

export interface ModalLayer {
  /**
   * True only for the one modal on top of its stack. Pass it as the Modal's
   * closeOnEscape: every open Mantine Modal closes on Escape from its own
   * capture-phase window listener, so without this one Esc would close every
   * modal in the stack at once instead of only the top one.
   */
  topmost: boolean
  /**
   * The Modal's zIndex: above Mantine's default by its place in the stack,
   * so a modal opened later paints over one opened earlier whatever the order
   * of their portals. Undefined (Mantine's default) for a bottom layer.
   */
  zIndex: number | undefined
  /** Hand to ModalLayerProvider around the Modal's children. */
  layer: Layer
}

/**
 * Stacks Mantine modals that open over one another (the task modal, event
 * details opened from its Activity tab, Mark all read's confirm, details
 * opened from that confirm's preview), so only the top one takes Escape and
 * it paints above the rest.
 *
 * A modal calls this with whether it is open, passes `topmost` and `zIndex`
 * to its Modal, and renders its children inside a ModalLayerProvider given
 * `layer`. Opened inside another layer's provider, it joins that stack while
 * it is open, on top; opened anywhere else it is a bottom layer, and nothing
 * about it changes.
 */
export function useModalLayer(opened: boolean): ModalLayer {
  const parent = useContext(LayerCtx)
  const [token] = useState(() => ++nextToken)
  // Used only while this is a bottom layer: the layers open over it.
  const [own, setOwn] = useState<readonly number[]>([])

  const registerOwn = useCallback((t: number) => {
    setOwn((s) => [...s.filter((x) => x !== t), t])
    let done = false
    return () => {
      if (done) return
      done = true
      setOwn((s) => s.filter((x) => x !== t))
    }
  }, [])

  // The bottom layer's register is stable; `parent` itself is not (a new
  // value whenever the stack changes), so the effect keys on register alone
  // and a stack change never re-registers this layer.
  const register = parent ? parent.register : registerOwn
  const stacked = !!parent
  useEffect(() => {
    if (!opened || !stacked) return
    return register(token)
  }, [opened, stacked, register, token])

  const stack = parent ? parent.stack : own
  const self = parent ? token : null
  const layer = useMemo<Layer>(() => ({ register, stack, self }), [register, stack, self])
  // Until its registration lands, an opening layer takes the place it is about to get.
  const index = stack.indexOf(token)
  return {
    topmost: isTop(layer),
    zIndex: parent ? getDefaultZIndex("modal") + 1 + (index < 0 ? stack.length : index) : undefined,
    layer,
  }
}

/**
 * Whether the modal enclosing the caller is on top of its stack — true
 * outside any layered modal. A hotkey inside a modal gates on it, so a key
 * pressed while another modal is stacked over that one does nothing behind it.
 */
export function useLayerTopmost(): boolean {
  const l = useContext(LayerCtx)
  return l ? isTop(l) : true
}

/** Makes modals opened inside `children` stack over the modal `layer` belongs to. */
export function ModalLayerProvider({ layer, children }: { layer: Layer; children: ReactNode }) {
  return <LayerCtx.Provider value={layer}>{children}</LayerCtx.Provider>
}
