import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, Code, Stack, TextInput } from "@mantine/core"
import { api } from "../../api/client"
import type { CredService, Settings, WatcherAuthSettings } from "../../api/types"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"
import { SecretField, type TestState } from "./SecretField"

/** Every key of the watcher library's auth.yaml, except consumers and the legacy jira_custom_fields. */
export function WatcherAuthPanel({ settings, draft, update, error, active, onSecretSaved }: {
  settings: Settings
  draft: WatcherAuthSettings
  update: (fn: (d: WatcherAuthSettings) => WatcherAuthSettings) => void
  error?: string
  /** The tab is showing: run each configured service's test once. */
  active: boolean
  onSecretSaved: () => void
}) {
  const sec = settings.secrets
  const [tests, setTests] = useState<Record<CredService, TestState>>({
    github: { status: "idle" }, jira: { status: "idle" }, slack: { status: "idle" },
  })

  // Jira is tested with the host/email in the form, saved or not.
  const runTest = useCallback(async (svc: CredService) => {
    setTests((t) => ({ ...t, [svc]: { status: "testing" } }))
    try {
      const override = svc === "jira" ? { host: draft.jira.host, email: draft.jira.email } : undefined
      const result = await api.testCredential(svc, override)
      setTests((t) => ({ ...t, [svc]: { status: "done", result, at: Date.now() } }))
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      setTests((t) => ({ ...t, [svc]: { status: "done", at: Date.now(), result: { ok: false, kind: "network", detail } } }))
    }
  }, [draft.jira.host, draft.jira.email])

  // Test every configured service the first time the tab is shown. The ref
  // makes it one-shot even though runTest changes as the form is edited.
  const tested = useRef(false)
  useEffect(() => {
    if (!active || tested.current) return
    tested.current = true
    if (sec.github_token) void runTest("github")
    if (sec.jira_token) void runTest("jira")
    if (sec.slack_token && sec.slack_cookie) void runTest("slack")
  }, [active, runTest, sec.github_token, sec.jira_token, sec.slack_token, sec.slack_cookie])

  /** Replace = validate-then-write; on success refetch so *_set flags update, and show the result as the chip. */
  const replacer = (svc: CredService, body: (v: string) => Parameters<typeof api.replaceCredential>[1]) =>
    async (v: string) => {
      const r = await api.replaceCredential(svc, body(v))
      if (r.ok) {
        setTests((t) => ({ ...t, [svc]: { status: "done", result: r, at: Date.now() } }))
        onSecretSaved()
      }
      return r
    }

  const hostChangeNeedsToken = sec.jira_token && draft.jira.host.trim() !== settings.watcher_auth.jira.host.trim()
  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.watcher_auth} />
      {error && <Alert color="red" title="Couldn't save auth.yaml">{error}</Alert>}

      <SettingsSection title="GitHub">
        <SecretField
          label="Token"
          description={<>Personal access token with repo read scopes. <KeyPath path="services.github.token" /></>}
          isSet={sec.github_token}
          onReplace={replacer("github", (token) => ({ token }))}
          onTest={() => void runTest("github")}
          test={tests.github}
        />
      </SettingsSection>

      <SettingsSection title="Jira">
        <TextInput
          label="Host"
          description={<KeyPath path="services.jira.host" />}
          error={hostChangeNeedsToken ? "Changing the host needs the API token: paste it below and press Replace (Save alone will be refused)." : undefined}
          placeholder="https://yourorg.atlassian.net"
          value={draft.jira.host}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, jira: { ...d.jira, host: v } })) }}
          ff="monospace"
        />
        <TextInput
          label="Email"
          description={<KeyPath path="services.jira.email" />}
          value={draft.jira.email}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, jira: { ...d.jira, email: v } })) }}
          ff="monospace"
        />
        <SecretField
          label="API token"
          description={<>From id.atlassian.com → Security → API tokens. Tested with the host and email above. <KeyPath path="services.jira.token" /></>}
          isSet={sec.jira_token}
          onReplace={replacer("jira", (token) => ({ token, host: draft.jira.host, email: draft.jira.email }))}
          onTest={() => void runTest("jira")}
          test={tests.jira}
        />
      </SettingsSection>

      <SettingsSection title="Slack">
        <Alert color="blue" variant="light" p="xs">
          To automatically capture the Slack token and cookie from a browser session, run <Code>worktree setup slack</Code>.
        </Alert>
        <SecretField
          label="Session token"
          description={<>The xoxc-… token from a logged-in browser. <KeyPath path="services.slack.token" /></>}
          isSet={sec.slack_token}
          onReplace={replacer("slack", (token) => ({ token }))}
          testable={sec.slack_token && sec.slack_cookie}
          onTest={() => void runTest("slack")}
          test={tests.slack}
        />
        <SecretField
          label="Session cookie"
          description={<>The browser's d= cookie (xoxd-…). Tested together with the token. <KeyPath path="services.slack.cookie" /></>}
          isSet={sec.slack_cookie}
          placeholder="Paste a new cookie"
          onReplace={replacer("slack", (cookie) => ({ cookie }))}
          testable={sec.slack_token && sec.slack_cookie}
          onTest={() => void runTest("slack")}
          test={tests.slack}
        />
        <TextInput
          label="Workspace domain"
          description={<>Used to build permalinks. Filled in automatically after a successful Slack replace. <KeyPath path="services.slack.workspace_domain" /></>}
          value={draft.slack.workspace_domain}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, slack: { workspace_domain: v } })) }}
          ff="monospace"
        />
      </SettingsSection>
    </Stack>
  )
}
