import "@testing-library/jest-dom"
import { vi } from "vitest"

// @testing-library/dom's waitFor() only advances fake timers automatically
// when it detects Jest's fake-timer clock (it checks for a global `jest` and
// a `.clock` property Jest's modern timers attach to `setTimeout`). Vitest's
// `vi.useFakeTimers()` attaches the same `.clock` property but exposes no
// `jest` global, so without this alias `waitFor` falls back to real
// `setTimeout`-based polling against a `setTimeout` that fake timers have
// mocked — it never fires, and the test hangs until the outer test timeout.
// Aliasing `jest` to `vi` here (harmless: `vi` implements the timer surface
// `waitFor` checks) makes `waitFor` detect and drive the fake clock itself.
if (typeof (globalThis as { jest?: unknown }).jest === "undefined") {
  ;(globalThis as { jest?: unknown }).jest = vi
}

// jsdom does not implement ResizeObserver, which Mantine components such as
// SegmentedControl (via FloatingIndicator) rely on. Provide a no-op stub so
// those components can mount under test.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// jsdom does not implement matchMedia, which MantineProvider's color-scheme
// detection and useIsWide() both rely on. Stub it with matches: false so
// every test renders the NARROW layout by default; tests that need the wide
// layout opt in explicitly via testing/viewport.ts's setViewport("wide").
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
