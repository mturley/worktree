import { useMediaQuery } from "@mantine/hooks"

/** 48em is Mantine's `sm`, matching the existing Grid `sm` breakpoints. */
const WIDE_QUERY = "(min-width: 48em)"

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
