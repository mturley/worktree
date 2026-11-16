import { useCallback, useSyncExternalStore } from "react"
import type { Job, JobStep } from "../api/types"

// Background jobs the server runs (worktree create / delete), kept current by
// the stream's `jobs` and `job` events (hooks/useSSE.ts). Same
// useSyncExternalStore pattern as checksStore.ts.

/** What JobModalHost needs to render a modal, settled when it is opened. */
export interface OpenJobModal {
  id: string
  kind: string
  /** The worktree path the job works on. */
  target: string
}

let jobs: Job[] = []
let attached: ReadonlySet<string> = new Set()
let openModal: OpenJobModal | undefined
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

/**
 * A toast, or the control that started the job, asks for its modal;
 * JobModalHost answers. Which modal to show is decided here, once, from the
 * job as it is now: the server drops a clean success ten seconds later, and
 * another tab can dismiss it sooner, neither of which should take the modal
 * away from somebody reading it.
 */
export function openJobModal(job: Job): void {
  openModal = { id: job.id, kind: job.kind, target: job.target }
  emit()
}

export function closeJobModal(): void {
  openModal = undefined
  emit()
}

export function useOpenJobModal(): OpenJobModal | undefined {
  return useSyncExternalStore(subscribe, () => openModal)
}

export function isFinished(job: Job): boolean {
  return job.state === "succeeded" || job.state === "failed" || job.state === "interrupted"
}

/** The running step. */
export function currentStep(job: Job): JobStep | undefined {
  return job.steps.find((s) => s.status === "running")
}
