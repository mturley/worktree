import { describe, expect, it } from "vitest"
import { tabDirty } from "./tabDirty"
import { baseSettings } from "./testSettings"
import type { Drafts } from "./useSettingsDraft"

const drafts = (s = baseSettings()): Drafts => ({ worktree: s.worktree, watcher_auth: s.watcher_auth, watcher_config: s.watcher_config })

describe("tabDirty", () => {
  it("is clean when nothing changed", () => {
    expect(tabDirty(baseSettings(), drafts(), {}).general).toBe(false)
  })

  it.each([
    ["background_fetch", { background_fetch: false }],
    ["fetch_interval", { fetch_interval: "10m" }],
  ])("lights the General dot when git.%s changes", (_name, patch) => {
    const d = drafts()
    d.worktree = { ...d.worktree, git: { ...d.worktree.git, ...patch } }
    const dirty = tabDirty(baseSettings(), d, {})
    expect(dirty.general).toBe(true)
    expect(dirty.notifications).toBe(false)
    expect(dirty["ui-access"]).toBe(false)
  })
})

describe("tabDirty port scan", () => {
  it("lights the General dot when port_scan_enabled changes", () => {
    const d = drafts()
    d.worktree = { ...d.worktree, port_scan_enabled: false }
    expect(tabDirty(baseSettings(), d, {}).general).toBe(true)
  })
})
