import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"
import type { ResourceDTO } from "../api/types"

/**
 * One of a worktree's resources, by type and id. Reads the same query as
 * `useWorktreeDetail`, so the two share a cache entry. Undefined while the
 * list loads, when `id` is not given, or when the worktree does not follow it.
 */
export function useWorktreeResource(path: string, type: string, id?: string): ResourceDTO | undefined {
  const resources = useQuery({
    queryKey: ["resources", path],
    queryFn: () => api.worktreeResources(path),
    enabled: !!path && !!id,
  })
  if (!id) return undefined
  return resources.data?.find((r) => r.type === type && r.id === id)
}
