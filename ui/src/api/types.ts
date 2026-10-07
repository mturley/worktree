export interface CmuxWorkspace {
  ref: string
  title: string
  color?: string
  selected: boolean
  /**
   * Position in cmux's workspace list (its sidebar order). Absent on an older
   * cached response; consumers treat that as "no position".
   */
  index?: number
}

export interface CmuxResponse {
  available: boolean
  matches?: Record<string, CmuxWorkspace[]>
}

export interface WorktreeSummary {
  path: string; repo: string; branch: string;
  on_disk: boolean; resource_count: number; primary_count: number; latest_event_ts: string;
  primary_by_type: Record<string, number>; related_count: number;
  /** Related resources by type; absent on an older cached response. */
  related_by_type?: Record<string, number>;
  /** Primary ("focus") resources, enriched. Always an array — never null. */
  focus_resources: ResourceDTO[];
  /**
   * Whether ANY resource on this worktree has unread activity — related ones
   * included, which is why it cannot be derived from `focus_resources`.
   * Absent on an older cached response.
   */
  has_unread?: boolean;
  /**
   * Sum of `unread_count` across the worktree's resources, Slack threads
   * included. Non-zero whenever `has_unread` is (an unread thread counts at
   * least 1); absent on an older cached response.
   */
  unread_count?: number;
  /**
   * The registry's creation time, verbatim — RFC3339 for anything made by
   * `worktree add`, but not guaranteed, so parse defensively. Absent on an
   * older cached response.
   */
  created_at?: string;
  /** The worktree-wide "Notify on all" toggle. Absent on an older cached response. */
  notify_all?: boolean;
}
export interface TimelineEvent {
  id: string; ts: string; external_ts: string; source: string;
  type: string; type_label: string; title: string; body: string; author: string;
  resource_type: string; resource_id: string; resource_url: string; resource_title: string;
  worktrees: string[];
  /**
   * Paths for `worktrees`, same order. The UI routes by path, and branch
   * names are not unique across repos, so it cannot derive one from the other.
   */
  worktree_paths?: string[];
  /**
   * The event's resource, enriched from cached state exactly as the resource
   * cards are. Lets the global timeline — which has no per-worktree resource
   * list — render a real status icon and custom name.
   */
  resource?: ResourceDTO;
  /**
   * Newer than this event's resource read cursor. Always false for Slack —
   * the thread owns that state, and it shows on the resource chip instead.
   */
  unread?: boolean;
}
export interface TimelineResponse { events: TimelineEvent[]; next_cursor: string }
export interface ResourceDTO {
  type: string; id: string; url: string; primary: boolean
  /** This resource's own notification toggle; the effective state is `notify || worktree.notify_all`. */
  notify?: boolean
  // enriched from cached watcher state; absent if the resource was never polled
  title?: string
  channel_name?: string
  /** slack: unread as of the last poll; drives the unread dot. */
  has_unread?: boolean
  /**
   * Events newer than the read cursor. Absent means zero. For a Slack thread,
   * the replies newer than Slack's cursor — at least 1 while `has_unread`, and
   * 0 whenever it is false, so the count and the dot always agree.
   */
  unread_count?: number
  /**
   * non-slack: ts of the newest of those unread events, from the same server
   * snapshot. Sent as through_ts by "mark all read" — see MarkAllReadButton.
   */
  unread_through_ts?: string
  created_ts?: string
  updated_ts?: string
  state?: string
  review_decision?: string
  ci_status?: string
  new_commits_since_review?: boolean
  author?: string
  status?: string
  priority?: string
  issue_type?: string
  /** URL of the icon Jira serves for this issue type; fetch via jiraIconProxy(). */
  issue_type_icon_url?: string
  assignee?: string
  labels?: string[]
  updated_at?: string
  custom_name?: string
  custom_description?: string
  /** link: resolved page metadata. */
  description?: string
  image?: string
  site_name?: string
  favicon?: string
  /** link: whether the page's headers permit rendering it in an iframe. */
  embeddable?: boolean
  resolve_error?: string
}

export interface GitStatus {
  branch: string
  upstream?: string
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
}
export interface EnvVar { key: string; value: string }
/** GET /api/worktree-info — detail-page-only; git status costs a subprocess. */
export interface WorktreeInfo { env: EnvVar[]; git?: GitStatus }

export interface WorktreeNotes { notes: string; sync_cmux: boolean; updated_at?: string }
/** How a notes save's mirror to the cmux workspace description went. */
export type CmuxSyncOutcome = "off" | "ok" | "skipped" | "failed"
export interface SaveWorktreeNotesResponse extends WorktreeNotes {
  cmux_sync: CmuxSyncOutcome
  cmux_error?: string
}

export type DeleteStepStatus = "done" | "skipped" | "failed" | "needs_force" | "pending"
export interface DeleteStep {
  key: string
  label: string
  status: DeleteStepStatus
  detail?: string
}
export interface DeleteWorktreeResponse {
  ok: boolean
  /** "" when nothing is waiting; otherwise the step key needing a force. */
  needs_force: string
  steps: DeleteStep[]
  error?: string
}

export interface CmuxGroup { ref: string; name: string }
export interface CmuxColor { name: string; hex: string }
export interface CmuxGroupsResponse { groups: CmuxGroup[]; colors: CmuxColor[] }

export interface Repo { name: string; repo_root: string }

export interface CreateConfirm {
  key: "reuse_branch" | "reset_to_pr"
  branch: string
  local_head?: string
  remote_head?: string
}

export interface CreateStep {
  key: string
  label: string
  status: "done" | "skipped" | "failed" | "pending"
  detail?: string
}

export interface CreateWorktreeResponse {
  ok: boolean
  confirm: CreateConfirm | null
  steps: CreateStep[]
  path?: string
  branch?: string
  error?: string
}

export interface WatcherStatus {
  /** Poller name: "github" | "jira" | "slack". */
  name: string;
  /** The resource type the source filter uses — "pr" for the GitHub poller. */
  type: string;
  /**
   * Last run that completed without error, RFC3339. Absent when the poller
   * has never succeeded, which the UI shows as no annotation rather than
   * "never" — on a fresh install nothing is wrong yet.
   */
  last_success?: string;
  /** The poller is currently failing: its last error is newer than its last success. */
  has_error?: boolean;
  error_message?: string;
}

export interface WatchersResponse {
  watchers: WatcherStatus[];
  /**
   * A poll is running right now. Server-wide rather than per watcher: the
   * three pollers run sequentially under one guard, so there is no moment
   * when one is fetching and the others are independently answerable.
   */
  polling: boolean;
}

/** A web UI login session, as GET /api/session(s) returns it. */
/** How the server delivers notifications: `cmux notify`, or browser tabs. */
export type NotifyMode = "cmux" | "browser"

/**
 * The `cmux_focus` stream message: cmux focused another workspace. `path` is
 * the first registered worktree open in it, or "" when there is none.
 */
export interface CmuxFocusMsg {
  workspace_id: string
  path: string
}

/** The `notification` stream message: shown by exactly one tab per session. */
export interface NotificationMsg {
  id: string
  title: string
  subtitle: string
  body: string
  /** Empty for a burst summary spanning several worktrees. */
  worktree_path: string
  /** Empty for a worktree-wide test notification or a summary. */
  resource_type: string
  resource_id: string
  tag: string
}

export interface SessionInfo {
  /** Hash of the session token: safe to show, and what revoking takes. */
  handle: string
  label: string
  created_at: string
  last_seen_at: string
  current: boolean
  /** The server's notification delivery path; only on GET /api/session. */
  notify_mode?: NotifyMode
}

/** A node of a cmux workspace's split layout: a pane leaf, or a two-way split. */
export interface CmuxLayout {
  pane?: string
  direction?: "horizontal" | "vertical"
  /** The first child's share, 0..1. */
  split?: number
  children?: [CmuxLayout, CmuxLayout]
}

export interface CmuxTab {
  ref: string
  title: string
  /** "terminal" | "browser" | "markdown" | anything newer cmux adds. */
  type: string
  /** Absent for terminals and for browser tabs that have not loaded. */
  url?: string
  selected: boolean
  /** Has an unread cmux notification (from `notification.list`). */
  unread?: boolean
}

export interface CmuxPane { ref: string; focused: boolean; tabs: CmuxTab[] }

export interface CmuxTreeWorkspace {
  /** cmux's UUID: what every write addresses. */
  id: string
  ref: string
  title: string
  color?: string
  selected: boolean
  layout?: CmuxLayout
  panes?: CmuxPane[]
  /** Set, with no layout/panes, when this workspace's tree could not be read. */
  error?: string
}

export interface CmuxTreeResponse { available: boolean; workspaces: CmuxTreeWorkspace[] }

export interface CmuxActionResult { ok: boolean; error?: string; stale?: boolean }

/** A tab as the user saw it, so the server can check it is still that tab. */
export interface CmuxTabRef { surface: string; type: string; title: string }

export interface CmuxMove extends CmuxTabRef {
  pane: string
  /** Absent: the end of `pane`. */
  anchor?: CmuxTabRef & { position: "before" | "after" }
}
