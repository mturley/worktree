import type { CmuxBrowserTab, CmuxBrowserTabsResponse } from "../api/types"

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/
const JIRA_PATH = /^\/browse\/([a-z][a-z0-9_]*-\d+)\/?$/i

/**
 * What a cmux tab's URL must reduce to for it to count as showing this
 * resource, or null when the type is not one we look for. A PR's subpages
 * (/files, /commits, a #discussion anchor) are still the PR, so only
 * host/owner/repo/number is kept; query strings and fragments never matter.
 */
export function tabMatchKey(type: string, url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.host.toLowerCase()
  if (type === "pr") {
    const m = PR_PATH.exec(u.pathname)
    // GitHub owner and repo names are case-insensitive.
    return m ? `${host}/${m[1].toLowerCase()}/${m[2].toLowerCase()}/pull/${m[3]}` : null
  }
  if (type === "jira") {
    const m = JIRA_PATH.exec(u.pathname)
    return m ? `${host}/browse/${m[1].toUpperCase()}` : null
  }
  return null
}

/**
 * The cmux browser tab already showing a resource of `type` whose
 * tabMatchKey is `key`. Ranked: a tab in one of the worktree's own workspaces
 * (`worktreeRefs`), then one in a workspace the user is on, then any.
 */
export function findResourceTab(
  res: CmuxBrowserTabsResponse | undefined,
  type: string,
  key: string,
  worktreeRefs: string[],
): CmuxBrowserTab | null {
  if (!res?.available) return null
  const matches = res.tabs.filter((t) => tabMatchKey(type, t.url) === key)
  return (
    matches.find((t) => worktreeRefs.includes(t.workspaceRef)) ??
    matches.find((t) => t.workspaceSelected) ??
    matches[0] ??
    null
  )
}
