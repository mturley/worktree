import { useSyncExternalStore } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import type { PRCommentsSummary, PRThreads } from "../api/types"

const POLL_MS = 5000

/** Counts and unread state for the worktree's PR; polled so unread updates live. */
export function usePRCommentsSummary(path: string) {
  return useQuery<PRCommentsSummary>({
    queryKey: ["pr-comments", path],
    queryFn: () => api.prComments(path),
    refetchInterval: POLL_MS,
  })
}

/**
 * The PR's threads, positioned for the view. Never refetches on its own: the
 * refreshKey (bumped by the user's Refresh) is the only thing that reloads, so
 * code never shifts under the reader.
 */
export function usePRThreads(
  path: string,
  view: { oldRev: string; newRev: string } | undefined,
  refreshKey: number,
  opts: { enabled?: boolean } = {},
) {
  return useQuery<PRThreads>({
    queryKey: ["pr-threads", path, view?.oldRev, view?.newRev, refreshKey],
    queryFn: () => api.prThreads(path, view),
    staleTime: Infinity,
    enabled: opts.enabled ?? true,
  })
}

export const SHOW_PR_COMMENTS_KEY = "worktree.showPRComments"

const listeners = new Set<() => void>()
/** This page view's value for when storage is blocked. */
let fallback = true

function read(): boolean {
  try {
    const v = window.localStorage.getItem(SHOW_PR_COMMENTS_KEY)
    return v === null ? true : v === "true"
  } catch {
    return fallback
  }
}

function write(on: boolean): void {
  fallback = on
  try {
    window.localStorage.setItem(SHOW_PR_COMMENTS_KEY, on ? "true" : "false")
  } catch {
    // Storage blocked or full: the choice lasts for this page view.
  }
  listeners.forEach((l) => l())
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

/** Whether PR comments show inline in the diff; remembered across sessions. */
export function useShowPRComments(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, read), write]
}
