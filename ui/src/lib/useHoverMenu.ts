import { useEffect, useRef, useState } from "react"

/** What one card's handle needs to drive its menu. */
export interface HoverMenu {
  opened: boolean
  /** Pointer entered the handle. */
  onTargetEnter: () => void
  /** Pointer left the handle or the menu. */
  onLeave: () => void
  /** Pointer entered the menu: cancels a pending close. */
  onDropdownEnter: () => void
  /** Close now — Escape, a click outside. */
  close: () => void
}

/**
 * Hover-to-open menus for a list of items, at most ONE open at a time.
 *
 * Mantine's HoverCard.Group does this, but 7.x does not export it. One
 * `openId` for the whole list makes overlapping menus impossible rather than
 * merely unlikely — and adjacent cards' menus do overlap, so a lingering one
 * could sit over its neighbour's and catch a click meant for it.
 *
 * - Opening waits `openDelay`, so sweeping past several items flashes none.
 * - With a menu already open, hovering another item switches at once.
 * - Leaving waits `closeDelay` before closing: the grace period for crossing
 *   the gap between an item and its menu, which belongs to neither.
 * - `disabled` closes everything and ignores the pointer (e.g. mid-drag).
 */
export function useHoverMenu({
  openDelay,
  closeDelay,
  disabled,
}: {
  openDelay: number
  closeDelay: number
  disabled: boolean
}): (id: string) => HoverMenu {
  const [openId, setOpenId] = useState<string | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clearTimers = () => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
  }

  useEffect(() => clearTimers, [])
  useEffect(() => {
    if (disabled) {
      clearTimers()
      setOpenId(null)
    }
  }, [disabled])

  return (id) => ({
    opened: !disabled && openId === id,
    onTargetEnter: () => {
      if (disabled) return
      clearTimers()
      if (openId !== null) setOpenId(id)
      else openTimer.current = setTimeout(() => setOpenId(id), openDelay)
    },
    onLeave: () => {
      clearTimers()
      closeTimer.current = setTimeout(() => setOpenId((cur) => (cur === id ? null : cur)), closeDelay)
    },
    onDropdownEnter: () => clearTimeout(closeTimer.current),
    close: () => {
      clearTimers()
      setOpenId((cur) => (cur === id ? null : cur))
    },
  })
}
