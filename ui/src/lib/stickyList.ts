import type { CSSProperties } from "react"

/**
 * The gap between the page header and the sticky resource list.
 *
 * The shell's `Stack gap="md"` puts a full `md` below the header, and Mantine's
 * `Grid` then pulls its inner row back up by half a gutter
 * (`--grid-margin: calc(var(--grid-gutter) / -2)`), so the list column's
 * border box comes to rest half a gutter below the header rather than flush
 * against it. Both values below are expressed against that same offset.
 *
 * Getting this wrong is not a crash, it is a creep: sticking at the bare
 * header height leaves the difference as scroll travel, so the list slides
 * upwards for the first few pixels of page scroll and swallows the whitespace
 * above its first element before coming to rest.
 */
const OFFSET = (headerHeight: number) => `(${headerHeight}px + var(--mantine-spacing-md) / 2)`

/**
 * Positions the resource list column beside the flowing detail column.
 *
 * `alignSelf` is load-bearing: a Grid column stretches to the row's height by
 * default, and an element as tall as its scroll container can never stick.
 * `maxHeight` caps it for a list longer than the screen, which then scrolls
 * in STICKY_LIST_SCROLLER.
 */
export function stickyListStyle(headerHeight: number): CSSProperties {
  const offset = OFFSET(headerHeight)
  return {
    position: "sticky",
    top: `calc${offset}`,
    // Above the flowing column beside it: card internals carry small
    // z-indexes of their own (Mantine's SegmentedControl uses 2) and would
    // otherwise paint over this list's dragged card and tooltips.
    zIndex: 3,
    alignSelf: "flex-start",
    // Less the half gutter by which the Grid row stops short of the page's
    // bottom (the shell's md padding, less the row's own -md/2 margin). A
    // column as tall as the full remaining viewport overran the row at the
    // very bottom of the page, and sticky then shoved it up by that much.
    maxHeight: `calc(100dvh - ${offset} - var(--mantine-spacing-md) / 2)`,
    // The column does not scroll itself: STICKY_LIST_SCROLLER inside it
    // does. Being sticky, the column is a stacking context, and the list's
    // tooltips must open inside it (between the list's cards and the pinned
    // notes card) without being clipped by the scroller's overflow — see
    // the page's tooltip target.
    display: "flex",
    flexDirection: "column",
  }
}

/**
 * The resource list column's own scroller, filling what stickyListStyle's
 * column leaves: it scrolls only when the list is longer than the screen.
 */
export const STICKY_LIST_SCROLLER: CSSProperties = { flex: "1 1 auto", minHeight: 0, overflowY: "auto" }

/**
 * Pins a block — a card, a tab bar, an activity header — `top` from the top
 * of its scroller, so what follows it scrolls beneath.
 *
 * `cover` is the gap above the block's natural position, which it is pulled
 * up over and re-padded by (as the page header does), so nothing scrolling
 * beneath shows through that strip once pinned. Opaque for the same reason.
 * Below the header's z-index (app chrome), above the feed's own small ones.
 *
 * Inside a scrolling element (rather than the page), `top` is measured
 * inside that element's padding, not from its edge; pass the padding,
 * negated, to pin flush with the edge.
 */
export function pinnedStyle(top: string | number, cover: string): CSSProperties {
  return {
    position: "sticky",
    top,
    zIndex: "calc(var(--mantine-z-index-app) - 1)",
    marginTop: `calc(-1 * ${cover})`,
    paddingTop: cover,
    background: "var(--mantine-color-body)",
  }
}
