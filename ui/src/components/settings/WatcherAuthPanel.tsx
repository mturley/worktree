import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, Code, Stack, TextInput } from "@mantine/core"
import { api } from "../../api/client"
import type { CredResult, CredService, Settings, WatcherAuthSettings } from "../../api/types"
import type { PendingSecrets, SecretKey } from "./useSettingsDraft"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"
import { SecretField, type TestState } from "./SecretField"

/** Every key of the watcher library's auth.yaml, except consumers and the legacy jira_custom_fields. */
export function WatcherAuthPanel({ settings, draft, update, error, active, secrets, setSecret }: {
  settings: Settings
  draft: WatcherAuthSettings
  update: (fn: (d: WatcherAuthSettings) => WatcherAuthSettings) => void
  error?: string
  /** The tab is showing: run each configured service's test once. */
  active: boolean
  /** Replaced values waiting for Save; tests use them in place of the stored ones. */
  secrets: PendingSecrets
  setSecret: (key: SecretKey, value: string | null) => void
}) {
  const sec = settings.secrets
  const [tests, setTests] = useState<Record<CredService, TestState>>({
    github: { status: "idle" }, jira: { status: "idle" }, slack: { status: "idle" },
  })

  /** What a test sends: the form's Jira host/email, and any pending secret in place of the stored one. */
  const candidate = useCallback((svc: CredService, p: PendingSecrets) => {
    if (svc === "github") return { token: p.github_token }
    if (svc === "jira") return { host: draft.jira.host, email: draft.jira.email, token: p.jira_token }
    return { token: p.slack_token, cookie: p.slack_cookie }
  }, [draft.jira.host, draft.jira.email])

  const setDone = (svc: CredService, result: CredResult) =>
    setTests((t) => ({ ...t, [svc]: { status: "done", result, at: Date.now() } }))

  const runTest = useCallback(async (svc: CredService) => {
    setTests((t) => ({ ...t, [svc]: { status: "testing" } }))
    try {
      setDone(svc, await api.testCredential(svc, candidate(svc, secrets)))
    } catch (e) {
      setDone(svc, { ok: false, kind: "network", detail: e instanceof Error ? e.message : String(e) })
    }
  }, [candidate, secrets])

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

  /**
   * Replace tests the new value (nothing is written) and, if it passes,
   * holds it for Save. A Slack half whose partner is neither stored nor
   * pending can't be tested yet; it is held, and Save checks the pair.
   */
  const replacer = (svc: CredService, key: SecretKey) => async (v: string) => {
    const r = await api.testCredential(svc, candidate(svc, { ...secrets, [key]: v }))
    if (r.ok || (svc === "slack" && r.kind === "missing")) {
      setSecret(key, v)
      setDone(svc, r)
      return { ...r, ok: true }
    }
    return r
  }
  const reverter = (svc: CredService, key: SecretKey) => () => {
    setSecret(key, null)
    setTests((t) => ({ ...t, [svc]: { status: "idle" } }))
  }
  const has = (key: SecretKey) => secrets[key] !== undefined
  const slackTestable = (sec.slack_token || has("slack_token")) && (sec.slack_cookie || has("slack_cookie"))

  const hostChangeNeedsToken = sec.jira_token && !has("jira_token") && draft.jira.host.trim() !== settings.watcher_auth.jira.host.trim()
  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.watcher_auth} />
      {error && <Alert color="red" title="Couldn't save auth.yaml">{error}</Alert>}

      <SettingsSection title="GitHub">
        <SecretField
          label="Token"
          description={<>Personal access token with repo read scopes. <KeyPath path="services.github.token" /></>}
          isSet={sec.github_token}
          pending={has("github_token")}
          onRevert={reverter("github", "github_token")}
          onReplace={replacer("github", "github_token")}
          onTest={() => void runTest("github")}
          test={tests.github}
        />
      </SettingsSection>

      <SettingsSection title="Jira">
        <TextInput
          label="Host"
          description={<KeyPath path="services.jira.host" />}
          error={hostChangeNeedsToken ? "Changing the host needs the API token: paste it below and press Replace, then Save." : undefined}
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
          pending={has("jira_token")}
          onRevert={reverter("jira", "jira_token")}
          onReplace={replacer("jira", "jira_token")}
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
          pending={has("slack_token")}
          onRevert={reverter("slack", "slack_token")}
          onReplace={replacer("slack", "slack_token")}
          testable={slackTestable}
          onTest={() => void runTest("slack")}
          test={tests.slack}
        />
        <SecretField
          label="Session cookie"
          description={<>The browser's d= cookie (xoxd-…). Tested together with the token. <KeyPath path="services.slack.cookie" /></>}
          isSet={sec.slack_cookie}
          placeholder="Paste a new cookie"
          pending={has("slack_cookie")}
          onRevert={reverter("slack", "slack_cookie")}
          onReplace={replacer("slack", "slack_cookie")}
          testable={slackTestable}
          onTest={() => void runTest("slack")}
          test={tests.slack}
        />
        <TextInput
          label="Workspace domain"
          description={<>Used to build permalinks. Filled in automatically when new Slack credentials are saved. <KeyPath path="services.slack.workspace_domain" /></>}
          value={draft.slack.workspace_domain}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, slack: { workspace_domain: v } })) }}
          ff="monospace"
        />
      </SettingsSection>
    </Stack>
  )
}
