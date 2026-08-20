import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import { AddResourceModal } from "./AddResourceModal"

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

const addResource = vi.fn()
const setResourceMeta = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      addResource: (...args: unknown[]) => addResource(...args),
      setResourceMeta: (...args: unknown[]) => setResourceMeta(...args),
    },
  }
})

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

afterEach(() => {
  cleanup()
  addResource.mockReset()
  setResourceMeta.mockReset()
})

describe("AddResourceModal", () => {
  it("adds a resource as Focus (related=false) by default", async () => {
    addResource.mockResolvedValueOnce({ type: "pr", id: "org/repo#1", url: "u", primary: true })
    const onAdded = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { getByLabelText, getByRole } = wrap(
      <AddResourceModal opened path="/wt" onClose={onClose} onAdded={onAdded} />,
    )

    await user.type(getByLabelText(/url/i), "https://github.com/org/repo/pull/1")
    await user.click(getByRole("button", { name: "Add" }))

    expect(addResource).toHaveBeenCalledWith({
      path: "/wt",
      url: "https://github.com/org/repo/pull/1",
      related: false,
    })
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  it("adds a resource as Related when the Related segment is selected", async () => {
    addResource.mockResolvedValueOnce({ type: "jira", id: "RHOAIENG-1", url: "u", primary: false })
    const user = userEvent.setup()
    const { getByLabelText, getByRole } = wrap(
      <AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />,
    )

    await user.type(getByLabelText(/url/i), "https://redhat.atlassian.net/browse/RHOAIENG-1")
    await user.click(getByRole("radio", { name: "Related" }))
    await user.click(getByRole("button", { name: "Add" }))

    expect(addResource).toHaveBeenCalledWith({
      path: "/wt",
      url: "https://redhat.atlassian.net/browse/RHOAIENG-1",
      related: true,
    })
  })

  it("defaults to Related when defaultRelated is set", async () => {
    addResource.mockResolvedValueOnce({ type: "pr", id: "x", url: "u", primary: false })
    const user = userEvent.setup()
    const { getByLabelText, getByRole } = wrap(
      <AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} defaultRelated />,
    )

    await user.type(getByLabelText(/url/i), "https://github.com/o/r/pull/2")
    await user.click(getByRole("button", { name: "Add" }))

    expect(addResource).toHaveBeenCalledWith({ path: "/wt", url: "https://github.com/o/r/pull/2", related: true })
  })

  it("hides name/description fields for a non-Slack URL", async () => {
    const user = userEvent.setup()
    const { getByLabelText, queryByLabelText } = wrap(
      <AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />,
    )

    await user.type(getByLabelText(/url/i), "https://github.com/o/r/pull/1")

    expect(queryByLabelText(/name/i)).not.toBeInTheDocument()
    expect(queryByLabelText(/description/i)).not.toBeInTheDocument()
  })

  it("reveals name/description for a Slack URL and sets resource meta after adding", async () => {
    addResource.mockResolvedValueOnce({ type: "slack", id: "C123:1700000000.000100", url: "u", primary: true })
    setResourceMeta.mockResolvedValueOnce(null)
    const onAdded = vi.fn()
    const user = userEvent.setup()
    const { getByLabelText, getByRole } = wrap(
      <AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={onAdded} />,
    )

    await user.type(getByLabelText(/url/i), "https://acme.slack.com/archives/C123/p1700000000000100")
    await user.type(getByLabelText(/name/i), "Deploy thread")
    await user.type(getByLabelText(/description/i), "The prod deploy discussion")
    await user.click(getByRole("button", { name: "Add" }))

    await vi.waitFor(() =>
      expect(setResourceMeta).toHaveBeenCalledWith({
        type: "slack",
        id: "C123:1700000000.000100",
        name: "Deploy thread",
        description: "The prod deploy discussion",
      }),
    )
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalled())
  })

  it("does not call setResourceMeta for a Slack URL when name and description are empty", async () => {
    addResource.mockResolvedValueOnce({ type: "slack", id: "C123:1.2", url: "u", primary: true })
    const user = userEvent.setup()
    const { getByLabelText, getByRole } = wrap(
      <AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />,
    )

    await user.type(getByLabelText(/url/i), "https://acme.slack.com/archives/C123/p1700000000000100")
    await user.click(getByRole("button", { name: "Add" }))

    await vi.waitFor(() => expect(addResource).toHaveBeenCalled())
    expect(setResourceMeta).not.toHaveBeenCalled()
  })

  it("shows an inline error and stays open when addResource rejects", async () => {
    addResource.mockRejectedValueOnce(new Error("unrecognized URL"))
    const onAdded = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { getByLabelText, getByRole, findByText } = wrap(
      <AddResourceModal opened path="/wt" onClose={onClose} onAdded={onAdded} />,
    )

    await user.type(getByLabelText(/url/i), "not-a-url")
    await user.click(getByRole("button", { name: "Add" }))

    expect(await findByText("unrecognized URL")).toBeInTheDocument()
    expect(onAdded).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("disables Add while the URL is empty", () => {
    const { getByRole } = wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
    expect(getByRole("button", { name: "Add" })).toBeDisabled()
  })
})
