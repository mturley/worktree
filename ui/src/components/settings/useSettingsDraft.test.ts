import { describe, expect, it, vi, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { api } from "../../api/client"
import { useSettingsDraft } from "./useSettingsDraft"
import { baseSettings } from "./testSettings"

afterEach(() => vi.restoreAllMocks())

describe("useSettingsDraft", () => {
  it("tracks dirty per file and counts restart fields", () => {
    const { result } = renderHook(() => useSettingsDraft(baseSettings()))
    expect(result.current.anyDirty).toBe(false)
    act(() => result.current.update("worktree", (d) => ({ ...d, editor: "zed", ui: { ...d.ui, https_port: 9000 } })))
    expect(result.current.dirty).toEqual({ worktree: true, watcher_auth: false, watcher_config: false })
    expect(result.current.restartCount).toBe(1)
  })

  it("ignores map key order when comparing", () => {
    const { result } = renderHook(() => useSettingsDraft(baseSettings()))
    act(() => result.current.update("watcher_config", (d) => ({ jira: { ...d.jira, custom_fields: { b: "customfield_2", a: "customfield_1" } } })))
    expect(result.current.dirty.watcher_config).toBe(false)
  })

  it("discard restores server values", () => {
    const { result } = renderHook(() => useSettingsDraft(baseSettings()))
    act(() => result.current.update("worktree", (d) => ({ ...d, editor: "zed" })))
    act(() => result.current.discard())
    expect(result.current.anyDirty).toBe(false)
    expect(result.current.drafts!.worktree.editor).toBe("")
  })

  it("saves only dirty files and keeps a failed file dirty", async () => {
    const saved = baseSettings()
    saved.worktree.editor = "zed"
    const w = vi.spyOn(api, "saveWorktreeSettings").mockResolvedValue(saved)
    const a = vi.spyOn(api, "saveWatcherAuthSettings").mockRejectedValue(new Error("disk full"))
    const c = vi.spyOn(api, "saveWatcherConfigSettings")
    const { result } = renderHook(() => useSettingsDraft(baseSettings()))
    act(() => {
      result.current.update("worktree", (d) => ({ ...d, editor: "zed" }))
      result.current.update("watcher_auth", (d) => ({ ...d, jira: { ...d.jira, email: "new@x" } }))
    })
    let out: Awaited<ReturnType<typeof result.current.save>>
    await act(async () => { out = await result.current.save() })
    expect(w).toHaveBeenCalledOnce()
    expect(a).toHaveBeenCalledOnce()
    expect(c).not.toHaveBeenCalled()
    expect(out!.saved).toEqual(["worktree"])
    expect(result.current.errors.watcher_auth).toBe("disk full")
    expect(result.current.dirty).toEqual({ worktree: false, watcher_auth: true, watcher_config: false })
  })
})
