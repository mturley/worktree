export interface WorktreeSummary {
  path: string; repo: string; branch: string;
  on_disk: boolean; resource_count: number; primary_count: number; latest_event_ts: string;
  primary_by_type: Record<string, number>; related_count: number;
  /** Primary ("focus") resources, enriched. Always an array — never null. */
  focus_resources: ResourceDTO[];
}
export interface TimelineEvent {
  id: string; ts: string; external_ts: string; source: string;
  type: string; type_label: string; title: string; body: string; author: string;
  resource_type: string; resource_id: string; resource_url: string; resource_title: string;
  worktrees: string[];
}
export interface TimelineResponse { events: TimelineEvent[]; next_cursor: string }
export interface ResourceDTO {
  type: string; id: string; url: string; primary: boolean
  // enriched from cached watcher state; absent if the resource was never polled
  title?: string
  channel_name?: string
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
  assignee?: string
  labels?: string[]
  updated_at?: string
  custom_name?: string
  custom_description?: string
}
