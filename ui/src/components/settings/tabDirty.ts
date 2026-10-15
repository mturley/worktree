import type { Settings } from "../../api/types"
import { canonical, type Drafts, type PendingSecrets } from "./useSettingsDraft"

export type SettingsTab = "general" | "connected" | "github" | "jira" | "slack" | "ui-access" | "notifications"

/**
 * Which tabs (and Connected Services sub-tabs) hold unsaved changes. A tab
 * can span files and a file can span tabs — config.yaml backs General, UI
 * Access and Jira — so each tab compares only its own keys.
 */
export function tabDirty(base: Settings, d: Drafts, p: PendingSecrets): Record<SettingsTab, boolean> {
  const differs = (a: unknown, b: unknown) => canonical(a) !== canonical(b)
  const has = (k: keyof PendingSecrets) => p[k] !== undefined
  const { ui: _u, jira: _j, watchers: _w, notifications: _n, ...general } = d.worktree
  const { ui: _bu, jira: _bj, watchers: _bw, notifications: _bn, ...baseGeneral } = base.worktree
  // watchers.<svc> sits at the top of that service's sub-tab.
  const toggled = (svc: keyof Drafts["worktree"]["watchers"]) => d.worktree.watchers?.[svc] !== base.worktree.watchers?.[svc]
  const github = has("github_token") || toggled("github")
  const jira = has("jira_token") || toggled("jira") ||
    differs(d.watcher_auth.jira, base.watcher_auth.jira) ||
    differs(d.worktree.jira, base.worktree.jira) ||
    differs(d.watcher_config, base.watcher_config)
  const slack = has("slack_token") || has("slack_cookie") || toggled("slack") || differs(d.watcher_auth.slack, base.watcher_auth.slack)
  return {
    general: differs(general, baseGeneral),
    "ui-access": has("ui_password") || differs(d.worktree.ui, base.worktree.ui),
    notifications: differs(d.worktree.notifications, base.worktree.notifications),
    github,
    jira,
    slack,
    connected: github || jira || slack,
  }
}
