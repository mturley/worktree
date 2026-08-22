/**
 * Test-only helper: force the viewport the UI believes it is rendering at.
 *
 * `src/test-setup.ts` stubs matchMedia with `matches: false`, so every test
 * renders the NARROW layout unless it opts in. Call this explicitly rather
 * than re-stubbing matchMedia ad hoc, so the intent of each test is obvious.
 */
export function setViewport(mode: "wide" | "narrow"): void {
  const matches = mode === "wide"
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
