/**
 * Test-only helper: force the viewport the UI believes it is rendering at.
 *
 * `src/test-setup.ts` stubs matchMedia with `matches: false`, so every test
 * renders the NARROW layout unless it opts in. Call this explicitly rather
 * than re-stubbing matchMedia ad hoc, so the intent of each test is obvious.
 *
 * NOTE: this overwrites `window.matchMedia` globally and does not restore
 * the previous stub afterwards (no `afterEach` reset here). Every test that
 * cares about viewport must call `setViewport(...)` itself at the start of
 * the test — do not rely on a previous test in the same file having left the
 * viewport in the mode you want, since suite/file ordering is not something
 * to depend on.
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
