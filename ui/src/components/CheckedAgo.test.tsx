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

describe("checked … ago", () => {
  it("follows each section's description once the server has checked", () => {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString()
    act(() => setChecks({ listeners: ago(30), kubeconfig: ago(120) }))
    render(<MantineProvider><NetworkPanel path="/wt" /><KubeconfigPanel kubeconfig={{ state: "missing" }} /></MantineProvider>)
    expect(screen.getByText("Ports in use by processes in this worktree · checked 30s ago")).toBeInTheDocument()
    expect(screen.getByText("Current cluster context · checked 2m ago")).toBeInTheDocument()
  })
  it("is left off before the first check", () => {
    render(<MantineProvider><KubeconfigPanel kubeconfig={{ state: "missing" }} /></MantineProvider>)
    expect(screen.getByText("Current cluster context")).toBeInTheDocument()
  })
})
