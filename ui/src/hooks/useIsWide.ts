import { useMediaQuery } from "@mantine/hooks"

/** 48em is Mantine's `sm`, matching the existing Grid `sm` breakpoints. */
export const WIDE_MIN_EM = 48
const WIDE_QUERY = `(min-width: ${WIDE_MIN_EM}em)`

/** WIDE_MIN_EM in CSS pixels, as media queries count em: the root font size. */
export function wideMinPx(): number {
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return WIDE_MIN_EM * (Number.isFinite(root) && root > 0 ? root : 16)
}

/**
 * The single responsive predicate for the app. Components must use this
 * rather than calling useMediaQuery directly, so every layout flips at the
 * same width and tests have one thing to control (see testing/viewport.ts).
 *
 * getInitialValueInEffect:false makes the first render read matchMedia
 * immediately — avoiding a narrow-then-wide flash in the browser and making
 * the value deterministic in tests.
 */
export function useIsWide(): boolean {
  return useMediaQuery(WIDE_QUERY, false, { getInitialValueInEffect: false }) ?? false
}
