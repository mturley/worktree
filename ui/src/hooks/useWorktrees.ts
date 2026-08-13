import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
export function useWorktrees() {
  return useQuery({ queryKey: ["worktrees"], queryFn: api.worktrees })
}
