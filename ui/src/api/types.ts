export interface CmuxWorkspace {
  ref: string
  title: string
  color?: string
  selected: boolean
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
  // enriched from cached watcher state; absent if the resource was never polled
  title?: string
  channel_name?: string
  /** slack: unread as of the last poll; drives the unread dot. */
  has_unread?: boolean
  /** non-slack: events newer than the read cursor. Absent means zero. */
  unread_count?: number
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
