import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"

/**
 * Every followed resource, across worktrees. Keyed under "resources" so every
 * existing invalidation of resource state (new events over SSE, mark-read,
 * notify toggles) refreshes this list too; no worktree path is "__all__".
 */
export function useAllResources() {
  return useQuery({ queryKey: ["resources", "__all__"], queryFn: api.allResources })
}
