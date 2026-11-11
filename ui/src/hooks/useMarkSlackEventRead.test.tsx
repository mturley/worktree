import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import { MantineProvider } from "@mantine/core"
import { Notifications, notifications } from "@mantine/notifications"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { TimelineEvent } from "../api/types"

const markRead = vi.fn()
vi.mock("../api/slackApi", async (orig) => ({
  ...(await orig<typeof import("../api/slackApi")>()),
  markRead: (...args: unknown[]) => markRead(...args),
  restoreRead: vi.fn(),
}))

import { useMarkSlackEventRead } from "./useMarkSlackEventRead"

const msg = {
  id: "slack:1", ts: "2099-01-01T00:00:00Z", type: "slack_message", type_label: "", title: "a reply", body: "",
  author: "", source: "slack", external_ts: "1790000000.000200", resource_type: "slack",
  resource_id: "C1:1790000000.000100", resource_url: "u", resource_title: "", worktrees: [], unread: true,
} as unknown as TimelineEvent

afterEach(() => {
  cleanup()
  notifications.clean()
  markRead.mockReset()
})

describe("useMarkSlackEventRead", () => {
  it("refreshes the task lists, whose combined unread counts include the thread", async () => {
    markRead.mockResolvedValue(undefined)
    const qc = new QueryClient()
    const spy = vi.spyOn(qc, "invalidateQueries")
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MantineProvider>
        <Notifications />
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </MantineProvider>
    )
    const { result } = renderHook(() => useMarkSlackEventRead(), { wrapper })
    await act(() => result.current.mark(msg, { lastRead: "", older: 0, alreadyRead: false }))
    expect(markRead).toHaveBeenCalledWith("C1", "1790000000.000100", "1790000000.000200")
    for (const key of [["tasks"], ["worktrees"], ["resources"], ["timeline"]]) {
      expect(spy).toHaveBeenCalledWith({ queryKey: key })
    }
  })
})
