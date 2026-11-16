import { beforeEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { Job } from "../api/types"
import {
  applyJob,
  attachJob,
  closeJobModal,
  currentStep,
  getJob,
  openJobModal,
  setJobs,
  useAttachedJobIds,
  useJobs,
  useOpenJobModal,
} from "./jobsStore"

const job = (over: Partial<Job> = {}): Job => ({
  id: "a",
  kind: "worktree_create",
  title: "Create worktree",
  target: "feature",
  state: "running",
  steps: [],
  question: null,
  result: null,
  created_at: "2026-11-16T10:00:00Z",
  updated_at: "2026-11-16T10:00:00Z",
  ...over,
})

describe("jobsStore", () => {
  beforeEach(() => {
    act(() => {
      setJobs([])
      closeJobModal()
    })
  })

  it("applyJob adds then updates by id", () => {
    const { result } = renderHook(() => useJobs())
    act(() => applyJob(job()))
    act(() => applyJob(job({ state: "succeeded" })))
    expect(result.current).toHaveLength(1)
    expect(result.current[0].state).toBe("succeeded")
    expect(getJob("a")?.state).toBe("succeeded")
  })

  it("applyJob with dismissed removes the job", () => {
    act(() => applyJob(job()))
    act(() => applyJob(job({ dismissed: true })))
    expect(getJob("a")).toBeUndefined()
  })

  it("setJobs replaces the store", () => {
    const { result } = renderHook(() => useJobs())
    act(() => setJobs([job({ id: "A" }), job({ id: "B" })]))
    act(() => setJobs([job({ id: "B", state: "failed" })]))
    expect(result.current.map((j) => j.id)).toEqual(["B"])
    expect(result.current[0].state).toBe("failed")
  })

  it("useJobs is oldest first", () => {
    const { result } = renderHook(() => useJobs())
    act(() =>
      setJobs([
        job({ id: "new", created_at: "2026-11-16T12:00:00Z" }),
        job({ id: "old", created_at: "2026-11-16T09:00:00Z" }),
      ]),
    )
    expect(result.current.map((j) => j.id)).toEqual(["old", "new"])
  })

  it("attachJob hides and the returned function shows again", () => {
    const { result } = renderHook(() => useAttachedJobIds())
    let detach = () => {}
    act(() => {
      detach = attachJob("a")
    })
    expect(result.current.has("a")).toBe(true)
    act(() => detach())
    expect(result.current.has("a")).toBe(false)
  })

  it("openJobModal / closeJobModal drive useOpenJobModal", () => {
    const { result } = renderHook(() => useOpenJobModal())
    expect(result.current).toBeUndefined()
    act(() => openJobModal(job()))
    expect(result.current).toEqual({ id: "a", kind: "worktree_create", target: "feature" })
    act(() => closeJobModal())
    expect(result.current).toBeUndefined()
  })

  // What the modal shows is settled when it opens. The job itself may be
  // dismissed a moment later — by the server's expiry, or from another tab —
  // and tearing the modal down mid-read is not an answer to that.
  it("keeps the open modal after its job leaves the store", () => {
    const { result } = renderHook(() => useOpenJobModal())
    act(() => {
      setJobs([job()])
      openJobModal(job())
      applyJob(job({ dismissed: true }))
    })
    expect(result.current).toEqual({ id: "a", kind: "worktree_create", target: "feature" })
  })

  it("currentStep is the running step, undefined when none", () => {
    const steps = [
      { key: "x", label: "X", status: "done" as const },
      { key: "y", label: "Y", status: "running" as const },
    ]
    expect(currentStep(job({ steps }))?.key).toBe("y")
    expect(currentStep(job({ steps: [steps[0]] }))).toBeUndefined()
  })
})
