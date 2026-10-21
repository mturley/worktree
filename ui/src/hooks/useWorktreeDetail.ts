import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import { useWorktreeTimeline } from "./useTimeline"

export function useWorktreeDetail(
  path: string,
  resourceTypes: string[] = [],
  unreadOnly = false,
  eventTypes: string[] = [],
  q = "",
) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!path) return
    // poll-on-view-if-stale, then refresh resources + timeline
    api.pollWorktree(path).then((res) => {
      if (res.polled) {
        qc.invalidateQueries({ queryKey: ["timeline", "worktree", path] })
        qc.invalidateQueries({ queryKey: ["resources", path] })
      }
    }).catch(() => {})
  }, [path, qc])

  const resources = useQuery({ queryKey: ["resources", path], queryFn: () => api.worktreeResources(path), enabled: !!path })
  const timeline = useWorktreeTimeline(path, undefined, resourceTypes, unreadOnly, eventTypes, q)
  // For changes to which resources are followed or how they are grouped.
  // Those also change which tasks belong to the worktree and to each
  // resource, so the task lists refetch along with the resources.
  const refreshResources = async () => {
    void qc.invalidateQueries({ queryKey: ["tasks"] })
    return resources.refetch()
  }
  return { resources, timeline, refreshResources }
}
