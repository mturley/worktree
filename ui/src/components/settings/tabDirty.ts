import type { Settings } from "../../api/types"
import { canonical, type Drafts, type PendingSecrets } from "./useSettingsDraft"

export type SettingsTab = "general" | "connected" | "github" | "jira" | "slack" | "ui-access"

/**
 * Which tabs (and Connected Services sub-tabs) hold unsaved changes. A tab
 * can span files and a file can span tabs — config.yaml backs General, UI
 * Access and Jira — so each tab compares only its own keys.
 */
export function tabDirty(base: Settings, d: Drafts, p: PendingSecrets): Record<SettingsTab, boolean> {
  const differs = (a: unknown, b: unknown) => canonical(a) !== canonical(b)
  const has = (k: keyof PendingSecrets) => p[k] !== undefined
  const { ui: _u, jira: _j, ...general } = d.worktree
  const { ui: _bu, jira: _bj, ...baseGeneral } = base.worktree
  const github = has("github_token")
  const jira = has("jira_token") ||
    differs(d.watcher_auth.jira, base.watcher_auth.jira) ||
    differs(d.worktree.jira, base.worktree.jira) ||
    differs(d.watcher_config, base.watcher_config)
  const slack = has("slack_token") || has("slack_cookie") || differs(d.watcher_auth.slack, base.watcher_auth.slack)
  return {
    general: differs(general, baseGeneral),
    "ui-access": has("ui_password") || differs(d.worktree.ui, base.worktree.ui),
    github,
    jira,
    slack,
    connected: github || jira || slack,
  }
}
