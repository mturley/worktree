import { afterEach, describe, it, expect, vi } from "vitest"
import { StrictMode } from "react"
import userEvent from "@testing-library/user-event"
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { api } from "../api/client"
import { WorkLogEditor } from "./WorkLogEditor"
import type { TimelineEvent } from "../api/types"

if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

const event: TimelineEvent = {
  id: "task:42", ts: "2026-08-25T00:00:00Z", external_ts: "", source: "tasks",
  type: "task_work_logged", type_label: "work logged", title: "Worked on “t”",
  body: "old note", author: "me", resource_type: "task", resource_id: "7",
  resource_url: "", resource_title: "t", worktrees: [],
}

const setup = () => {
  const props = { event, onSaved: vi.fn(), onDeleted: vi.fn(), onCancel: vi.fn() }
  render(
    <MantineProvider>
      <QueryClientProvider client={new QueryClient()}>
        <WorkLogEditor {...props} />
      </QueryClientProvider>
    </MantineProvider>,
  )
  return props
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("WorkLogEditor", () => {
  it("saves trimmed text against the numeric event id", async () => {
    const edit = vi.spyOn(api, "editWorkLog").mockResolvedValue({ id: 7 } as never)
    const p = setup()
    const box = screen.getByLabelText("Work log note")
    expect(box).toHaveValue("old note")
    await userEvent.clear(box)
    await userEvent.type(box, "  new note ")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(p.onSaved).toHaveBeenCalled())
    expect(edit).toHaveBeenCalledWith(42, "  new note ")
    expect(p.onSaved.mock.calls[0][0]).toMatchObject({ body: "new note" })
    expect(p.onSaved.mock.calls[0][0].edited_at).toBeTruthy()
  })

  it("saving unchanged text (after trimming) writes nothing and just closes", async () => {
    const edit = vi.spyOn(api, "editWorkLog")
    const p = setup()
    await userEvent.type(screen.getByLabelText("Work log note"), "  ")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(p.onCancel).toHaveBeenCalledTimes(1)
    expect(edit).not.toHaveBeenCalled()
    expect(p.onSaved).not.toHaveBeenCalled()
  })

  it("opens with the textarea focused, under StrictMode too", () => {
    render(
      <StrictMode>
        <MantineProvider>
          <QueryClientProvider client={new QueryClient()}>
            <WorkLogEditor event={event} onSaved={vi.fn()} onDeleted={vi.fn()} onCancel={vi.fn()} />
          </QueryClientProvider>
        </MantineProvider>
      </StrictMode>,
    )
    expect(screen.getByLabelText("Work log note")).toHaveFocus()
  })

  it("cannot save an empty note", async () => {
    setup()
    await userEvent.clear(screen.getByLabelText("Work log note"))
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("shows a failed save and stays open", async () => {
    vi.spyOn(api, "editWorkLog").mockRejectedValue(new Error("boom"))
    const p = setup()
    await userEvent.type(screen.getByLabelText("Work log note"), "!")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText(/Couldn't save: boom/)).toBeInTheDocument()
    expect(p.onSaved).not.toHaveBeenCalled()
  })

  it("deletes only after Yes", async () => {
    const del = vi.spyOn(api, "deleteWorkLog").mockResolvedValue({ id: 7 } as never)
    const p = setup()
    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
    await userEvent.click(screen.getByRole("button", { name: "No" }))
    expect(del).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
    await userEvent.click(screen.getByRole("button", { name: "Yes" }))
    await waitFor(() => expect(p.onDeleted).toHaveBeenCalled())
    expect(del).toHaveBeenCalledWith(42)
  })

  it("Esc cancels, from the textarea and from a button", () => {
    const p = setup()
    fireEvent.keyDown(screen.getByLabelText("Work log note"), { key: "Escape" })
    fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), { key: "Escape" })
    expect(p.onCancel).toHaveBeenCalledTimes(2)
  })
})
