// The exact button labels and tooltips for writing to the PR.

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
