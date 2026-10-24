import type { NewReviewComment, ReviewComment, ReviewCommentItem, DiffBase, DiffCommits, DiffFiles, DiffPatch, DiffRange, WorktreeGit, AllResourceDTO, CmuxActionResult, CmuxBrowserTabsResponse, CmuxFocusMsg, CmuxGroupsResponse, CmuxMove, CmuxPeek, CmuxResponse, CmuxTabRef, CmuxTreeResponse, CreateWorktreeResponse, CredResult, DefaultBranchResponse, CredService, DeleteWorktreeResponse, LinkedResourcesDTO, LinkedTreeNode, NotifyMode, PollLogResponse, Repo, ResourceDTO, ResourceReadChange, SaveWorktreeNotesResponse, SessionInfo, Settings, TimelineResponse, UpdateStatus, WatcherHealth, WatchersResponse, WatchedResourceStatus, WatcherLogQuery, WatcherAuthSettings, WatcherConfigSettings, WorktreeInfo, WorktreeNotes, WorktreeSettings, WorktreeSummary } from "./types"

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
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
  // 204 has no body: nothing to parse, and callers of those endpoints ignore the value.
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) throw new HttpError((data && data.error) || `HTTP ${res.status}`, res.status, data ?? undefined)
  return data as T
}

/** Like fetchJSON, for endpoints that return raw text; errors are still JSON. */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  reportIfLoginRequired(res)
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new HttpError((data && data.error) || `HTTP ${res.status}`, res.status)
  }
  return res.text()
}

function diffParams(path: string, base: DiffBase, range?: DiffRange): URLSearchParams {
  const params = new URLSearchParams({ path, base })
  // "all" (or no range) sends neither: the server reads that as All changes.
  if (range && range !== "all") {
    params.set("from", range.from)
    params.set("to", range.to)
  }
  return params
}

function cmuxPost(url: string, body: unknown) {
  return fetchJSON<CmuxActionResult>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function putJSON<T>(url: string, body: unknown) {
  return fetchJSON<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function postJSON<T>(url: string, body: unknown) {
  return fetchJSON<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

export const api = {
  linkedResources: (type: string, id: string, opts: { resolveLinks?: boolean; refresh?: boolean } = {}) => {
    const params = new URLSearchParams({ type, id })
    if (opts.resolveLinks) params.set("resolve_links", "1")
    if (opts.refresh) params.set("refresh", "1")
    return fetchJSON<LinkedResourcesDTO>(`/api/linked-resources?${params}`)
  },
  linkedChildren: (key: string) =>
    fetchJSON<{ items: LinkedTreeNode[]; more: { url: string } | null }>(
      `/api/linked-resources/children?key=${encodeURIComponent(key)}`,
    ),
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
  settings: () => fetchJSON<Settings>("/api/settings"),
  updateStatus: () => fetchJSON<UpdateStatus>("/api/update-status"),
  watcherHealth: () => fetchJSON<WatcherHealth>("/api/watchers/health"),
  saveWorktreeSettings: (s: WorktreeSettings) => putJSON<Settings>("/api/settings/worktree", s),
  saveWatcherAuthSettings: (s: WatcherAuthSettings) => putJSON<Settings>("/api/settings/watcher-auth", s),
  saveWatcherConfigSettings: (s: WatcherConfigSettings) => putJSON<Settings>("/api/settings/watcher-config", s),
  testCredential: (svc: CredService, override: { host?: string; email?: string; token?: string; cookie?: string } = {}) =>
    fetchJSON<CredResult>(`/api/settings/credentials/${svc}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(override),
    }),
  /**
   * Validate-then-write. A refused credential comes back as a 422 whose body
   * is a CredResult; it is returned (ok: false), not thrown, so the field can
   * say why.
   */
  replaceCredential: async (svc: CredService, body: { token?: string; cookie?: string; host?: string; email?: string }) => {
    const res = await fetch(`/api/settings/credentials/${svc}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    reportIfLoginRequired(res)
    const data = await res.json().catch(() => null)
    if (res.ok || res.status === 422) return data as CredResult
    throw new HttpError((data && data.error) || `HTTP ${res.status}`, res.status)
  },
  replacePassword: async (password: string) => {
    const res = await fetch("/api/settings/password", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
    reportIfLoginRequired(res)
    if (!res.ok) {
      const data = await res.json().catch(() => null)
      throw new HttpError((data && data.error) || `HTTP ${res.status}`, res.status)
    }
  },
  worktrees: () => fetchJSON<WorktreeSummary[]>("/api/worktrees"),
  allResources: () => fetchJSON<AllResourceDTO[]>("/api/all-resources"),
  /**
   * One notification toggle: worktree-wide without type/id, else one
   * resource. Turning one on makes the server send a test notification,
   * starting with this tab when `tab` is given.
   */
  setNotify: (args: { path: string; type?: string; id?: string; on: boolean; tab?: string }) =>
    fetchJSON<{ ok: boolean; mode: NotifyMode }>("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  tabPresence: (args: { tab: string; route: string; visible: boolean }) =>
    fetchJSON<null>("/api/tabs/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  tabAck: (args: { tab: string; notification_id: string; shown: boolean }) =>
    fetchJSON<null>("/api/tabs/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  globalTimeline: (
    archived: boolean,
    limit = 100,
    before?: string,
    resourceTypes?: string[],
    unreadOnly = false,
    eventTypes?: string[],
    q?: string,
  ) => {
    const params = new URLSearchParams({ archived: String(archived), limit: String(limit) })
    if (before) params.set("before", before)
    if (resourceTypes?.length) params.set("resource_types", resourceTypes.join(","))
    if (eventTypes?.length) params.set("event_types", eventTypes.join(","))
    if (unreadOnly) params.set("unread_only", "true")
    if (q) params.set("q", q)
    return fetchJSON<TimelineResponse>(`/api/timeline?${params.toString()}`)
  },
  worktreeTimeline: (
    path: string,
    limit = 100,
    resource?: { type: string; id: string },
    before?: string,
    resourceTypes?: string[],
    unreadOnly = false,
    eventTypes?: string[],
    q?: string,
  ) => {
    const params = new URLSearchParams({ path, limit: String(limit) })
    if (resource) {
      params.set("resource_type", resource.type)
      params.set("resource_id", resource.id)
    }
    if (before) params.set("before", before)
    if (resourceTypes?.length) params.set("resource_types", resourceTypes.join(","))
    if (eventTypes?.length) params.set("event_types", eventTypes.join(","))
    if (unreadOnly) params.set("unread_only", "true")
    if (q) params.set("q", q)
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
  addResource: (args: { path: string; url: string; related?: boolean; position?: "top" | "bottom" }) =>
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
  /**
   * Persists the user's card order. Both groups are sent in full so the call
   * describes the order rather than a move: replaying it is harmless, and two
   * devices dragging at once settle on last-writer-wins.
   */
  setResourceOrder: (args: {
    path: string
    focus: { type: string; id: string }[]
    related: { type: string; id: string }[]
  }) =>
    fetchJSON<null>("/api/worktree-resources/order", {
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
  worktreeGit: (path: string, fetch: boolean) => {
    const params = new URLSearchParams({ path })
    if (fetch) params.set("fetch", "1")
    return fetchJSON<WorktreeGit>(`/api/worktree-git?${params}`)
  },
  diffCommits: (path: string, base: DiffBase) =>
    fetchJSON<DiffCommits>(`/api/worktree-diff/commits?${diffParams(path, base)}`),
  diffFiles: (path: string, base: DiffBase, range: DiffRange) =>
    fetchJSON<DiffFiles>(`/api/worktree-diff/files?${diffParams(path, base, range)}`),
  diffPatch: (path: string, base: DiffBase, range: DiffRange, ignoreWs: boolean) => {
    const params = diffParams(path, base, range)
    if (ignoreWs) params.set("ignore_ws", "1")
    return fetchJSON<DiffPatch>(`/api/worktree-diff/patch?${params}`)
  },
  reviewComments: (path: string, view?: { oldRev: string; newRev: string }) => {
    const params = new URLSearchParams({ path })
    if (view) {
      params.set("old_rev", view.oldRev)
      params.set("new_rev", view.newRev)
    }
    return fetchJSON<{ comments: ReviewCommentItem[] }>(`/api/review-comments?${params}`)
  },
  createReviewComment: (req: NewReviewComment) => postJSON<ReviewComment>("/api/review-comments", req),
  updateReviewComment: (req: { path: string; id: number; version: number; body: string }) =>
    postJSON<ReviewComment>("/api/review-comments/update", req),
  deleteReviewComment: (path: string, id: number) => postJSON<void>("/api/review-comments/delete", { path, id }),
  clearReviewComments: (path: string) => postJSON<void>("/api/review-comments/clear", { path }),
  diffFileContents: (path: string, rev: string, file: string) =>
    fetchText(`/api/worktree-diff/file?${new URLSearchParams({ path, rev, file })}`),
  openInEditor: (path: string, file?: string) =>
    fetchJSON<{ ok: boolean }>("/api/worktrees/open-editor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(file === undefined ? { path } : { path, file }),
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
  saveWorktreeNotes: (args: { path: string; notes: string; sync_cmux: boolean; show_on_home: boolean }, opts: { keepalive?: boolean } = {}) =>
    fetchJSON<SaveWorktreeNotesResponse>("/api/worktree-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      keepalive: opts.keepalive,
    }),
  repos: () => fetchJSON<Repo[]>("/api/repos"),
  repoDotfiles: (repoRoot: string) =>
    fetchJSON<string[]>(`/api/repo-dotfiles?repo_root=${encodeURIComponent(repoRoot)}`),
  defaultBranch: (input: string, repoRoot: string) =>
    fetchJSON<DefaultBranchResponse>(
      `/api/worktrees/default-branch?input=${encodeURIComponent(input)}&repo_root=${encodeURIComponent(repoRoot)}`,
    ),
  createWorktree: (args: {
    input: string
    repo_root: string
    pull: boolean
    copy_dotfiles: boolean
    branch?: string
    reuse_branch?: boolean
    reset_to_pr?: boolean
    decline_reset?: boolean
  }) =>
    fetchJSON<CreateWorktreeResponse>("/api/worktrees/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  /** Moves a cursor forward, answering where it was so the move can be undone. */
  markResourceRead: (args: { type: string; id: string; through_ts: string }) =>
    fetchJSON<ResourceReadChange>("/api/resource-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }),
  /**
   * Undoes a markResourceRead, given what it answered. 409 when the cursor
   * has moved on since — a later read is never rewound past.
   */
  restoreResourceRead: (args: { type: string; id: string } & ResourceReadChange) =>
    fetchJSON<null>("/api/resource-read/restore", {
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
  watchedResources: () =>
    fetchJSON<{ resources: WatchedResourceStatus[] }>("/api/watchers/resources"),
  watcherLog: (q: WatcherLogQuery) => {
    const p = new URLSearchParams()
    if (q.source) p.set("source", q.source)
    if (q.level && q.level !== "info") p.set("level", q.level)
    if (q.after_id) p.set("after_id", String(q.after_id))
    if (q.before_id) p.set("before_id", String(q.before_id))
    if (q.limit) p.set("limit", String(q.limit))
    return fetchJSON<PollLogResponse>(`/api/watchers/log?${p}`)
  },
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
  cmuxFocused: () => fetchJSON<CmuxFocusMsg>("/api/cmux/focused"),
  cmuxBrowserTabs: () => fetchJSON<CmuxBrowserTabsResponse>("/api/cmux/browser-tabs"),
  cmuxTree: (path: string) => fetchJSON<CmuxTreeResponse>(`/api/cmux/tree?path=${encodeURIComponent(path)}`),
  cmuxPeek: (id: string, surface: string) =>
    fetchJSON<CmuxPeek>(`/api/cmux/peek?id=${encodeURIComponent(id)}&surface=${encodeURIComponent(surface)}`),
  cmuxRename: (id: string, title: string) => cmuxPost("/api/cmux/rename", { id, title }),
  cmuxColor: (id: string, color: string) => cmuxPost("/api/cmux/color", { id, color }),
  cmuxFocusTab: (id: string, surface: string) => cmuxPost("/api/cmux/focus-tab", { id, surface }),
  cmuxCloseTab: (id: string, tab: CmuxTabRef) => cmuxPost("/api/cmux/close-tab", { id, ...tab }),
  cmuxMoveTab: (id: string, move: CmuxMove) => cmuxPost("/api/cmux/move-tab", { id, ...move }),
}
