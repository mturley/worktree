import type { WorktreeSummary, TimelineResponse, ResourceDTO, WorktreeInfo, DeleteWorktreeResponse } from "./types"

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data as T
}

export const api = {
  worktrees: () => fetchJSON<WorktreeSummary[]>("/api/worktrees"),
  globalTimeline: (archived: boolean, limit = 100, before?: string, resourceTypes?: string[]) => {
    const params = new URLSearchParams({ archived: String(archived), limit: String(limit) })
    if (before) params.set("before", before)
    if (resourceTypes?.length) params.set("resource_types", resourceTypes.join(","))
    return fetchJSON<TimelineResponse>(`/api/timeline?${params.toString()}`)
  },
  worktreeTimeline: (
    path: string,
    limit = 100,
    resource?: { type: string; id: string },
    before?: string,
    resourceTypes?: string[],
  ) => {
    const params = new URLSearchParams({ path, limit: String(limit) })
    if (resource) {
      params.set("resource_type", resource.type)
      params.set("resource_id", resource.id)
    }
    if (before) params.set("before", before)
    if (resourceTypes?.length) params.set("resource_types", resourceTypes.join(","))
    return fetchJSON<TimelineResponse>(`/api/worktree-timeline?${params.toString()}`)
  },
  worktreeInfo: (path: string) =>
    fetchJSON<WorktreeInfo>(`/api/worktree-info?path=${encodeURIComponent(path)}`),
  worktreeResources: (path: string) =>
    fetchJSON<ResourceDTO[]>(`/api/worktree-resources?path=${encodeURIComponent(path)}`),
  pollWorktree: (path: string) =>
    fetchJSON<{ polled: boolean }>(`/api/worktrees/poll?path=${encodeURIComponent(path)}`, { method: "POST" }),
  setResourceMeta: (args: { type: string; id: string; name: string; description: string }) =>
    fetchJSON<null>("/api/resource-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  addResource: (args: { path: string; url: string; related?: boolean }) =>
    fetchJSON<ResourceDTO>("/api/worktree-resources/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  setResourcePrimary: (args: { path: string; type: string; id: string; primary: boolean }) =>
    fetchJSON<null>("/api/worktree-resources/primary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  removeResource: (args: { path: string; type: string; id: string }) =>
    fetchJSON<null>("/api/worktree-resources/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  deleteWorktree: (args: {
    path: string
    delete_branch?: boolean
    force_directory?: boolean
    force_branch?: boolean
  }) =>
    fetchJSON<DeleteWorktreeResponse>("/api/worktrees/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
}
