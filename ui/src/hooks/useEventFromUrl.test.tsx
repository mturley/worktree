import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import type { TimelineEvent } from "../api/types"
import { api } from "../api/client"
import { useEventFromUrl } from "./useEventFromUrl"

const event = { id: "e1" } as TimelineEvent
const Probe = ({ onEvent }: { onEvent: (e: TimelineEvent) => void }) => {
  useEventFromUrl(onEvent)
  return null
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState({}, "", "/")
})

describe("useEventFromUrl", () => {
  it("fetches the URL's event, hands it over, and drops the param alone", async () => {
    const get = vi.spyOn(api, "event").mockResolvedValue(event)
    const onEvent = vi.fn()
    window.history.replaceState({}, "", "/worktree/x?resource=pr:1&event=e1")
    render(<Probe onEvent={onEvent} />)
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith(event))
    expect(get).toHaveBeenCalledWith("e1")
    expect(window.location.pathname + window.location.search).toBe("/worktree/x?resource=pr:1")
  })

  it("does nothing without the param", () => {
    const get = vi.spyOn(api, "event")
    window.history.replaceState({}, "", "/worktree/x")
    render(<Probe onEvent={vi.fn()} />)
    expect(get).not.toHaveBeenCalled()
  })

  it("leaves the page alone when the event is gone", async () => {
    const get = vi.spyOn(api, "event").mockRejectedValue(new Error("404"))
    const onEvent = vi.fn()
    window.history.replaceState({}, "", "/?event=gone")
    render(<Probe onEvent={onEvent} />)
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(onEvent).not.toHaveBeenCalled()
  })
})
