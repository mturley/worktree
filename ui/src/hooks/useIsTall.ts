import { useMediaQuery } from "@mantine/hooks"

/**
 * Below this height, pinned cards would leave too little of the screen for
 * what scrolls beneath them, so the worktree page pins only its title row.
 */
const TALL_QUERY = "(min-height: 720px)"

/**
 * Whether the viewport is tall enough for the worktree page's pinned cards:
 * the details card (in the header or the resource column) and a selected
 * resource's card and tabs. The height counterpart of useIsWide, with the
 * same first-render behaviour; tests control it through setViewport.
 */
export function useIsTall(): boolean {
  return useMediaQuery(TALL_QUERY, false, { getInitialValueInEffect: false }) ?? false
}
