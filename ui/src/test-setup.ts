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
