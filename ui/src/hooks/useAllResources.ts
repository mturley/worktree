import { useQuery } from "@tanstack/react-query"
import { api } from "../api/client"

/**
 * Every followed resource, across worktrees. Keyed under "resources" so every
 * existing invalidation of resource state (new events over SSE, mark-read,
 * notify toggles) refreshes this list too; no worktree path is "__all__".
 */
export function useAllResources() {
  return useQuery({ queryKey: ["resources", "__all__"], queryFn: () => api.allResources() })
}

/**
 * Live resources followed by the archived ones (no worktree follows them any
 * more). Fetched only while `enabled`: the search dropdown's Include archived
 * is on. Callers keep the rows marked `archived`.
 */
export function useArchivedResources(enabled: boolean) {
  return useQuery({
    queryKey: ["resources", "__archived__"],
    queryFn: () => api.allResources({ archived: true }),
    enabled,
  })
}
