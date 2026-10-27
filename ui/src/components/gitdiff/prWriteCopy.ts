// The exact button labels and tooltips for writing to the PR.

import type { PRCommentsSummary } from "../../api/types"

export const WATCHER_OFF_REASON = "The GitHub watcher is off"

export const localLabel = (hasLocal: boolean) => (hasLocal ? "Add local comment" : "Start local review")
export const LOCAL_TOOLTIP =
  "Save this comment only in worktree, as part of your local review. Nothing is posted to GitHub. You can copy your local review for an agent, or include it when you submit a PR review."

export const prReviewLabel = (n: number, pending: boolean) =>
  pending ? `Add to PR review #${n}` : `Start a PR review on #${n}`
export const prReviewTooltip = (n: number) =>
  `Add this comment to your pending review on PR #${n}. Only you can see it until you submit the review.`

export const commentNowLabel = (n: number) => `Comment on PR #${n}`
export const commentNowTooltip = (n: number) =>
  `Post this comment on PR #${n} now, as a single comment everyone can see.`

export const replyNowLabel = (n: number) => `Reply on PR #${n}`
export const replyNowTooltip = (n: number) => `Post this reply on PR #${n} now. Everyone can see it.`

/** A GitHub button's reason while its write check is still loading. */
export const CHECKING_REASON = "Checking whether these lines can be posted to the PR…"
/** A refusal the check gave no reason for. */
export const UNPOSTABLE_REASON = "Can't be posted to the PR"

/** The stale pending review notice, exact. */
export const stalePendingNotice = (n: number, sha: string) =>
  `Your pending review on PR #${n} is on an older commit (${sha}). Comments on newer code can't be added to it; submit it to start a new one.`

/**
 * Why a write to the PR can't be tried right now, from the PR summary's
 * state; undefined when it can (state ok).
 */
export function prUnavailableReason(summary: PRCommentsSummary | undefined): string | undefined {
  switch (summary?.state) {
    case "ok":
      return undefined
    case "off":
      return WATCHER_OFF_REASON
    case "no_token":
      return summary.message ?? "No GitHub token is set up"
    case "error":
      return summary.message ?? "Couldn't reach GitHub"
    case "no_pr":
      return "This worktree has no PR"
    default:
      return "Loading the PR…"
  }
}
