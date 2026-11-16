import type { Job } from "../../api/types"

/**
 * A failed job's error, unless a step already carries the same words. The
 * error is usually the failing step's own output, and showing it twice — once
 * under the step, once in an alert below — reads like two things went wrong.
 */
export function jobErrorToShow(job: Job): string | undefined {
  if (job.state !== "failed" && job.state !== "interrupted") return undefined
  if (job.error === undefined || job.error === "") return undefined
  if (job.steps.some((s) => s.detail === job.error)) return undefined
  return job.error
}
