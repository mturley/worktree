import type { CmuxTab, CmuxTreeResponse, CmuxTreeWorkspace } from "../api/types"

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

export interface ResourceTab {
  workspace: CmuxTreeWorkspace
  tab: CmuxTab
}

/**
 * The cmux tab already showing a resource of `type` whose tabMatchKey is
 * `key`, preferring the workspace the user is on. Terminals and unloaded
 * browser tabs have no URL, so they never match.
 */
export function findResourceTab(tree: CmuxTreeResponse | undefined, type: string, key: string): ResourceTab | null {
  if (!tree?.available) return null
  const ordered = [...tree.workspaces].sort((a, b) => Number(b.selected) - Number(a.selected))
  for (const workspace of ordered) {
    for (const pane of workspace.panes ?? []) {
      for (const tab of pane.tabs) {
        if (tab.url && tabMatchKey(type, tab.url) === key) {
          return { workspace, tab }
        }
      }
    }
  }
  return null
}
