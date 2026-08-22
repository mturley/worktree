import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
export function useGlobalTimeline(archived: boolean) {
  return useQuery({ queryKey: ["timeline", "global", archived], queryFn: () => api.globalTimeline(archived) })
}
export function useWorktreeTimeline(path: string, resource?: { type: string; id: string }) {
  // The resource is part of the key so switching selection is a normal
  // cache-keyed fetch and switching back to unfiltered is a cache hit. Kept
  // as separate array elements (not a collapsed `${type}:${id}` string) so
  // the key composes cleanly with query-key matching elsewhere.
  return useQuery({
    queryKey: ["timeline", "worktree", path, resource?.type ?? "", resource?.id ?? ""],
    queryFn: () => api.worktreeTimeline(path, 100, resource),
    enabled: !!path,
  })
}
