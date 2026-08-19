import { afterEach, describe, it, expect, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MantineProvider } from "@mantine/core"
import type { ResourceDTO } from "../api/types"

// jsdom doesn't implement window.matchMedia; MantineProvider's color-scheme
// effect needs it, so stub a minimal version for this test file only.
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

// jsdom has no EventSource; useThread opens one after the initial fetch.
if (typeof (globalThis as { EventSource?: unknown }).EventSource !== "function") {
  ;(globalThis as { EventSource: unknown }).EventSource = class {
    close() {}
    set onmessage(_: unknown) {}
    set onerror(_: unknown) {}
  }
}

// Control what resources the worktree exposes per test.
let mockResources: ResourceDTO[] = []
const mockRefetch = vi.fn()
vi.mock("../hooks/useWorktreeDetail", () => ({
  useWorktreeDetail: () => ({
    resources: { data: mockResources, refetch: mockRefetch },
    timeline: { data: undefined, isLoading: false, error: null },
  }),
}))

vi.mock("../api/client", async (orig) => {
  const actual = await orig<typeof import("../api/client")>()
  return {
    api: {
      ...actual.api,
      setResourceMeta: vi.fn().mockResolvedValue(undefined),
      addResource: vi.fn().mockResolvedValue(undefined),
    },
  }
})

// Keep ThreadView off the network: getThread returns an empty thread, and
// the rest of the slackApi surface is stubbed so nothing hits fetch. The
// thread object is inlined because vi.mock factories are hoisted above any
// module-level variables.
vi.mock("../api/slackApi", () => ({
  getThread: vi.fn().mockResolvedValue({
    channel: "C1",
    channelName: "general",
    threadTs: "1699999999.000100",
    lastRead: "",
    latestReply: "",
    rootTs: "1699999999.000100",
    unreadIndex: -1,
    currentUserId: "U1",
    messages: [],
    users: {},
    emoji: {},
  }),
  eventsUrl: () => "/api/thread-events",
  getConfig: vi.fn().mockRejectedValue(new Error("no config in test")),
  postReply: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  toggleReaction: vi.fn(),
  avatarProxy: (url: string) => url,
  emojiProxy: (url: string) => url,
  ApiAuthError: class ApiAuthError extends Error {},
}))

import { SlackTab } from "./SlackTab"
import { api } from "../api/client"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockResources = []
})

function renderWithProvider(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>)
}

describe("SlackTab", () => {
  it("renders one rail entry for a worktree with one slack resource", async () => {
    mockResources = [
      {
        type: "slack",
        id: "C1:1699999999.000100",
        url: "https://x.slack.com/archives/C1/p1699999999000100",
        primary: true,
      },
    ]
    const { getByText } = renderWithProvider(<SlackTab path="/w/foo" />)
    await waitFor(() => {
      expect(getByText("C1 @ 1699999999.000100")).toBeTruthy()
    })
  })

  it("renders the empty state when there are no slack resources", () => {
    mockResources = [
      { type: "pr", id: "owner/repo#1", url: "https://github.com/owner/repo/pull/1", primary: true },
    ]
    const { getByText } = renderWithProvider(<SlackTab path="/w/foo" />)
    expect(getByText(/No Slack threads\./)).toBeTruthy()
  })
})

describe("SlackTab custom name", () => {
  it("shows the custom name in the rail instead of channel:ts", async () => {
    mockResources = [
      {
        type: "slack",
        id: "C1:1700000000.000100",
        url: "https://x",
        primary: false,
        custom_name: "Release blocker",
      } as ResourceDTO,
    ]
    const { getAllByText, queryByText } = renderWithProvider(<SlackTab path="/w/foo" />)
    await waitFor(() => expect(getAllByText("Release blocker").length).toBeGreaterThan(0))
    expect(queryByText("C1 @ 1700000000.000100")).toBeNull()
  })
})

describe("SlackTab persist", () => {
  it("saves via setResourceMeta and refetches when the edit modal is submitted", async () => {
    mockResources = [
      {
        type: "slack",
        id: "C1:1700000000.000100",
        url: "https://x",
        primary: false,
      } as ResourceDTO,
    ]
    const user = userEvent.setup()
    const { getByRole, findByRole, findByLabelText } = renderWithProvider(<SlackTab path="/w/foo" />)

    // Open the edit-thread-details modal from the header icon.
    await user.click(await findByRole("button", { name: "Edit tab details" }))

    // Type a name + description, then Save.
    await user.type(await findByLabelText("Name (optional)"), "Release blocker")
    await user.type(await findByLabelText("Description (optional)"), "e2e regression")
    await user.click(getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(api.setResourceMeta).toHaveBeenCalledWith({
        type: "slack",
        id: "C1:1700000000.000100",
        name: "Release blocker",
        description: "e2e regression",
      }),
    )
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled())
  })

  it("surfaces an error alert (and does not leave a false success) when the save fails", async () => {
    mockResources = [
      {
        type: "slack",
        id: "C1:1700000000.000100",
        url: "https://x",
        primary: false,
      } as ResourceDTO,
    ]
    ;(api.setResourceMeta as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("HTTP 500"))
    const user = userEvent.setup()
    const { getByRole, findByRole, findByText, findByLabelText } = renderWithProvider(
      <SlackTab path="/w/foo" />,
    )

    await user.click(await findByRole("button", { name: "Edit tab details" }))
    await user.type(await findByLabelText("Name (optional)"), "Release blocker")
    await user.click(getByRole("button", { name: "Save" }))

    expect(await findByText("HTTP 500")).toBeTruthy()
    expect(mockRefetch).not.toHaveBeenCalled()
  })

  it("clears the custom name (saves empty string) when submitted with a blank title", async () => {
    mockResources = [
      {
        type: "slack",
        id: "C1:1700000000.000100",
        url: "https://x",
        primary: false,
        custom_name: "Old title",
      } as ResourceDTO,
    ]
    const user = userEvent.setup()
    const { getByRole, findByRole, findByLabelText } = renderWithProvider(<SlackTab path="/w/foo" />)

    // Open the modal; it shows "Old title" pre-filled.
    await user.click(await findByRole("button", { name: "Edit tab details" }))
    const nameField = await findByLabelText("Name (optional)")
    expect((nameField as HTMLInputElement).value).toBe("Old title")

    // Clear the name field (simulate user deleting the text).
    await user.clear(nameField)
    expect((nameField as HTMLInputElement).value).toBe("")

    // Submit with blank name.
    await user.click(getByRole("button", { name: "Save" }))

    // Verify setResourceMeta was called with empty string (not a placeholder).
    await waitFor(() =>
      expect(api.setResourceMeta).toHaveBeenCalledWith({
        type: "slack",
        id: "C1:1700000000.000100",
        name: "",
        description: "",
      }),
    )
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled())
  })
})

describe("SlackTab add", () => {
  it("adds a slack thread via the + button and refetches", async () => {
    mockResources = [
      {
        type: "slack",
        id: "C1:1700000000.000100",
        url: "https://x",
        primary: false,
      } as ResourceDTO,
    ]
    const user = userEvent.setup()
    const { getByRole, findByRole, findByLabelText } = renderWithProvider(<SlackTab path="/w/foo" />)

    await user.click(await findByRole("button", { name: "Add Slack thread" }))

    const urlInput = await findByLabelText("Paste a Slack thread URL")
    await user.type(urlInput, "https://x.slack.com/archives/C2/p1700000001000200")
    await user.click(getByRole("button", { name: "Add" }))

    await waitFor(() =>
      expect(api.addResource).toHaveBeenCalledWith({
        path: "/w/foo",
        url: "https://x.slack.com/archives/C2/p1700000001000200",
      }),
    )
    await waitFor(() => expect(mockRefetch).toHaveBeenCalled())
  })
})
