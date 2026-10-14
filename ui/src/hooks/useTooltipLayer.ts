import { useEffect } from "react"

/** The CSS variable the theme's Tooltip zIndex reads (see theme.ts). */
export const TOOLTIP_Z_VAR = "--tooltip-z-index"

/**
 * Tooltips for anchors in scrolling content: above the content, below the
 * pinned blocks (app z-index - 1) and the page header (app z-index), so a
 * tooltip left open while its anchor scrolls under them goes under too.
 */
const CONTENT_Z = "calc(var(--mantine-z-index-app) - 2)"

/**
 * Picks the z-index the next tooltip opens at, from where its anchor sits.
 *
 * Tooltips are portalled to <body>, so nothing about their anchor's place in
 * the page reaches them through CSS, and Mantine's theme can only give them a
 * static zIndex. That zIndex is this variable instead, set on <html> from
 * what the pointer or keyboard focus is on — which is the anchor of any
 * tooltip about to open. Inside an element marked
 * data-tooltip-layer="content" (and not inside a nearer "pinned" one), it is
 * the low content value; anywhere else — pinned blocks, the header, modals
 * and menus, which portal out of the page — Mantine's usual popover value.
 */
export function useTooltipLayer(): void {
  useEffect(() => {
    const root = document.documentElement
    const update = (e: Event) => {
      const t = e.target
      const layer = t instanceof Element ? t.closest("[data-tooltip-layer]")?.getAttribute("data-tooltip-layer") : null
      if (layer === "content") root.style.setProperty(TOOLTIP_Z_VAR, CONTENT_Z)
      else root.style.removeProperty(TOOLTIP_Z_VAR)
    }
    // Capture: before the anchor's own handlers open the tooltip.
    document.addEventListener("pointerover", update, true)
    document.addEventListener("focusin", update, true)
    return () => {
      document.removeEventListener("pointerover", update, true)
      document.removeEventListener("focusin", update, true)
      root.style.removeProperty(TOOLTIP_Z_VAR)
    }
  }, [])
}
