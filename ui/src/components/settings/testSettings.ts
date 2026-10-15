import type { Settings } from "../../api/types"

export const baseSettings = (): Settings => ({
  environment: { in_cmux: true, worktrees_base_env: false, cert_names: ["a.local"] },
  paths: { worktree: "~/.config/worktree/config.yaml", watcher_auth: "~/.config/watcher/auth.yaml", watcher_config: "~/.config/watcher/config.yaml" },
  secrets: { ui_password: true, github_token: true, jira_token: true, slack_token: true, slack_cookie: true },
  worktree: { worktrees_base: "~/.worktrees", editor: "", cmux_features_enabled: true,
    watchers: { github: true, jira: true, slack: true },
    jira: { projects: ["ABC"], alias_hosts: [] },
    ui: { https_port: 8476, allowed_hosts: ["a.local"], tls: { cert_file: "~/c.pem", key_file: "~/k.pem" } } },
  watcher_auth: { jira: { host: "https://x.atlassian.net", email: "me@x" }, slack: { workspace_domain: "x.slack.com" } },
  watcher_config: { jira: { bot_usernames: [], custom_fields: { a: "customfield_1", b: "customfield_2" } } },
})
