import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { ListeningPorts } from "./ListeningPorts"

afterEach(cleanup)
const p = (port: number, in_range: boolean) => ({ port, addresses: ["*"], pid: 1, process: "x", in_range })

describe("ListeningPorts", () => {
  it("lists the ports, out-of-range ones in red", () => {
    render(<MantineProvider><div data-testid="x"><ListeningPorts ports={[p(4091, true), p(9000, false)]} range="4090-4099" /></div></MantineProvider>)
    expect(screen.getByTestId("x").textContent).toBe("4091, 9000")
    expect(screen.getByText("9000").getAttribute("style") ?? "").toContain("red")
    expect(screen.getByText("4091").getAttribute("style") ?? "").not.toContain("red")
  })
  it("explains a red port in a tooltip", async () => {
    render(<MantineProvider><ListeningPorts ports={[p(4091, true), p(9000, false)]} range="4090-4099" /></MantineProvider>)
    await userEvent.hover(screen.getByText("9000"))
    expect(await screen.findByText("Outside this worktree's reserved port range (4090–4099)")).toBeInTheDocument()
  })
})
