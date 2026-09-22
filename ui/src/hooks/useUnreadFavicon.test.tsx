import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { act } from "react"
import type { WorktreeSummary } from "../api/types"
import { BLINK_MS } from "../lib/blinkTicker"
import { BASE_FAVICON, UNREAD_FAVICON, useUnreadFavicon } from "./useUnreadFavicon"

let list: WorktreeSummary[] = []
vi.mock("./useWorktrees", () => ({ useWorktrees: () => ({ data: list }) }))

function wt(has_unread: boolean, unread_count = 0): WorktreeSummary {
  return {
    path: "/w/a", repo: "r", branch: "b", on_disk: true,
    resource_count: 0, primary_count: 0, latest_event_ts: "",
    primary_by_type: {}, related_count: 0, focus_resources: [],
    has_unread, unread_count,
  }
}

function Probe() {
  useUnreadFavicon()
  return null
}

function icon(): string {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.getAttribute("href")!
}

beforeEach(() => {
  vi.useFakeTimers()
  list = []
  document.head.innerHTML = `<link rel="icon" href="${BASE_FAVICON}">`
  document.title = "worktree"
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("useUnreadFavicon", () => {
  it("leaves the icon and title alone when nothing is unread", () => {
    list = [wt(false)]
    render(<Probe />)
    act(() => void vi.advanceTimersByTime(BLINK_MS * 3))
    expect(icon()).toBe(BASE_FAVICON)
    expect(document.title).toBe("worktree")
  })

  it("alternates the icon and badges the title while unread", () => {
    list = [wt(true, 3)]
    render(<Probe />)
    expect(icon()).toBe(UNREAD_FAVICON)
    expect(document.title).toBe("(3) worktree")

    act(() => void vi.advanceTimersByTime(BLINK_MS))
    expect(icon()).toBe(BASE_FAVICON)
    act(() => void vi.advanceTimersByTime(BLINK_MS))
    expect(icon()).toBe(UNREAD_FAVICON)
  })

  it("keeps flashing while the tab is hidden", () => {
    list = [wt(true, 1)]
    render(<Probe />)
    act(() => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true)
      document.dispatchEvent(new Event("visibilitychange"))
      vi.advanceTimersByTime(BLINK_MS)
    })
    expect(icon()).toBe(BASE_FAVICON)
    act(() => void vi.advanceTimersByTime(BLINK_MS))
    expect(icon()).toBe(UNREAD_FAVICON)
  })

  it("restores the icon and title when the unread state clears", () => {
    list = [wt(true, 3)]
    const view = render(<Probe />)
    act(() => void vi.advanceTimersByTime(BLINK_MS))
    expect(icon()).toBe(BASE_FAVICON)

    list = [wt(false)]
    view.rerender(<Probe />)
    expect(icon()).toBe(BASE_FAVICON)
    expect(document.title).toBe("worktree")
    // The ticker is stopped, so the icon no longer comes back on.
    act(() => void vi.advanceTimersByTime(BLINK_MS * 3))
    expect(icon()).toBe(BASE_FAVICON)
  })

  it("restores the icon and title on unmount", () => {
    list = [wt(true, 2)]
    const view = render(<Probe />)
    expect(icon()).toBe(UNREAD_FAVICON)
    view.unmount()
    expect(icon()).toBe(BASE_FAVICON)
    expect(document.title).toBe("worktree")
  })
})
