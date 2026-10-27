import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../../api/client"
import type { PRThread, ResourceDTO } from "../../api/types"
import { useDiffView } from "../../hooks/useDiffView"
import { usePRCommentsSummary, usePRThreads, useShowPRComments } from "../../hooks/usePRComments"
import { useReviewSidebar, useReviewSidebarTab } from "../../hooks/useReviewSidebar"
import type { PRInline } from "./DiffBody"
import { scrollToSidebarThread } from "./scrollToFile"

// Stable, so DiffBody's annotations stay put while nothing is inline.
const NO_THREADS: PRThread[] = []
const NO_IDS: number[] = []

/**
 * The diff view's PR review comments: the polled summary (counts, unread,
 * fingerprint), the threads positioned for the view on screen, whether
 * they've gone stale, and `&prcomment=<id>` on entry.
 *
 * The threads load once per view and per Refresh (`refresh`), never on
 * their own, so code never shifts under the reader: a summary fingerprint
 * that no longer matches the threads' raises Refresh instead. Unread state
 * comes from the summary alone, so it updates live.
 *
 * `ready` is false while a patch is loading: the threads wait for its revs,
 * so a Refresh that reloads the code fetches them once, for the new view.
 */
export function usePRCommentsView({
  path,
  view,
  ready,
  onJumpShown,
}: {
  path: string
  view: { oldRev: string; newRev: string } | undefined
  ready: boolean
  /** Goes to a thread the view shows (scrolls the diff to its inline card). */
  onJumpShown: (t: PRThread) => void
}) {
  const qc = useQueryClient()
  const [refreshKey, setRefreshKey] = useState(0)
  const summaryQ = usePRCommentsSummary(path)
  const threadsQ = usePRThreads(path, view, refreshKey, { enabled: view !== undefined && ready })
  const summary = summaryQ.data
  const threads = threadsQ.data
  // A load of its own, not the last one kept on screen meanwhile.
  const loaded = threads !== undefined && !threadsQ.isPlaceholderData
  const ok = summary?.state === "ok"
  const openThreads = ok ? summary.open_threads : 0
  const unreadComments = ok ? summary.unread_comments : 0

  // A threads load can be newer than the last summary poll: the summary
  // catches up at once, and until it has, the two aren't compared.
  const threadsAt = threadsQ.dataUpdatedAt
  useEffect(() => {
    if (loaded) void qc.invalidateQueries({ queryKey: ["pr-comments", path] })
  }, [loaded, threadsAt, qc, path])
  // Only two ok answers are compared: a failed or unavailable summary (a
  // GitHub blip) says nothing about whether the pinned threads are current.
  const stale =
    loaded &&
    summaryQ.dataUpdatedAt >= threadsAt &&
    summary?.state === "ok" &&
    threads.state === "ok" &&
    summary.fingerprint !== undefined &&
    threads.fingerprint !== undefined &&
    summary.fingerprint !== threads.fingerprint

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  const [show, setShow] = useShowPRComments()
  const unreadIds = useMemo(() => new Set(summary?.unread_ids ?? NO_IDS), [summary?.unread_ids])

  // The PR resource, for Mark all read: the worktree's resources query,
  // shared with the detail page under the same key.
  const prId = summary?.pr?.id
  const resources = useQuery({
    queryKey: ["resources", path],
    queryFn: () => api.worktreeResources(path),
    enabled: prId !== undefined,
  })
  const prResource: ResourceDTO | undefined = useMemo(
    () => (prId === undefined ? undefined : resources.data?.find((r) => r.type === "pr" && r.id === prId)),
    [resources.data, prId],
  )

  // What DiffBody places inline: nothing while the switch is off.
  const pr = threads?.pr ?? summary?.pr
  const inlineThreads = show && threads ? threads.threads : NO_THREADS
  const inline: PRInline | undefined = useMemo(
    () => (pr && inlineThreads.length > 0 ? { threads: inlineThreads, pr, unreadIds, prResource } : undefined),
    [pr, inlineThreads, unreadIds, prResource],
  )
  // The tree's dots, for the threads the diff shows.
  const files = useMemo(
    () => inlineThreads.filter((t) => t.view?.status === "shown").map((t) => t.file),
    [inlineThreads],
  )

  // `&prcomment=<id>`: the sidebar opens on the PR tab with the switch on,
  // then, once the threads are in, goes to the thread holding that comment
  // (its sidebar card when the diff doesn't show it), and the param goes.
  const diffView = useDiffView()
  const target = diffView.prComment
  const { dropPRComment } = diffView
  const [, setReviewOpen] = useReviewSidebar()
  const [, setTab] = useReviewSidebarTab()
  // Once per param value: a later `&prcomment` in the same view goes again.
  const opened = useRef<number | null>(null)
  useEffect(() => {
    if (target === null) {
      opened.current = null
      return
    }
    if (opened.current === target) return
    opened.current = target
    setShow(true)
    setReviewOpen(true)
    setTab("pr")
  }, [target, setShow, setReviewOpen, setTab])

  const jumpRef = useRef(onJumpShown)
  useEffect(() => {
    jumpRef.current = onJumpShown
  })
  // Outlives the param's removal; only leaving the view cancels it.
  const cancelSidebarScroll = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelSidebarScroll.current?.(), [])
  useEffect(() => {
    if (target === null || !loaded) return
    const t = threads.threads.find((x) => x.comments.some((c) => c.id === target))
    if (t?.view?.status === "shown") jumpRef.current(t)
    else if (t) {
      cancelSidebarScroll.current?.()
      cancelSidebarScroll.current = scrollToSidebarThread(t.id)
    }
    dropPRComment()
  }, [target, loaded, threads, dropPRComment])

  return {
    summary,
    threads,
    prResource,
    openThreads,
    unreadComments,
    /**
     * Whether DiffView's entry check may close a remembered-open sidebar
     * with nothing to show: the view's own threads are in (or failed), and
     * no `&prcomment` that opened it is still being handled.
     */
    settled: (loaded || threadsQ.isError) && target === null,
    stale,
    refresh,
    inline,
    files,
  }
}
