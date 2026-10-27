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
  /** Open (not done) tasks linked to this worktree, directly or via a followed resource. */
  open_task_count?: number;
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
  /** The worktree's notes (Markdown), present only when non-blank and shown on the home page. */
  notes?: string;
  /** The notes as the search index sees them; absent when there are none. */
  notes_search?: string;
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
   * A task event whose task is archived (it has links and every one is gone).
   * Absent for watcher events, whose archived state is "no worktree follows".
   */
  archived?: boolean;
  /**
   * The state a task event left its task in (a state change's new state, or
   * not started for a creation): the feed draws that checkbox for it.
   */
  task_state?: TaskState;
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
  /** Why the event matched the search (`q`); absent without one. */
  match?: { field: string; snippet: string };
  /** Task activity feed only: this event is linked to the task. */
  linked_to_task?: boolean;
  /**
   * Task activity feed only, with linked_to_task: the key the event is linked
   * under, to unlink it by (a Slack message's slack: key, else its ev: key).
   */
  linked_key?: string;
}
export interface TimelineResponse { events: TimelineEvent[]; next_cursor: string }
export interface ResourceDTO {
  /** Open tasks linked to this resource. */
  open_task_count?: number
  /** Open tasks this resource blocks, unresolved blockers only. */
  blocks_count?: number
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
   * The part of unread_count that is unread events of the tasks linking this
   * resource. For a Slack thread, has_unread stays Slack's own verdict and
   * never includes these, so hasUnread counts them separately.
   */
  task_unread_count?: number
  /**
   * non-slack: ts of the newest of those unread events, from the same server
   * snapshot. Sent as through_ts by "mark all read" — see MarkAllReadButton.
   */
  unread_through_ts?: string
  created_ts?: string
  updated_ts?: string
  /** slack: Slack's read cursor as of the last poll; absent if never read. */
  last_read?: string
  state?: string
  review_decision?: string
  ci_status?: string
  new_commits_since_review?: boolean
  author?: string
  status?: string
  priority?: string
  /** URL of the icon Jira serves for this priority; fetch via jiraIconProxy(). */
  priority_icon_url?: string
  issue_type?: string
  /** URL of the icon Jira serves for this issue type; fetch via jiraIconProxy(). */
  issue_type_icon_url?: string
  assignee?: string
  /** jira: the issue's reporter. Absent when unset or never polled. */
  reporter?: string
  labels?: string[]
  updated_at?: string
  /** PR/Jira creation time (RFC3339); a Slack thread has created_ts instead. */
  created_at?: string
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

/** A worktree following a resource, on the home page's Resources tab. */
export interface ResourceWorktree { path: string; repo: string; branch: string }

/** GET /api/all-resources: each followed resource once, across every worktree. */
export interface AllResourceDTO extends ResourceDTO {
  /** In registry order; never empty. The first is where "Details" goes. */
  worktrees: ResourceWorktree[]
  /** A PR the user opened, or a Jira issue assigned to or reported by them. */
  mine?: boolean
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

export interface WorktreeNotes {
  notes: string; sync_cmux: boolean; updated_at?: string
  /** Show these notes on the home page's worktree card. Absent from an older server: treat as on. */
  show_on_home?: boolean
}
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

/** The branch a PR or Jira input would get; empty for a plain branch name. */
export interface DefaultBranchResponse {
  branch: string
  error?: string
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

export interface ResourcePollDetail {
  ok: boolean;
  duration_ms?: number;
  http_status?: number;
  events_emitted: number;
  note?: string;
}

export interface WatchedResourceStatus {
  type: string;
  id: string;
  url?: string;
  name: string;
  worktrees: string[];
  status: "ok" | "error" | "never";
  last_attempt?: string;
  last_success?: string;
  last_error?: string;
  error_message?: string;
  detail?: ResourcePollDetail;
  resource_updated_at?: string;
}

export interface PollLogEntry {
  id: number;
  ts: string;
  source: "github" | "jira" | "slack";
  level: "info" | "warn" | "error";
  kind: "poll" | "http" | "resource";
  message: string;
  method?: string;
  endpoint?: string;
  http_status?: number;
  duration_ms?: number;
  bytes?: number;
  error_body?: string;
  resources: { type: string; id: string; name: string }[];
}

export interface PollLogResponse {
  entries: PollLogEntry[];
  has_more: boolean;
}

export interface WatcherLogQuery {
  source?: string;
  level?: "info" | "warn";
  after_id?: number;
  before_id?: number;
  limit?: number;
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
  /** The Settings "Enable notifications" switch; only on GET /api/session. */
  notifications_enabled?: boolean
  /** The server's home directory, for showing paths with ~; only on GET /api/session. */
  home?: string
}

/** GET /api/update-status: whether the repo's main branch is ahead of this build. */
export interface UpdateStatus {
  available: boolean
  behind_by: number
  /** The commit list on GitHub. */
  details_url: string
}

/** The editable keys of worktree's config.yaml, as stored (not resolved). */
export interface WorktreeSettings {
  /** Kept as written, e.g. "~/.worktrees"; never the expanded or env-resolved value. */
  worktrees_base: string
  editor: string
  cmux_features_enabled: boolean
  /** Per service, whether worktree's watcher may connect to it (watchers.*; absent in the file = on). */
  watchers: Record<CredService, boolean>
  jira: {
    projects: string[]
    alias_hosts: string[]
  }
  ui: {
    /** Inverts ui.remote_access_disabled: off keeps the certificate but skips the HTTPS listener. */
    remote_access_enabled: boolean
    https_port: number
    allowed_hosts: string[]
    tls: { cert_file: string; key_file: string }
  }
  /** notifications.*: the Notifications tab. */
  notifications: {
    /** Inverts notifications.disabled. */
    enabled: boolean
    command_enabled: boolean
    /** Reads as the default command when unset. */
    command: string
  }
  /** git.*: the General tab. */
  git: {
    /** The background `git fetch` that keeps a Code tab comparison fresh. */
    background_fetch: boolean
    /** A Go duration of at least 1m; "3m" is the default. */
    fetch_interval: string
  }
}

/** The non-secret keys of watcher's auth.yaml. */
export interface WatcherAuthSettings {
  jira: { host: string; email: string }
  slack: { workspace_domain: string }
}

/** The editable keys of watcher's config.yaml. */
export interface WatcherConfigSettings {
  jira: {
    bot_usernames: string[]
    custom_fields: Record<string, string>
  }
}

/** GET /api/settings (and the response of every settings PUT). */
export interface Settings {
  environment: {
    /** Whether the server can reach cmux at all; the cmux toggle needs it. */
    in_cmux: boolean
    /** $WORKTREES_BASE is set and overrides worktrees_base. */
    worktrees_base_env: boolean
    /** Names the HTTPS certificate covers; null when none is configured. */
    cert_names: string[] | null
    /** What notifications.command falls back to, for the Notifications tab's reset. */
    default_notify_command: string
  }
  /** Home-relative paths of the three files these settings are persisted to. */
  paths: { worktree: string; watcher_auth: string; watcher_config: string }
  /** Whether each secret is set. The values themselves are never sent. */
  secrets: {
    ui_password: boolean
    github_token: boolean
    jira_token: boolean
    slack_token: boolean
    slack_cookie: boolean
  }
  worktree: WorktreeSettings
  watcher_auth: WatcherAuthSettings
  watcher_config: WatcherConfigSettings
}

export type CredService = "github" | "jira" | "slack"

/** Outcome of testing or replacing a credential. "unsaved": the Jira test was refused because the form's host differs from the saved one. */
export interface CredResult {
  ok: boolean
  kind: "ok" | "auth" | "network" | "missing" | "unsaved" | "disabled"
  detail: string
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

/** GET /api/cmux/peek: one tab's content for the cmux tab's hover card. */
export interface CmuxPeek {
  /** The tab's type as cmux reports it — read server-side, not echoed from the request. */
  type: string
  /** terminal: the last 200 lines, scrollback included, as plain text. */
  text?: string
  /** browser: a data:image/png URL of the page as it renders now. */
  image?: string
  /** markdown: the file's source. */
  markdown?: string
  /** markdown: the file shown. */
  path?: string
  /** Nothing to peek at (another tab type, or a markdown file cmux would not name or the server would not read). */
  unsupported?: boolean
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

/** A loaded browser tab in any cmux workspace (GET /api/cmux/browser-tabs). */
export interface CmuxBrowserTab {
  workspaceId: string
  workspaceRef: string
  workspaceTitle: string
  /** Selected within its window. */
  workspaceSelected: boolean
  /** The pane holding the tab, marked in `layout`'s diagram. */
  pane: string
  /** The workspace's splits; absent when cmux's layout could not be read. */
  layout?: CmuxLayout
  surface: string
  url: string
}

export interface CmuxBrowserTabsResponse { available: boolean; tabs: CmuxBrowserTab[] }

export interface CmuxActionResult { ok: boolean; error?: string; stale?: boolean }

/** A tab as the user saw it, so the server can check it is still that tab. */
export interface CmuxTabRef { surface: string; type: string; title: string }

export interface CmuxMove extends CmuxTabRef {
  pane: string
  /** Absent: the end of `pane`. */
  anchor?: CmuxTabRef & { position: "before" | "after" }
}

/** One row in the Linked Resources tab. Field names mirror ResourceDTO. */
export interface LinkedItem {
  type: "pr" | "jira" | "slack" | "link"
  id: string
  url: string
  /** false → the details couldn't be fetched; render key/URL only. */
  resolved: boolean
  title?: string
  state?: string
  is_draft?: boolean
  status?: string
  status_category?: string
  issue_type?: string
  issue_type_icon_url?: string
  channel_name?: string
  excerpt?: string
  domain?: string
  favicon?: string
  /** The link's label and surrounding text where it was written (already truncated). */
  context?: { before: string; label: string; after: string }
}

export interface LinkedTreeNode extends LinkedItem {
  current?: boolean
  /** The server's initial expansion: ancestors and the current branch. */
  expanded: boolean
  /** null = unknown; the UI offers a lazy expand. */
  has_children: boolean | null
  children?: LinkedTreeNode[]
  more?: { url: string }
}

export interface LinkedSection {
  kind: "git_pr" | "description" | "hierarchy" | "links" | "referenced_by" | "thread"
  title: string
  error?: string
  items?: LinkedItem[]
  groups?: { label: string; items: LinkedItem[] }[]
  tree?: LinkedTreeNode[]
}

export interface LinkedResourcesDTO {
  fetched_at: string
  count: number
  sections: LinkedSection[]
}

/** GET /api/watchers/health: per service, whether its watcher is on and whether every polled resource is failing. */
export type WatcherHealth = Record<CredService, { enabled: boolean; failing: boolean; error?: string }>

/**
 * What POST /api/resource-read did to a cursor. previous_ts is null when the
 * resource had none (restoring removes it again).
 */
export interface ResourceReadChange {
  previous_ts: string | null
  last_read_ts: string
}

// --- Code tab: git status and diff (mirror internal/webui/worktree_git_api.go,
// worktree_diff_api.go and internal/gitutil) ---

export interface AheadBehind {
  ahead: number
  behind: number
}

export interface WorktreeGit {
  on_disk: boolean
  /** The worktree's path with ~ for the home directory (the server knows it). Absent from an older server. */
  directory?: string
  /** Moves on commits, fetches, branch switches and working-tree edits. */
  fingerprint: string
  /** Moves only on working-tree edits. */
  working_fingerprint: string
  /** Empty when detached. */
  branch: string
  main_upstream?: string
  merge_base?: string
  vs_merge_base?: AheadBehind
  tracking?: string
  vs_tracking?: AheadBehind
  working: { staged: number; modified: number; untracked: number; files: number }
  fetch: { last_ok_at?: string | null; last_error?: string; in_progress: boolean }
}

export interface Commit {
  sha: string
  short: string
  subject: string
  author: string
  date: string
}

export interface FileChange {
  path: string
  old_path?: string
  /** A, M, D or R. */
  status: string
  additions: number
  deletions: number
  binary: boolean
}

export interface DiffCommits {
  list_id: string
  base_ref: string
  merge_base: string
  commits: Commit[]
}

export interface DiffFiles {
  fingerprint: string
  list_id: string
  files: FileChange[]
}

export interface DiffPatch {
  list_id: string
  working_fingerprint: string
  old_rev: string
  new_rev: string
  patch: string
}

export type DiffBase = "merge-base" | "tracking"
/** "all" is All changes; from/to are commit SHAs or "uncommitted" (from oldest, to newest). */
export type DiffRange = "all" | { from: string; to: string }

export type TaskState = "not_started" | "in_progress" | "done"
export type Priority = "none" | "low" | "medium" | "high"

/** One of a task's links; mirrors taskLinkDTO in internal/webui/tasks_api.go. */
export interface TaskLink {
  kind: "resource" | "worktree"
  resource_type?: string
  resource_id?: string
  worktree?: string
  /** The task's Primary flag. */
  focus: boolean
  archived: boolean
  /**
   * A resource link's followers: the canonical paths of the worktrees that
   * actively follow it, sorted. Empty for a worktree link and an archived
   * resource. Always sent by the server; optional for links built client-side.
   */
  worktrees?: string[]
}

/** An unresolved blocker as a task row names it; mirrors openBlockerDTO. */
export interface OpenBlocker {
  label: string
  /** Set for a resource blocker, so the row can show the resource. */
  resource_type?: string
  resource_id?: string
}

/** GET /api/tasks; mirrors taskDTO in internal/webui/tasks_api.go field for field. */
export interface Task {
  id: number
  /** Display ref, "T42". */
  ref: string
  title: string
  description: string
  state: TaskState
  priority: Priority
  starred: boolean
  due?: string
  rank: string
  created_at: string
  updated_at: string
  started_at?: string
  completed_at?: string
  archived: boolean
  links: TaskLink[]
  implicit_worktrees: string[]
  subtasks_total: number
  subtasks_done: number
  /**
   * The task's unread events: an agent's events newer than its read cursor.
   * Always sent by the server; optional so a task built client-side (or an
   * older cached response) reads as zero.
   */
  unread_count?: number
  /**
   * The newest of those unread events, from the same server snapshot; absent
   * with nothing unread. Sent as through_ts by the task modal's Mark read, so
   * it clears only what was counted, never an event that arrived after.
   */
  unread_through_ts?: string
  /** Some blocker is unresolved. */
  blocked: boolean
  /** How many blockers are unresolved. */
  blocker_count: number
  /** The unresolved blockers, oldest first, for the row chip's tooltip. Never null. */
  open_blockers: OpenBlocker[]
  /**
   * Only on the answer to an undoable write (a state change, a subtask
   * check) that changed something: the event it recorded, which
   * POST /api/tasks/undo takes back.
   */
  undo_event_id?: number
}

/** POST /api/tasks/delete: the task_deleted event, which POST /api/tasks/undo takes back. */
export interface TaskDeleteResult {
  undo_event_id: number
}

export type TaskBlockerKind = "task" | "resource" | "other"

/** One of a task's blockers; mirrors taskBlockerDTO in internal/webui/tasks_blockers_api.go. */
export interface TaskBlocker {
  id: number
  kind: TaskBlockerKind
  /** "T<id> <title>", a resource's display title, or the free text. */
  label: string
  /** A resource blocker's URL. */
  url?: string
  /** The blocking thing's status ("merged", "In Progress", "done", "resolved"); "" when unknown. */
  status_label: string
  resolved: boolean
  /** Resolved by its condition (a merged PR, a done task) rather than by hand. */
  resolved_auto: boolean
  resolved_reason: string
  /** Free-text, Slack thread and link blockers: resolved by hand. */
  manual_resolvable: boolean
  /** The blocking task. */
  task_id?: number
  resource_type?: string
  resource_id?: string
  text?: string
}

/** A task this one blocks; mirrors taskBlocksDTO. */
export interface TaskBlocks {
  id: number
  ref: string
  title: string
  state: TaskState
}

/** The body of POST /api/tasks/blockers/add, less the task id. */
export type TaskBlockerTarget =
  | { kind: "task"; task_id: number }
  | { kind: "resource"; url: string }
  | { kind: "resource"; type: string; rid: string }
  | { kind: "other"; text: string }

/** A link target; the body shape of the task link routes. */
export type TaskLinkTarget =
  | { kind: "resource"; type: string; rid: string }
  | { kind: "worktree"; path: string }

/** Mirrors taskDetailLinkDTO in internal/webui/tasks_detail_api.go. */
export interface TaskDetailLink extends TaskLink {
  /** Custom name, else cached title, else short ref; a worktree's branch, else basename. */
  title: string
  url?: string
}

/** A worktree shown only because it follows one of the task's resource links. */
export interface TaskImplicit {
  worktree: string
  branch?: string
  /** "type:id" of the resource links it follows. */
  via: string[]
}

export interface TaskSubtask {
  id: number
  text: string
  checked: boolean
}

/** What a linked event looked like when linked; mirrors tasks.EventSnapshot. */
export interface TaskEventSnapshot {
  source: string
  type: string
  title: string
  author: string
  body: string
  url: string
  ts: string
  resource_type: string
  resource_id: string
}

export interface TaskEventLink {
  /** "ev:<watcher event id>" or "slack:<channel>:<message ts>". */
  key: string
  snapshot: TaskEventSnapshot
  /** The event as it is now; only present while it exists with the snapshot's type. */
  live?: TimelineEvent
}

/** GET /api/tasks/detail; mirrors taskDetailDTO. */
export interface TaskDetail extends Task {
  detail_links: TaskDetailLink[]
  implicit: TaskImplicit[]
  subtasks: TaskSubtask[]
  event_links: TaskEventLink[]
  /** Unresolved first, then oldest first. Never null. */
  blockers: TaskBlocker[]
  /** The tasks this one blocks, in master order. Never null. */
  blocks: TaskBlocks[]
}

export type TaskActivityFilter = "all" | "task" | "linked" | "resource"

/** Which tasks a list (GET /api/tasks) or an unread summary (GET /api/task-unread) covers. */
export type TaskScope =
  | { kind: "all" }
  | { kind: "worktree"; path: string }
  | { kind: "resource"; type: string; id: string }

/** GET /api/task-unread; mirrors taskUnreadDTO in internal/webui/tasks_api.go. */
export interface TaskUnread {
  id: number
  title: string
  /** Its unread events: an agent's, newer than the task's cursor. */
  count: number
  /** The newest of those events; sent as through_ts to mark the task read. */
  newest_ts: string
}

// Review comments

export type CommentSource = "draft" | "pr"
export type CommentSide = "old" | "new"

export interface ReviewComment {
  id: number
  source: CommentSource
  author?: string
  editable: boolean
  file: string
  side: CommentSide
  start_line: number
  end_line: number
  rev: string
  base: DiffBase
  base_ref: string
  range_from?: string
  range_to?: string
  snippet: string[]
  body: string
  version: number
  created_at: string
  updated_at: string
}

export type ViewStatus = "shown" | "outdated" | "not_in_view" | "outside_changes"

export interface ReviewCommentItem extends ReviewComment {
  view?: { status: ViewStatus; start_line?: number; end_line?: number; moved?: boolean }
  prompt: { status: "current" | "moved" | "outdated" | "removed"; start_line: number; end_line: number }
}

export interface NewReviewComment {
  path: string
  file: string
  side: CommentSide
  start_line: number
  end_line: number
  body: string
  base: DiffBase
  from?: string
  to?: string
  old_rev: string
  new_rev: string
}

export interface PRRefDTO {
  id: string
  number: number
  url: string
}

export interface PRCommentsSummary {
  state: "ok" | "off" | "no_token" | "no_pr" | "error"
  branch?: string
  message?: string
  pr?: PRRefDTO
  fingerprint?: string
  open_threads: number
  unread_comments: number
  unread_ids: number[]
}

export interface PRThreadComment {
  id: number
  author: string
  avatar_url?: string
  body: string
  created_at: string
  url: string
  pending: boolean
}

export interface PRThread {
  id: string
  resolved: boolean
  outdated: boolean
  file: string
  side: CommentSide
  start_line: number
  end_line: number
  view?: { status: ViewStatus | "unavailable"; start_line?: number; end_line?: number; moved?: boolean }
  comments: PRThreadComment[]
}

export interface PRThreads {
  state: PRCommentsSummary["state"]
  branch?: string
  message?: string
  pr?: PRRefDTO
  fingerprint?: string
  threads: PRThread[]
}
