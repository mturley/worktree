import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
export function useGlobalTimeline(archived: boolean) {
  return useQuery({ queryKey: ["timeline", "global", archived], queryFn: () => api.globalTimeline(archived) })
}
export function useWorktreeTimeline(path: string) {
  return useQuery({ queryKey: ["timeline", "worktree", path], queryFn: () => api.worktreeTimeline(path), enabled: !!path })
}
