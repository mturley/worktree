import type { WorktreeSummary, TimelineResponse, ResourceDTO } from "./types"

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data as T
}

export const api = {
  worktrees: () => fetchJSON<WorktreeSummary[]>("/api/worktrees"),
  globalTimeline: (archived: boolean, limit = 100, before?: string) =>
    fetchJSON<TimelineResponse>(
      `/api/timeline?archived=${archived}&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  worktreeTimeline: (path: string, limit = 100) =>
    fetchJSON<TimelineResponse>(`/api/worktree-timeline?path=${encodeURIComponent(path)}&limit=${limit}`),
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
  removeResource: (args: { path: string; type: string; id: string }) =>
    fetchJSON<null>("/api/worktree-resources/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
}
