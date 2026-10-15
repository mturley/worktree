import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, Code, Stack, Tabs, TagsInput, Text, TextInput } from "@mantine/core"
import { api } from "../../api/client"
import type { CredResult, CredService, Settings } from "../../api/types"
import type { Drafts, PendingSecrets, SecretKey, SettingsFile } from "./useSettingsDraft"
import { JiraPollingSection } from "./JiraPollingSection"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"
import { SecretField, type TestState } from "./SecretField"
import type { SettingsTab } from "./tabDirty"

const fileTitle: Record<SettingsFile, string> = {
  worktree: "config.yaml",
  watcher_auth: "auth.yaml",
  watcher_config: "watcher config.yaml",
}

/**
 * GitHub, Jira and Slack, one sub-tab each, gathering every key for that
 * service across the three files: watcher auth.yaml (all three), worktree's
 * config.yaml (Jira project detection) and watcher config.yaml (Jira
 * polling). Excludes auth.yaml's consumers and legacy jira_custom_fields.
 */
export function ConnectedServicesPanel({ settings, drafts, update, errors, active, secrets, setSecret, setInvalid, resetToken, dirty }: {
  settings: Settings
  drafts: Drafts
  update: <F extends SettingsFile>(file: F, fn: (d: Drafts[F]) => Drafts[F]) => void
  errors: Partial<Record<SettingsFile, string>>
  /** The tab is showing: run each configured service's test once. */
  active: boolean
  /** Replaced values waiting for Save; tests use them in place of the stored ones. */
  secrets: PendingSecrets
  setSecret: (key: SecretKey, value: string | null) => void
  /** Mark watcher config.yaml's draft invalid (Save then skips it) or valid again. */
  setInvalid: (message: string | null) => void
  /** Bumped on Discard and Save, to remount the custom-field rows. */
  resetToken: number
  dirty: Record<SettingsTab, boolean>
}) {
  const sec = settings.secrets
  const auth = drafts.watcher_auth
  const paths = settings.paths
  const [service, setService] = useState<string | null>("github")
  const [tests, setTests] = useState<Record<CredService, TestState>>({
    github: { status: "idle" }, jira: { status: "idle" }, slack: { status: "idle" },
  })

  /** What a test sends: the form's Jira host/email, and any pending secret in place of the stored one. */
  const candidate = useCallback((svc: CredService, p: PendingSecrets) => {
    if (svc === "github") return { token: p.github_token }
    if (svc === "jira") return { host: auth.jira.host, email: auth.jira.email, token: p.jira_token }
    return { token: p.slack_token, cookie: p.slack_cookie }
  }, [auth.jira.host, auth.jira.email])

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
  const hostChangeNeedsToken = sec.jira_token && !has("jira_token") && auth.jira.host.trim() !== settings.watcher_auth.jira.host.trim()

  /** One alert per file this sub-tab saves to that failed. */
  const fileErrors = (files: SettingsFile[]) => files.map((f) => errors[f] && (
    <Alert key={f} color="red" title={`Couldn't save ${fileTitle[f]}`}>{errors[f]}</Alert>
  ))
  const label = (name: string, tab: SettingsTab) =>
    <>{name}{dirty[tab] ? <Text span c="orange" ml={4}>●</Text> : null}</>

  return (
    <Tabs value={service} onChange={setService} variant="pills">
      <Tabs.List>
        <Tabs.Tab value="github">{label("GitHub", "github")}</Tabs.Tab>
        <Tabs.Tab value="jira">{label("Jira", "jira")}</Tabs.Tab>
        <Tabs.Tab value="slack">{label("Slack", "slack")}</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="github" pt="md">
        <Stack gap="lg">
          <PersistedTo path={paths.watcher_auth} />
          {fileErrors(["watcher_auth"])}
          <SettingsSection title="Authentication">
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
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="jira" pt="md">
        <Stack gap="lg">
          <PersistedTo paths={[paths.watcher_auth, paths.worktree, paths.watcher_config]} />
          {fileErrors(["watcher_auth", "worktree", "watcher_config"])}
          <SettingsSection title="Connection" file={paths.watcher_auth}>
            <TextInput
              label="Host"
              description={<KeyPath path="services.jira.host" />}
              error={hostChangeNeedsToken ? "Changing the host needs the API token: paste it below and press Replace, then Save." : undefined}
              placeholder="https://yourorg.atlassian.net"
              value={auth.jira.host}
              onChange={(e) => { const v = e.currentTarget.value; update("watcher_auth", (d) => ({ ...d, jira: { ...d.jira, host: v } })) }}
              ff="monospace"
            />
            <TextInput
              label="Email"
              description={<KeyPath path="services.jira.email" />}
              value={auth.jira.email}
              onChange={(e) => { const v = e.currentTarget.value; update("watcher_auth", (d) => ({ ...d, jira: { ...d.jira, email: v } })) }}
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
          <SettingsSection title="Issue detection" file={paths.worktree}>
            <TagsInput
              label="Project keys"
              description={<>Prefixes detected in branch names and PR titles. <KeyPath path="jira.projects" /></>}
              placeholder="Add key…"
              value={drafts.worktree.jira.projects}
              onChange={(v) => update("worktree", (d) => ({ ...d, jira: { ...d.jira, projects: v } }))}
            />
            <TagsInput
              label="Alias hosts"
              description={<>Old hostnames whose /browse/KEY links still count as Jira issues. <KeyPath path="jira.alias_hosts" /></>}
              placeholder="Add host…"
              value={drafts.worktree.jira.alias_hosts}
              onChange={(v) => update("worktree", (d) => ({ ...d, jira: { ...d.jira, alias_hosts: v } }))}
            />
          </SettingsSection>
          <JiraPollingSection
            key={resetToken}
            file={paths.watcher_config}
            draft={drafts.watcher_config}
            update={(fn) => update("watcher_config", fn)}
            setInvalid={setInvalid}
          />
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="slack" pt="md">
        <Stack gap="lg">
          <PersistedTo path={paths.watcher_auth} />
          {fileErrors(["watcher_auth"])}
          <Alert color="blue" variant="light" p="xs">
            To automatically capture the Slack token and cookie from a browser session, run <Code>worktree setup slack</Code>.
          </Alert>
          <SettingsSection title="Session">
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
              value={auth.slack.workspace_domain}
              onChange={(e) => { const v = e.currentTarget.value; update("watcher_auth", (d) => ({ ...d, slack: { workspace_domain: v } })) }}
              ff="monospace"
            />
          </SettingsSection>
        </Stack>
      </Tabs.Panel>
    </Tabs>
  )
}
