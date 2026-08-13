export interface WorktreeSummary {
  path: string; repo: string; branch: string;
  on_disk: boolean; resource_count: number; primary_count: number; latest_event_ts: string;
  primary_by_type: Record<string, number>; related_count: number;
}
export interface TimelineEvent {
  id: string; ts: string; external_ts: string; source: string;
  type: string; type_label: string; title: string; body: string; author: string;
  resource_type: string; resource_id: string; resource_url: string; resource_title: string;
  worktrees: string[];
}
export interface TimelineResponse { events: TimelineEvent[]; next_cursor: string }
export interface ResourceDTO { type: string; id: string; url: string; primary: boolean }
