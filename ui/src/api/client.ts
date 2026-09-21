import type { CmuxGroupsResponse, CmuxResponse, CreateWorktreeResponse, DeleteWorktreeResponse, Repo, ResourceDTO, SaveWorktreeNotesResponse, SessionInfo, TimelineResponse, WatchersResponse, WorktreeInfo, WorktreeNotes, WorktreeSummary } from "./types"

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "HttpError"
  }
}

/** Fired when a request is refused because the user must log in. */
export const LOGIN_REQUIRED_EVENT = "worktree:login-required"

/**
 * Reports a login-required response to the app, and returns whether it was
 * one. Only a 401 carrying X-Worktree-Login-Required counts: some Slack
 * endpoints return 401 for Slack's own credentials, which is not a reason to
 * show the login screen.
 */
export function reportIfLoginRequired(res: Response): boolean {
  if (res.status !== 401 || res.headers?.get("X-Worktree-Login-Required") !== "1") return false
  window.dispatchEvent(new Event(LOGIN_REQUIRED_EVENT))
  return true
}

async function fetchJSON<T>(url: string, init?: RequestInit, opts: { reportLoginRequired?: boolean } = {}): Promise<T> {
  const res = await fetch(url, init)
  if (opts.reportLoginRequired !== false) reportIfLoginRequired(res)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new HttpError((data && data.error) || `HTTP ${res.status}`, res.status)
  return data as T
}

export const api = {
  // session and login must not report login-required: the session query
  // refetches on that event, so reporting from here would loop.
  session: () => fetchJSON<SessionInfo>("/api/session", undefined, { reportLoginRequired: false }),
  login: (password: string) =>
    fetchJSON<SessionInfo>("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }, { reportLoginRequired: false }),
  sessions: () => fetchJSON<SessionInfo[]>("/api/sessions"),
  revokeSession: (handle: string) =>
    fetchJSON<{ ok: boolean }>("/api/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    }),
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
    fetchJSON<{ polled: boolean }>(`/api/worktrees/poll?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }),
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
  cmuxGroups: () => fetchJSON<CmuxGroupsResponse>("/api/cmux-groups"),
  cmuxCreate: (args: { path: string; name: string; group_ref?: string; color?: string }) =>
    fetchJSON<{ ok: boolean; ref?: string; error?: string }>("/api/cmux/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  cmux: () => fetchJSON<CmuxResponse>("/api/cmux"),
  worktreeNotes: (path: string) =>
    fetchJSON<WorktreeNotes>(`/api/worktree-notes?path=${encodeURIComponent(path)}`),
  // keepalive lets a save started while the page unloads still complete.
  saveWorktreeNotes: (args: { path: string; notes: string; sync_cmux: boolean }, opts: { keepalive?: boolean } = {}) =>
    fetchJSON<SaveWorktreeNotesResponse>("/api/worktree-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      keepalive: opts.keepalive,
    }),
  repos: () => fetchJSON<Repo[]>("/api/repos"),
  repoDotfiles: (repoRoot: string) =>
    fetchJSON<string[]>(`/api/repo-dotfiles?repo_root=${encodeURIComponent(repoRoot)}`),
  createWorktree: (args: {
    input: string
    repo_root: string
    pull: boolean
    copy_dotfiles: boolean
    reuse_branch?: boolean
    reset_to_pr?: boolean
    decline_reset?: boolean
  }) =>
    fetchJSON<CreateWorktreeResponse>("/api/worktrees/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  markResourceRead: (args: { type: string; id: string; through_ts: string }) =>
    fetchJSON<null>("/api/resource-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  watchers: () => fetchJSON<WatchersResponse>("/api/watchers"),
  pollWatchers: () =>
    fetchJSON<null>("/api/watchers/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }),
  resolveResource: (args: { type: string; id: string }) =>
    fetchJSON<ResourceDTO>("/api/resource-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  resourceType: (url: string) =>
    fetchJSON<{ type: string; id: string }>(`/api/resource-type?url=${encodeURIComponent(url)}`),
  cmuxSelect: (ref: string) =>
    fetchJSON<{ ok: boolean; error?: string }>("/api/cmux/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    }),
}
