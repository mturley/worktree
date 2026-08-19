import { useWorktreeDetail } from "./useWorktreeDetail"

export interface SlackThreadRef {
  channel: string
  threadTs: string
  url: string
  id: string
  customName?: string
  customDescription?: string
}

/**
 * Derives the slack threads tracked by a worktree from its resources. Each
 * slack resource (`type === "slack"`) has an id of the form
 * `"<channel>:<thread_ts>"` and a permalink url — this splits that into the
 * {channel, threadTs} pair the ported Slack UI (useThread/ThreadView) needs.
 */
export function useWorktreeSlackThreads(path: string): SlackThreadRef[] {
  const { resources } = useWorktreeDetail(path)
  const slack = (resources.data ?? []).filter((r) => r.type === "slack")
  return slack.map((r) => {
    const [channel, threadTs] = r.id.split(":")
    return {
      channel, threadTs, url: r.url, id: r.id,
      customName: r.custom_name,
      customDescription: r.custom_description,
    }
  })
}
