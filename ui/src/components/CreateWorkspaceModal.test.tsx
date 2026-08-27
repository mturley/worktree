import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MantineProvider } from "@mantine/core"
import { CreateWorkspaceModal } from "./CreateWorkspaceModal"
import { api } from "../api/client"

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MantineProvider>
      <QueryClientProvider client={qc}>
        <CreateWorkspaceModal opened onClose={() => {}} path="/wt/a" branch="my-branch" />
      </QueryClientProvider>
    </MantineProvider>,
  )
}

describe("CreateWorkspaceModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(api, "cmuxGroups").mockResolvedValue({
      groups: [{ ref: "group:1", name: "Group 1" }],
      colors: [{ name: "Blue", hex: "#2980B9" }],
    })
  })

  it("defaults the name to 'wt <branch>'", async () => {
    renderModal()
    expect(await screen.findByDisplayValue("wt my-branch")).toBeInTheDocument()
  })

  it("creates with the entered name", async () => {
    const create = vi.spyOn(api, "cmuxCreate").mockResolvedValue({ ok: true, ref: "workspace:9" })
    renderModal()
    await screen.findByDisplayValue("wt my-branch")
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }))
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/wt/a", name: "wt my-branch" }),
    )
  })
})
