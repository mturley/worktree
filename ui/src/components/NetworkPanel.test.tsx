import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { NetworkPanel } from "./NetworkPanel"
import { setListeners } from "../lib/listenersStore"

const open = vi.fn()
vi.mock("./settings/SettingsContext", () => ({ useOpenSettings: () => open }))

afterEach(cleanup)
const port = { port: 4091, addresses: ["[::1]", "*"], pid: 77, process: "node", in_range: true }
const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

describe("NetworkPanel", () => {
  it("shows the reserved range and a row per port", () => {
    setListeners({ enabled: true, ports: { "/wt": [port] }, ranges: { "/wt": "4090-4099" } })
    wrap(<NetworkPanel path="/wt" />)
    expect(screen.getByText("Reserved 4090–4099")).toBeInTheDocument()
    expect(screen.getByText("[::1], *")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy PID" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open localhost:4091" })).toHaveAttribute("href", "http://localhost:4091")
  })
  it("says so with no range and nothing listening", () => {
    setListeners({ enabled: true, ports: {}, ranges: {} })
    wrap(<NetworkPanel path="/wt" />)
    expect(screen.getByText("No reserved range")).toBeInTheDocument()
    expect(screen.getByText("Nothing listening")).toBeInTheDocument()
  })
  it("offers Settings when scanning is off", async () => {
    setListeners({ enabled: false, ports: {}, ranges: {} })
    wrap(<NetworkPanel path="/wt" />)
    expect(screen.getByText(/Port scanning is off\./)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Enable it in Settings" }))
    expect(open).toHaveBeenCalledWith({ tab: "general" })
  })
})
