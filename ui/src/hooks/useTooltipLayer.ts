import { useEffect } from "react"

/** The CSS variable the theme's Tooltip zIndex reads (see theme.ts). */
export const TOOLTIP_Z_VAR = "--tooltip-z-index"

/**
 * Tooltips for anchors in scrolling content while a pinned block is stuck
 * over it: above the content, below the pinned blocks (app z-index - 1) and
 * the page header (app z-index), so a tooltip left open while its anchor
 * scrolls under them goes under too.
 */
const UNDER_PINNED_Z = "calc(var(--mantine-z-index-app) - 2)"

/**
 * Tooltips for anchors in scrolling content while no pinned block is stuck:
 * level with the pinned blocks — portalled to the end of <body>, a tooltip
 * paints over an equal z-index earlier in the page — and still under the
 * page header. The first rows' tooltips, which open upwards over the header
 * sitting at its natural place, then show.
 */
const OVER_PINNED_Z = "calc(var(--mantine-z-index-app) - 1)"

/**
 * Whether a pinned (sticky) block is stuck: the content after it has
 * scrolled up beneath it. Not stuck, the next laid-out sibling starts at or
 * below the block's bottom; stuck, it has moved up under the block while
 * the block stayed put. Measured, not observed, so it holds whichever
 * element scrolls (a home column, the window) and whatever `top` it pins at.
 */
function isStuck(pinned: Element): boolean {
  const bottom = pinned.getBoundingClientRect().bottom
  for (let next = pinned.nextElementSibling; next; next = next.nextElementSibling) {
    const r = next.getBoundingClientRect()
    // Skips what is not laid out (a hidden tab panel, display: none).
    if (r.width === 0 && r.height === 0) continue
    return r.top < bottom - 0.5
  }
  return false
}

/**
 * Picks the z-index the next tooltip opens at, from where its anchor sits.
 *
 * Tooltips are portalled to <body>, so nothing about their anchor's place in
 * the page reaches them through CSS, and Mantine's theme can only give them a
 * static zIndex. That zIndex is this variable instead, set on <html> from
 * what the pointer or keyboard focus is on — which is the anchor of any
 * tooltip about to open. Inside an element marked
 * data-tooltip-layer="content" (and not inside a nearer "pinned" one), it
 * goes under the pinned blocks in that content area while one of them is
 * stuck (isStuck), and level with them otherwise; anywhere else — pinned
 * blocks, the header, modals and menus, which portal out of the page —
 * Mantine's usual popover value. Any scroll re-checks it, so a tooltip left
 * open changes layer as its header sticks or unsticks.
 */
export function useTooltipLayer(): void {
  useEffect(() => {
    const root = document.documentElement
    let content: Element | null = null
    const apply = () => {
      if (!content?.isConnected) {
        content = null
        root.style.removeProperty(TOOLTIP_Z_VAR)
        return
      }
      const stuck = Array.from(content.querySelectorAll("[data-tooltip-layer=pinned]")).some(isStuck)
      root.style.setProperty(TOOLTIP_Z_VAR, stuck ? UNDER_PINNED_Z : OVER_PINNED_Z)
    }
    const update = (e: Event) => {
      const t = e.target
      const layered = t instanceof Element ? t.closest("[data-tooltip-layer]") : null
      content = layered?.getAttribute("data-tooltip-layer") === "content" ? layered : null
      apply()
    }
    const onScroll = () => {
      if (content) apply()
    }
    // Capture: before the anchor's own handlers open the tooltip, and to see
    // scrolls of inner scrollers, which do not bubble.
    document.addEventListener("pointerover", update, true)
    document.addEventListener("focusin", update, true)
    window.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener("pointerover", update, true)
      document.removeEventListener("focusin", update, true)
      window.removeEventListener("scroll", onScroll, { capture: true })
      root.style.removeProperty(TOOLTIP_Z_VAR)
    }
  }, [])
}
