import { afterEach, describe, it, expect } from "vitest"
import { render, cleanup, screen, act } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { setChecks } from "../lib/checksStore"
import { KubeconfigPanel } from "./KubeconfigPanel"
import { NetworkPanel } from "./NetworkPanel"

afterEach(() => {
  cleanup()
  act(() => setChecks({}))
})

describe("checked … ago (stale only)", () => {
  it("appears only once a section's last check is over a minute old", () => {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
    act(() => setChecks({ listeners: ago(30), kubeconfig: ago(120) }))
    render(<MantineProvider><NetworkPanel path="/wt" /><KubeconfigPanel kubeconfig={{ state: "missing" }} /></MantineProvider>)
    expect(screen.getByText("Ports in use by processes in this worktree")).toBeInTheDocument()
    expect(screen.getByText("Current cluster context · checked 2m ago")).toBeInTheDocument()
  })
  it("is left off before the first check", () => {
    render(<MantineProvider><KubeconfigPanel kubeconfig={{ state: "missing" }} /></MantineProvider>)
    expect(screen.getByText("Current cluster context")).toBeInTheDocument()
  })
})
