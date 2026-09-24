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
 * `maxHeight` + `overflowY` are the fallback for a list longer than the screen
 * — it scrolls itself only when it has to, rather than always.
 */
export function stickyListStyle(headerHeight: number): CSSProperties {
  const offset = OFFSET(headerHeight)
  return {
    position: "sticky",
    top: `calc${offset}`,
    // Above the flowing column beside it: card internals carry small
    // z-indexes of their own and would otherwise paint over this list as it
    // scrolls past.
    zIndex: 1,
    alignSelf: "flex-start",
    maxHeight: `calc(100dvh - ${offset})`,
    overflowY: "auto",
  }
}
