import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { ResourceCard } from "./ResourceCard"

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

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

describe("ResourceCard slack", () => {
  it("shows custom_name when set", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false, custom_name: "Release blocker" } as any} />)
    expect(screen.getByText("Release blocker")).toBeInTheDocument()
    expect(screen.queryByText("C1:170.100")).not.toBeInTheDocument()
  })

  it("falls back to title when no custom_name", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false, title: "e2e regression thread" } as any} />)
    expect(screen.getByText("e2e regression thread")).toBeInTheDocument()
  })

  it("falls back to id when no custom_name or title", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false } as any} />)
    expect(screen.getByText("C1:170.100")).toBeInTheDocument()
  })

  it("shows #channel_name when set", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false, channel_name: "wg-dashboard-zaffre" } as any} />)
    expect(screen.getByText("#wg-dashboard-zaffre")).toBeInTheDocument()
  })

  it("shows by <author> when set", () => {
    wrap(<ResourceCard r={{ type: "slack", id: "C1:170.100", url: "https://x", primary: false, author: "Christian Vogt" } as any} />)
    expect(screen.getByText("by Christian Vogt")).toBeInTheDocument()
  })

  it("shows started/active relative times when created_ts/updated_ts are set", () => {
    const nowSec = Math.floor(Date.now() / 1000)
    wrap(<ResourceCard r={{
      type: "slack", id: "C1:170.100", url: "https://x", primary: false,
      created_ts: String(nowSec - 3600), updated_ts: String(nowSec - 60),
    } as any} />)
    expect(screen.getByText(/^started /)).toBeInTheDocument()
    expect(screen.getByText(/^· active /)).toBeInTheDocument()
  })
})
