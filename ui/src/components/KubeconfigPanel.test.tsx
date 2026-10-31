import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { KubeconfigInfo } from "../api/types"
import { KubeconfigPanel } from "./KubeconfigPanel"

afterEach(cleanup)
const wrap = (k: KubeconfigInfo | undefined) => render(<MantineProvider><KubeconfigPanel kubeconfig={k} /></MantineProvider>)

describe("KubeconfigPanel", () => {
  it("shows the current context's cluster, user and namespace", () => {
    wrap({ state: "ok", cluster: "https://api.c:6443", user: "me", namespace: "ns" })
    expect(screen.getByText("Kubeconfig")).toBeInTheDocument()
    expect(screen.getByText("Current cluster context")).toBeInTheDocument()
    expect(screen.getByText("https://api.c:6443")).toBeInTheDocument()
    expect(screen.getByText("me")).toBeInTheDocument()
    expect(screen.getByText("ns")).toBeInTheDocument()
  })
  it("copies the cluster's API URL", async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
    wrap({ state: "ok", cluster: "https://api.c:6443", user: "me" })
    await user.click(screen.getByRole("button", { name: "Copy cluster URL" }))
    expect(writeText).toHaveBeenCalledWith("https://api.c:6443")
  })
  it("omits the namespace when the context sets none, and flags an undefined cluster or user", () => {
    wrap({ state: "ok" })
    expect(screen.queryByText("Namespace")).not.toBeInTheDocument()
    expect(screen.getAllByText("not found")).toHaveLength(2)
  })
  it("says when there is no kubeconfig or no current context", () => {
    wrap({ state: "missing" })
    expect(screen.getByText("No kubeconfig")).toBeInTheDocument()
    cleanup()
    wrap({ state: "no_context" })
    expect(screen.getByText("No current context")).toBeInTheDocument()
  })
})
