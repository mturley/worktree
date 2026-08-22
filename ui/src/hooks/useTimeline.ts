import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
export function useGlobalTimeline(archived: boolean) {
  return useQuery({ queryKey: ["timeline", "global", archived], queryFn: () => api.globalTimeline(archived) })
}
export function useWorktreeTimeline(path: string, resource?: { type: string; id: string }) {
  // The resource is part of the key so switching selection is a normal
  // cache-keyed fetch and switching back to unfiltered is a cache hit.
  const key = resource ? `${resource.type}:${resource.id}` : ""
  return useQuery({
    queryKey: ["timeline", "worktree", path, key],
    queryFn: () => api.worktreeTimeline(path, 100, resource),
    enabled: !!path,
  })
}
