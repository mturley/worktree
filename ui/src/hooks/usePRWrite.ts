import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, HttpError } from "../api/client"
import type { PRCommentsSummary, PRRefDTO, PRReviewEvent, PRWriteCheck, PRWriteMode, PRWriteTarget } from "../api/types"

/**
 * Whether a new comment on the target can be posted to the PR, per mode.
 * Off without a target or without a PR.
 */
export function usePRWriteCheck(path: string, target: PRWriteTarget | undefined, hasPR: boolean) {
  return useQuery<PRWriteCheck>({
    queryKey: [
      "pr-write-check",
      path,
      target?.file,
      target?.side,
      target?.start_line,
      target?.end_line,
      target?.old_rev,
      target?.new_rev,
    ],
    queryFn: () => {
      if (!target) throw new Error("no target")
      return api.prWriteCheck(path, target)
    },
    staleTime: 30_000,
    enabled: !!target && hasPR,
  })
}

/** Writes to the PR. Each reloads the PR's counts and threads and the local comments. */
export function usePRWriteMutations(path: string) {
  const qc = useQueryClient()
  const onSuccess = () =>
    Promise.all(
      ["pr-comments", "pr-threads", "review-comments"].map((k) => qc.invalidateQueries({ queryKey: [k, path] })),
    )
  return {
    comment: useMutation({
      mutationFn: (req: PRWriteTarget & { mode: PRWriteMode; body: string }) => api.prWriteComment({ ...req, path }),
      onSuccess,
    }),
    reply: useMutation({
      mutationFn: (req: { thread_id: string; in_reply_to: number; mode: PRWriteMode; body: string }) =>
        api.prWriteReply({ ...req, path }),
      onSuccess,
    }),
    submit: useMutation({
      mutationFn: (req: { head: string; event: PRReviewEvent; body: string; include_local: boolean }) =>
        api.prSubmit({ ...req, path }),
      // A failed submit may still have posted some comments.
      onSettled: onSuccess,
    }),
  }
}

/**
 * The worktree's PR, when it has one: the summary found it, or knew it before
 * the watcher went off, a fetch failed or the token went. Undefined hides
 * every GitHub button.
 */
export function summaryPR(summary: PRCommentsSummary | undefined): PRRefDTO | undefined {
  return summary?.state === "no_pr" ? undefined : summary?.pr
}

/** A failed write's message: a refusal's (409) reason, else the error's own. */
export function prWriteError(err: unknown): string {
  if (err instanceof HttpError && err.status === 409) {
    const reason = (err.body as { reason?: unknown } | null | undefined)?.reason
    if (typeof reason === "string" && reason) return reason
  }
  return err instanceof Error ? err.message : String(err)
}
