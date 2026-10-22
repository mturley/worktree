import { afterEach, describe, expect, it, vi } from "vitest"
import { notificationHref, openNotificationTarget, showBrowserNotification } from "./browserNotify"
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
  it("opens the task modal over the worktree for a task notification", () => {
    expect(notificationHref({ ...msg, resource_type: "task", resource_id: "12" })).toBe("/worktree/%2Fw%2Fwt-a?task=12")
  })
  it("targets the bare worktree page for a worktree-wide notification", () => {
    expect(notificationHref({ ...msg, resource_type: "", resource_id: "" })).toBe("/worktree/%2Fw%2Fwt-a")
  })
})

describe("openNotificationTarget", () => {
  const taskMsg: NotificationMsg = { ...msg, resource_type: "task", resource_id: "12" }
  const go = (url: string) => window.history.replaceState({}, "", url)
  const here = () => window.location.pathname + window.location.search
  afterEach(() => go("/"))

  it("opens a task over the selected resource, keeping the selection", () => {
    go("/worktree/%2Fw%2Fwt-a?resource=pr:o%2Fr%233")
    openNotificationTarget(taskMsg)
    const url = new URL(window.location.href)
    expect(url.pathname).toBe("/worktree/%2Fw%2Fwt-a")
    expect(url.searchParams.get("task")).toBe("12")
    expect(url.searchParams.get("resource")).toBe("pr:o/r#3")
  })

  it("selects a resource without closing the task modal that is open", () => {
    go("/worktree/%2Fw%2Fwt-a?task=12")
    openNotificationTarget(msg)
    const url = new URL(window.location.href)
    expect(url.searchParams.get("resource")).toBe("pr:o/r#3")
    expect(url.searchParams.get("task")).toBe("12")
  })

  it("stays put when the target is already showing, whatever else is", () => {
    go("/worktree/%2Fw%2Fwt-a?resource=pr:o%2Fr%233&task=4")
    const before = here()
    const len = window.history.length
    openNotificationTarget(msg)
    expect(here()).toBe(before)
    expect(window.history.length).toBe(len)
  })

  it("goes to the target plainly from another worktree", () => {
    go("/worktree/%2Fw%2Fwt-b?resource=jira:J-1")
    openNotificationTarget(taskMsg)
    expect(here()).toBe("/worktree/%2Fw%2Fwt-a?task=12")
  })

  const wide = { ...msg, resource_type: "", resource_id: "" }

  it("shows the bare worktree for a worktree-wide notification, clearing the selection", () => {
    go("/worktree/%2Fw%2Fwt-a?resource=pr:o%2Fr%233")
    openNotificationTarget(wide)
    expect(here()).toBe("/worktree/%2Fw%2Fwt-a")
  })

  it("closes an open task modal for a worktree-wide notification", () => {
    go("/worktree/%2Fw%2Fwt-a?task=12")
    openNotificationTarget(wide)
    expect(here()).toBe("/worktree/%2Fw%2Fwt-a")
  })

  it("stays put for a worktree-wide notification on the bare worktree", () => {
    go("/worktree/%2Fw%2Fwt-a")
    const len = window.history.length
    openNotificationTarget(wide)
    expect(here()).toBe("/worktree/%2Fw%2Fwt-a")
    expect(window.history.length).toBe(len)
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
