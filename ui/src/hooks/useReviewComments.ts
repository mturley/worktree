import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, HttpError } from "../api/client"
import type { NewReviewComment, ReviewComment, ReviewCommentItem } from "../api/types"

const POLL_MS = 5000

/** The path's review comments, positioned for the view (when one is given). */
export function useReviewComments(path: string, view: { oldRev: string; newRev: string } | undefined) {
  return useQuery<ReviewCommentItem[]>({
    queryKey: ["review-comments", path, view?.oldRev, view?.newRev],
    queryFn: async () => (await api.reviewComments(path, view)).comments,
    refetchInterval: POLL_MS,
    // Keep the list through a view change, but never show another worktree's.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === path ? prev : undefined),
  })
}

export function useReviewCommentMutations(path: string) {
  const qc = useQueryClient()
  const onSettled = () => qc.invalidateQueries({ queryKey: ["review-comments", path] })
  return {
    create: useMutation({
      mutationFn: (req: Omit<NewReviewComment, "path">) => api.createReviewComment({ ...req, path }),
      onSettled,
    }),
    update: useMutation({
      mutationFn: (req: { id: number; version: number; body: string }) =>
        api.updateReviewComment({ path, ...req }),
      onSettled,
    }),
    remove: useMutation({ mutationFn: (id: number) => api.deleteReviewComment(path, id), onSettled }),
    clear: useMutation({ mutationFn: () => api.clearReviewComments(path), onSettled }),
  }
}

/** The current comment a 409 (edited elsewhere) carries, if err is one. */
export function conflictComment(err: unknown): ReviewComment | undefined {
  if (!(err instanceof HttpError) || err.status !== 409) return undefined
  const c = (err.body as { comment?: unknown } | null | undefined)?.comment as Partial<ReviewComment> | undefined
  if (!c || typeof c !== "object") return undefined
  if (typeof c.id !== "number" || typeof c.version !== "number" || typeof c.body !== "string") return undefined
  return c as ReviewComment
}
