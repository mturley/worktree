import { useEffect } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

export function useWorktreeDetail(path: string) {
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
  const timeline = useQuery({ queryKey: ["timeline", "worktree", path], queryFn: () => api.worktreeTimeline(path), enabled: !!path })
  return { resources, timeline }
}
