import { useCallback, useSyncExternalStore } from "react"
import type { Job, JobStep } from "../api/types"

// Background jobs the server runs (worktree create / delete), kept current by
// the stream's `jobs` and `job` events (hooks/useSSE.ts). Same
// useSyncExternalStore pattern as checksStore.ts.

let jobs: Job[] = []
let attached: ReadonlySet<string> = new Set()
let openId: string | undefined
const subscribers = new Set<() => void>()

function emit(): void {
  for (const fn of subscribers) fn()
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

// Oldest first. Array.prototype.sort is stable, so equal times keep arrival order.
function byCreated(list: Job[]): Job[] {
  return [...list].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
}

/** Replace everything: the stream's snapshot on (re)connect. */
export function setJobs(next: Job[]): void {
  jobs = byCreated(next.filter((j) => !j.dismissed))
  emit()
}

/** Upsert one job; a dismissed job is removed. */
export function applyJob(job: Job): void {
  const rest = jobs.filter((j) => j.id !== job.id)
  jobs = job.dismissed ? rest : byCreated([...rest, job])
  emit()
}

/** Oldest first. */
export function useJobs(): Job[] {
  return useSyncExternalStore(subscribe, () => jobs)
}

export function useJob(id: string | undefined): Job | undefined {
  const get = useCallback(() => (id === undefined ? undefined : jobs.find((j) => j.id === id)), [id])
  return useSyncExternalStore(subscribe, get)
}

export function getJob(id: string): Job | undefined {
  return jobs.find((j) => j.id === id)
}

// Attachments are counted: two modals may show the same job, and the toast
// stays hidden until the last one detaches.
const attachCounts = new Map<string, number>()

/** Jobs a modal in THIS tab is showing; their toasts are hidden here. */
export function attachJob(id: string): () => void {
  attachCounts.set(id, (attachCounts.get(id) ?? 0) + 1)
  attached = new Set(attachCounts.keys())
  emit()
  let detached = false
  return () => {
    if (detached) return
    detached = true
    const n = (attachCounts.get(id) ?? 0) - 1
    if (n > 0) attachCounts.set(id, n)
    else attachCounts.delete(id)
    attached = new Set(attachCounts.keys())
    emit()
  }
}

export function useAttachedJobIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => attached)
}

/** A toast asks for a job's modal; JobModalHost answers. */
export function openJobModal(id: string): void {
  openId = id
  emit()
}

export function closeJobModal(): void {
  openId = undefined
  emit()
}

export function useOpenJobId(): string | undefined {
  return useSyncExternalStore(subscribe, () => openId)
}

export function isFinished(job: Job): boolean {
  return job.state === "succeeded" || job.state === "failed" || job.state === "interrupted"
}

/** The running step. */
export function currentStep(job: Job): JobStep | undefined {
  return job.steps.find((s) => s.status === "running")
}
