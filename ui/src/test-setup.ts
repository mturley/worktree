import "@testing-library/jest-dom"

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
