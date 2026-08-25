import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO } from "../api/types"

const setResourceMeta = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return { api: { ...actual.api, setResourceMeta: (...a: unknown[]) => setResourceMeta(...a) } }
})

import { EditResourceDetailsModal } from "./EditResourceDetailsModal"

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)
const pr = { type: "pr", id: "o/r#1", url: "u", primary: true, custom_description: "why" } as ResourceDTO
const slack = { type: "slack", id: "C1:1.2", url: "u", primary: true, custom_name: "Deploy", custom_description: "d" } as ResourceDTO

afterEach(() => {
  cleanup()
  setResourceMeta.mockReset()
})

describe("EditResourceDetailsModal", () => {
  it("offers Custom Name only for slack", () => {
    wrap(<EditResourceDetailsModal opened r={slack} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByLabelText("Custom Name (optional)")).toBeInTheDocument()
    cleanup()
    wrap(<EditResourceDetailsModal opened r={pr} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.queryByLabelText("Custom Name (optional)")).not.toBeInTheDocument()
  })

  it("offers Custom Description for every type", () => {
    wrap(<EditResourceDetailsModal opened r={pr} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.getByLabelText("Custom Description (optional)")).toHaveValue("why")
  })

  it("saves the description and preserves an existing name it cannot edit", async () => {
    setResourceMeta.mockResolvedValueOnce(null)
    const onSaved = vi.fn()
    const user = userEvent.setup()
    const withName = { ...pr, custom_name: "keep me" } as ResourceDTO
    wrap(<EditResourceDetailsModal opened r={withName} onClose={vi.fn()} onSaved={onSaved} />)
    await user.clear(screen.getByLabelText("Custom Description (optional)"))
    await user.type(screen.getByLabelText("Custom Description (optional)"), "new reason")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(setResourceMeta).toHaveBeenCalledWith({
        type: "pr", id: "o/r#1", name: "keep me", description: "new reason",
      }),
    )
    expect(onSaved).toHaveBeenCalled()
  })

  it("surfaces a save failure and stays open", async () => {
    setResourceMeta.mockRejectedValueOnce(new Error("HTTP 500"))
    const onClose = vi.fn()
    const user = userEvent.setup()
    wrap(<EditResourceDetailsModal opened r={pr} onClose={onClose} onSaved={vi.fn()} />)
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText("HTTP 500")).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe("EditResourceDetailsModal clear", () => {
  it("clears both fields in one action", async () => {
    setResourceMeta.mockResolvedValueOnce(null)
    const onSaved = vi.fn()
    const user = userEvent.setup()
    wrap(<EditResourceDetailsModal opened r={slack} onClose={vi.fn()} onSaved={onSaved} />)
    await user.click(screen.getByRole("button", { name: "Clear custom metadata" }))
    await waitFor(() =>
      expect(setResourceMeta).toHaveBeenCalledWith({
        type: "slack", id: "C1:1.2", name: "", description: "",
      }),
    )
    expect(onSaved).toHaveBeenCalled()
  })

  it("hides the clear button when there is nothing to clear", () => {
    const plain = { type: "pr", id: "o/r#2", url: "u", primary: true } as ResourceDTO
    wrap(<EditResourceDetailsModal opened r={plain} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Clear custom metadata" })).not.toBeInTheDocument()
  })
})
