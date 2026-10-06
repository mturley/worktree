import { afterEach, describe, expect, it, vi } from "vitest"
import { notificationHref, showBrowserNotification } from "./browserNotify"
import type { NotificationMsg } from "../api/types"

const msg: NotificationMsg = {
  id: "n1", title: "PR #3: Fix", subtitle: "wt-a", body: "approved", worktree_path: "/w/wt-a",
  resource_type: "pr", resource_id: "o/r#3", tag: "worktree:/w/wt-a|pr:o/r#3",
}

class FakeNotification {
  static permission: NotificationPermission = "granted"
  static instances: FakeNotification[] = []
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(public title: string, public opts: NotificationOptions) {
    FakeNotification.instances.push(this)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeNotification.instances = []
})

describe("notificationHref", () => {
  it("targets the worktree page with the resource selected", () => {
    expect(notificationHref(msg)).toBe("/worktree/%2Fw%2Fwt-a?resource=pr:o%2Fr%233")
  })
  it("targets the home page for a summary spanning worktrees", () => {
    expect(notificationHref({ ...msg, worktree_path: "", resource_type: "", resource_id: "" })).toBe("/")
  })
  it("targets the bare worktree page for a worktree-wide notification", () => {
    expect(notificationHref({ ...msg, resource_type: "", resource_id: "" })).toBe("/worktree/%2Fw%2Fwt-a")
  })
})

describe("showBrowserNotification", () => {
  it("shows with subtitle + body and tag, and runs onClick", () => {
    vi.stubGlobal("Notification", FakeNotification)
    // jsdom has no window.focus; the click handler calls it.
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {})
    const onClick = vi.fn()
    expect(showBrowserNotification(msg, onClick)).toBe(true)
    const n = FakeNotification.instances[0]
    expect(n.title).toBe("PR #3: Fix")
    expect(n.opts.body).toBe("wt-a\napproved")
    expect(n.opts.tag).toBe(msg.tag)
    n.onclick!()
    expect(focus).toHaveBeenCalled()
    expect(onClick).toHaveBeenCalled()
    expect(n.close).toHaveBeenCalled()
    focus.mockRestore()
  })
  it("returns false without permission", () => {
    FakeNotification.permission = "default"
    vi.stubGlobal("Notification", FakeNotification)
    expect(showBrowserNotification(msg, () => {})).toBe(false)
    FakeNotification.permission = "granted"
  })
  it("returns false without the API", () => {
    vi.stubGlobal("Notification", undefined)
    expect(showBrowserNotification(msg, () => {})).toBe(false)
  })
})
