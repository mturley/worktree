import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useLayoutEffect, useRef, type ReactNode } from "react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { FileDiffMetadata } from "@pierre/diffs"
import type { DiffFile } from "./parsedPatch"
import { DiffBody } from "./DiffBody"

vi.mock("@pierre/diffs/worker/worker-portable.js?worker", () => ({ default: class {} }))

// pierre stood in by the same shape it renders: a host element whose open
// shadow root holds the file header (`data-diffs-header`, with a slot for the
// React prefix) and the body; the prefix itself is a light-DOM child of the
// host, slotted into the header. `collapsed` is mirrored onto the host.
vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Virtualizer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FileDiff: ({
    fileDiff,
    options,
    renderHeaderPrefix,
    renderHeaderFilenameSuffix,
  }: {
    fileDiff: FileDiffMetadata
    options: { collapsed?: boolean; unsafeCSS?: string }
    renderHeaderPrefix?: (fd: FileDiffMetadata) => ReactNode
    renderHeaderFilenameSuffix?: (fd: FileDiffMetadata) => ReactNode
  }) => {
    const host = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      const el = host.current!
      const root = el.shadowRoot ?? el.attachShadow({ mode: "open" })
      root.innerHTML =
        `<div data-diffs-header="default"><slot name="header-prefix"></slot>` +
        `<div data-title>${fileDiff.name}<slot name="header-filename-suffix"></slot></div>` +
        `<div data-metadata><span>+1</span></div></div>` +
        `<pre data-code>line</pre>`
    }, [fileDiff.name])
    return (
      <div ref={host} data-testid={`host-${fileDiff.name}`} data-collapsed={String(!!options.collapsed)} data-css={options.unsafeCSS}>
        <div slot="header-prefix">{renderHeaderPrefix?.(fileDiff)}</div>
        <div slot="header-filename-suffix">{renderHeaderFilenameSuffix?.(fileDiff)}</div>
      </div>
    )
  },
}))

vi.mock("../../api/client", async (orig) => {
  const actual = await orig<typeof import("../../api/client")>()
  return {
    api: {
      ...actual.api,
      settings: async () => ({ worktree: { editor: "code" } }),
      openInEditor: vi.fn(async () => ({ ok: true })),
    },
  }
})

const diffFile = (path: string): DiffFile =>
  ({
    path,
    type: "change",
    binary: false,
    autoCollapse: false,
    meta: { name: path, type: "change", hunks: [] } as unknown as FileDiffMetadata,
  }) as unknown as DiffFile

const renderBody = () =>
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DiffBody
          files={[diffFile("a.go"), diffFile("b.go")]}
          loadKey="k"
          oldRev="o"
          newRev="n"
          mode="unified"
          path="/w/a"
          highlighted={null}
          height="400px"
        />
      </QueryClientProvider>
    </MantineProvider>,
  )

/** Renders, then waits for settings to load (the editor icons enable), so no update lands after a test. */
const wrap = async () => {
  renderBody()
  await waitFor(() => expect(screen.getByRole("button", { name: "Open b.go in editor" })).toBeEnabled())
}

afterEach(cleanup)

const collapsed = (name: string) => screen.getByTestId(`host-${name}`).dataset.collapsed
/** Clicks an element inside the host's shadow root, as a real click would. */
const clickInShadow = (name: string, selector: string) =>
  act(() => {
    const el = screen.getByTestId(`host-${name}`).shadowRoot!.querySelector(selector)!
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }))
  })

describe("DiffBody file header", () => {
  it("collapses and expands a file from anywhere on its header", async () => {
    await wrap()
    expect(collapsed("a.go")).toBe("false")
    clickInShadow("a.go", "[data-title]")
    expect(collapsed("a.go")).toBe("true")
    clickInShadow("a.go", "[data-metadata] span")
    expect(collapsed("a.go")).toBe("false")
    clickInShadow("a.go", "[data-diffs-header]")
    expect(collapsed("a.go")).toBe("true")
    // Only that file.
    expect(collapsed("b.go")).toBe("false")
  })

  it("leaves the file alone when its code is clicked", async () => {
    await wrap()
    clickInShadow("a.go", "[data-code]")
    expect(collapsed("a.go")).toBe("false")
  })

  it("toggles once, not twice, from the chevron", async () => {
    const user = userEvent.setup()
    await wrap()
    await user.click(screen.getByRole("button", { name: "Collapse a.go" }))
    expect(collapsed("a.go")).toBe("true")
    await user.click(screen.getByRole("button", { name: "Expand a.go" }))
    expect(collapsed("a.go")).toBe("false")
  })

  it("does not toggle from the editor icon", async () => {
    const user = userEvent.setup()
    await wrap()
    // The icon swaps out of its disabled wrapper once settings load, so look it up again.
    const icon = () => screen.getByRole("button", { name: "Open a.go in editor" })
    await vi.waitFor(() => expect(icon()).toBeEnabled())
    await user.click(icon())
    expect(collapsed("a.go")).toBe("false")
  })

  it("puts the editor icon after the file name, the chevron before it", async () => {
    await wrap()
    const icon = screen.getByRole("button", { name: "Open a.go in editor" })
    expect(icon.closest('[slot="header-filename-suffix"]')).not.toBeNull()
    const chevron = screen.getByRole("button", { name: "Collapse a.go" })
    expect(chevron.closest('[slot="header-prefix"]')).not.toBeNull()
  })

  it("gives the header a pointer cursor", async () => {
    await wrap()
    expect(screen.getByTestId("host-a.go").dataset.css).toMatch(/\[data-diffs-header\][^{]*\{[^}]*cursor:\s*pointer/)
  })
})
