import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { lazy, Suspense } from "react"
import { MantineProvider } from "@mantine/core"
import { DiffViewBoundary, installPreloadReload } from "./DiffViewBoundary"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("DiffViewBoundary", () => {
  it("shows a reload prompt, not a blank area, when the lazy chunk fails to load", async () => {
    // React reports the caught error to the console; keep the output clean.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const Broken = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")))
    render(
      <MantineProvider>
        <DiffViewBoundary>
          <Suspense fallback={null}>
            <Broken />
          </Suspense>
        </DiffViewBoundary>
      </MantineProvider>,
    )
    expect(await screen.findByText("Couldn't load the diff view — reload the page.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
  })

  it("reloads once on vite:preloadError, then lets a repeat through instead of looping", () => {
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, "location", { configurable: true, value: { ...original, reload } })
    try {
      window.sessionStorage.clear()
      installPreloadReload()
      installPreloadReload() // idempotent: one listener, one reload per event

      const first = new Event("vite:preloadError", { cancelable: true })
      window.dispatchEvent(first)
      expect(reload).toHaveBeenCalledTimes(1)
      expect(first.defaultPrevented).toBe(true)

      const again = new Event("vite:preloadError", { cancelable: true })
      window.dispatchEvent(again)
      expect(reload).toHaveBeenCalledTimes(1)
      expect(again.defaultPrevented).toBe(false)
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original })
    }
  })

  it("renders its children when nothing fails", () => {
    render(
      <MantineProvider>
        <DiffViewBoundary>
          <p>diff</p>
        </DiffViewBoundary>
      </MantineProvider>,
    )
    expect(screen.getByText("diff")).toBeInTheDocument()
  })
})
