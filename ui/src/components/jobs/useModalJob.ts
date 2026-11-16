import { useCallback, useEffect, useState } from "react"
import { api } from "../../api/client"
import type { Job } from "../../api/types"
import { attachJob, useJob } from "../../lib/jobsStore"

/**
 * The plumbing a modal needs to follow one background job: the job's id (from
 * a prop or from the start response), the job itself from the store, the last
 * job seen (the server drops a finished job from the store, but the modal must
 * keep showing it), the toast suppression while open, and the request helpers.
 *
 * State resets whenever the modal is (re)opened or retargeted (another job,
 * or a changed `resetKey`).
 */
export function useModalJob(opened: boolean, initialJobId: string | undefined, resetKey?: string) {
  const [jobId, setJobId] = useState<string | undefined>(initialJobId)
  const [lastSeen, setLastSeen] = useState<Job | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = useJob(jobId)
  const job = live ?? (lastSeen?.id === jobId ? lastSeen : undefined)

  useEffect(() => {
    if (opened) {
      setJobId(initialJobId)
      setLastSeen(undefined)
      setBusy(false)
      setError(null)
    }
  }, [opened, initialJobId, resetKey])

  useEffect(() => {
    if (live) setLastSeen(live)
  }, [live])

  // The job's toast stays hidden while this modal shows it.
  useEffect(() => {
    if (!opened || jobId === undefined) return
    return attachJob(jobId)
  }, [opened, jobId])

  /** Follow a job the server just started. */
  const track = useCallback((started: Job) => {
    setJobId(started.id)
    setLastSeen(started)
  }, [])

  // Run an action on the job; a failed request shows in the alert.
  const act = useCallback(async (fn: (id: string) => Promise<unknown>): Promise<boolean> => {
    if (jobId === undefined) return false
    setBusy(true)
    setError(null)
    try {
      await fn(jobId)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [jobId])

  // A finished job is acknowledged by closing it. It may already be gone
  // (another tab, or the server's own expiry), which is fine.
  const dismissFinished = useCallback(async () => {
    if (jobId === undefined) return
    try {
      await api.jobDismiss(jobId)
    } catch {
      // already dismissed or expired
    }
  }, [jobId])

  return { jobId, job, busy, error, setError, track, act, dismissFinished }
}
