import type { CredService } from "../../api/types"

export const serviceName: Record<CredService, string> = { github: "GitHub", jira: "Jira", slack: "Slack" }

/**
 * What turning a service's watcher off means. `worktree setup` prints the
 * same words (internal/setup/watchers.go WatcherOffMessage).
 */
export function watcherOffMessage(svc: CredService): string {
  const name = serviceName[svc]
  const detail = svc === "slack"
    ? "No new activity will appear and threads will not be interactable."
    : "No new activity will appear and linked resources will not update."
  return `Existing ${name} resources will still appear, but worktree will not connect to ${name}. ${detail}`
}

/** The service a resource type belongs to, if any. */
export function serviceForType(type: string): CredService | undefined {
  if (type === "pr") return "github"
  if (type === "jira") return "jira"
  if (type === "slack") return "slack"
  return undefined
}
