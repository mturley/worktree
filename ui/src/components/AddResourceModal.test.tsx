import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"
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
const resourceType = vi.fn()
vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      addResource: (...args: unknown[]) => addResource(...args),
      setResourceMeta: (...args: unknown[]) => setResourceMeta(...args),
      resourceType: (...args: unknown[]) => resourceType(...args),
    },
  }
})

const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

beforeEach(() => {
  resourceType.mockResolvedValue({ type: "", id: "" })
})

afterEach(() => {
  cleanup()
  addResource.mockReset()
  setResourceMeta.mockReset()
  resourceType.mockReset()
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
    await user.click(getByRole("button", { name: "Follow" }))

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
    await user.click(getByRole("button", { name: "Follow" }))

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
    await user.click(getByRole("button", { name: "Follow" }))

    expect(addResource).toHaveBeenCalledWith({ path: "/wt", url: "https://github.com/o/r/pull/2", related: true })
  })

  it("hides only the custom NAME field for a non-Slack URL", async () => {
    resourceType.mockResolvedValue({ type: "pr", id: "o/r#1" })
    const user = userEvent.setup()
    const { getByLabelText, queryByLabelText, findByText } = wrap(
      <AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />,
    )

    await user.type(getByLabelText(/url/i), "https://github.com/o/r/pull/1")
    await findByText(/GitHub/)

    expect(queryByLabelText("Custom Name (optional)")).not.toBeInTheDocument()
    // Description IS offered for a PR — only the name is Slack-only.
    expect(queryByLabelText("Custom Description (optional)")).toBeInTheDocument()
  })

  it("reveals name/description for a Slack URL and sets resource meta after adding", async () => {
    resourceType.mockResolvedValue({ type: "slack", id: "C123:1700000000.000100" })
    addResource.mockResolvedValueOnce({ type: "slack", id: "C123:1700000000.000100", url: "u", primary: true })
    setResourceMeta.mockResolvedValueOnce(null)
    const onAdded = vi.fn()
    const user = userEvent.setup()
    const { getByLabelText, getByRole, findByLabelText } = wrap(
      <AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={onAdded} />,
    )

    await user.type(getByLabelText(/url/i), "https://acme.slack.com/archives/C123/p1700000000000100")
    await user.type(await findByLabelText("Custom Name (optional)"), "Deploy thread")
    await user.type(getByLabelText("Custom Description (optional)"), "The prod deploy discussion")
    await user.click(getByRole("button", { name: "Follow" }))

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
    resourceType.mockResolvedValue({ type: "slack", id: "C123:1.2" })
    addResource.mockResolvedValueOnce({ type: "slack", id: "C123:1.2", url: "u", primary: true })
    const user = userEvent.setup()
    const { getByLabelText, getByRole, findByLabelText } = wrap(
      <AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />,
    )

    await user.type(getByLabelText(/url/i), "https://acme.slack.com/archives/C123/p1700000000000100")
    await findByLabelText("Custom Name (optional)")
    await user.click(getByRole("button", { name: "Follow" }))

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
    await user.click(getByRole("button", { name: "Follow" }))

    expect(await findByText("unrecognized URL")).toBeInTheDocument()
    expect(onAdded).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("disables Add while the URL is empty", () => {
    const { getByRole } = wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
    expect(getByRole("button", { name: "Follow" })).toBeDisabled()
  })

  it("pre-fills the URL, and shows the Slack fields for a thread URL", async () => {
    // The unfurl "Add thread…" button routes through here: the URL is
    // already known, so the user should land on the choices that remain
    // (Focus/Related, custom name and description) with the Slack-only
    // fields already revealed — not on an empty field.
    resourceType.mockResolvedValue({ type: "slack", id: "C1:1700000000.000100" })
    const url = "https://acme.slack.com/archives/C1/p1700000000000100"
    const user = userEvent.setup()
    const { getByLabelText, getByRole, findByLabelText } = wrap(
      <AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} initialUrl={url} />,
    )

    expect((getByLabelText(/url/i) as HTMLInputElement).value).toBe(url)
    expect(await findByLabelText(/custom name/i)).toBeInTheDocument()

    addResource.mockResolvedValueOnce({ type: "slack", id: "C1:1700000000.000100", url, primary: false })
    await user.click(getByRole("radio", { name: /related/i }))
    await user.click(getByRole("button", { name: "Follow" }))

    expect(addResource).toHaveBeenCalledWith({ path: "/wt", url, related: true })
  })

  it("offers a custom name for a link, as it does for a Slack thread", async () => {
    resourceType.mockResolvedValue({ type: "link", id: "https://ex.com/a" })
    wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
    await userEvent.type(screen.getByLabelText("URL"), "https://ex.com/a")
    expect(await screen.findByLabelText("Custom Name (optional)")).toBeInTheDocument()
  })

  it("offers no custom name for a PR, which has a title from its source", async () => {
    resourceType.mockResolvedValue({ type: "pr", id: "o/r#1" })
    wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
    await userEvent.type(screen.getByLabelText("URL"), "https://github.com/o/r/pull/1")
    await screen.findByText(/GitHub/)
    expect(screen.queryByLabelText("Custom Name (optional)")).toBeNull()
  })

  it("names what it detected, so a mistyped URL is visible before Follow", async () => {
    resourceType.mockResolvedValue({ type: "link", id: "https://ex.com/a" })
    wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
    await userEvent.type(screen.getByLabelText("URL"), "https://ex.com/a")
    expect(await screen.findByText("Link — ex.com")).toBeInTheDocument()
  })

  it("no longer says which three services are allowed", () => {
    wrap(<AddResourceModal opened path="/wt" onClose={vi.fn()} onAdded={vi.fn()} />)
    expect(screen.getByPlaceholderText("Paste any URL")).toBeInTheDocument()
  })
})
