import { useWorktreeDetail } from "./useWorktreeDetail"

export interface SlackThreadRef {
  channel: string
  threadTs: string
  url: string
  id: string
  customName?: string
  customDescription?: string
}

export interface WorktreeSlackThreads {
  threads: SlackThreadRef[]
  /**
   * Refetch the underlying worktree resources. Exposed so callers (SlackTab)
   * can refresh after a write (e.g. saving a custom name/description) WITHOUT
   * mounting a second `useWorktreeDetail` instance — a second instance would
   * fire the poll-on-view effect (an imperative `pollWorktree` call that
   * react-query's query cache does not dedupe) a second time per mount.
   */
  refetch: () => Promise<unknown>
}

/**
 * Derives the slack threads tracked by a worktree from its resources. Each
 * slack resource (`type === "slack"`) has an id of the form
 * `"<channel>:<thread_ts>"` and a permalink url — this splits that into the
 * {channel, threadTs} pair the ported Slack UI (useThread/ThreadView) needs.
 * Also returns the resources `refetch` so callers can refresh after a write.
 */
export function useWorktreeSlackThreads(path: string): WorktreeSlackThreads {
  const { resources } = useWorktreeDetail(path)
  const slack = (resources.data ?? []).filter((r) => r.type === "slack")
  const threads = slack.map((r) => {
    const [channel, threadTs] = r.id.split(":")
    return {
      channel, threadTs, url: r.url, id: r.id,
      customName: r.custom_name,
      customDescription: r.custom_description,
    }
  })
  return { threads, refetch: resources.refetch }
}
