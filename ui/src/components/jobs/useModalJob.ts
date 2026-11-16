import { useCallback, useEffect, useState } from "react"
import { api } from "../../api/client"
import type { Job } from "../../api/types"
import { attachJob, isFinished, useJob } from "../../lib/jobsStore"

/**
 * The plumbing a modal needs to follow one background job: the job's id (from
 * a prop or from the start response), the job itself from the store, the last
 * job seen (the server drops a finished job from the store, but the modal must
 * keep showing it), whether the job ended out of sight, the toast suppression
 * while open, and the request helpers.
 *
 * State resets whenever the modal is (re)opened or retargeted (another job,
 * or a changed `resetKey`).
 */
export function useModalJob(
  opened: boolean,
  initialJobId: string | undefined,
  resetKey?: string,
  /**
   * The job as whoever opened the modal last saw it. It stands in until the
   * stream says otherwise, so a modal opened on a job the server has only just
   * started has its steps to show rather than nothing at all.
   */
  initialJob?: Job,
) {
  const [jobId, setJobId] = useState<string | undefined>(initialJobId)
  const [lastSeen, setLastSeen] = useState<Job | undefined>(initialJob)
  const [sawLive, setSawLive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = useJob(jobId)
  const job = live ?? (lastSeen?.id === jobId ? lastSeen : undefined)

  // Over plain HTTP a hidden tab gives its stream back, so a job can run to
  // the end, be reported, and expire while this tab hears none of it. On
  // reconnect it is simply absent, and the last state seen — a spinner, "this
  // keeps running" — would otherwise stand forever. An unfinished job cannot
  // leave the store any other way, so its absence is the news: it is over.
  // `!live` alone will not do: between the start response and the first
  // stream event there is legitimately no job in the store yet.
  const gone = sawLive && !live && lastSeen !== undefined && !isFinished(lastSeen)

  useEffect(() => {
    if (opened) {
      setJobId(initialJobId)
      setLastSeen(initialJob)
      setSawLive(false)
      setBusy(false)
      setError(null)
    }
  }, [opened, initialJobId, resetKey])

  useEffect(() => {
    if (live) {
      setLastSeen(live)
      setSawLive(true)
    }
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
    setSawLive(false)
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

  // A modal opened on a job id nobody in this tab has ever seen — a toast
  // acted on in another tab, a link followed late — has nothing to show and
  // must not fall back to the confirmation form for a worktree it has no name
  // for.
  const unknown = jobId !== undefined && job === undefined

  return { jobId, job, gone, unknown, busy, error, setError, track, act, dismissFinished }
}
