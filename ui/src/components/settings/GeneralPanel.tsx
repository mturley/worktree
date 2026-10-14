import { Alert, Anchor, Code, NumberInput, Stack, TagsInput, Text, TextInput } from "@mantine/core"
import type { Settings, WorktreeSettings } from "../../api/types"
import { api } from "../../api/client"
import { Toggle } from "../Toggle"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"
import { SecretField } from "./SecretField"

const DEFAULT_HTTPS_PORT = 8476
export const RESTART_BADGE = "Applies after restarting worktree ui"

interface Props {
  settings: Settings
  draft: WorktreeSettings
  update: (fn: (d: WorktreeSettings) => WorktreeSettings) => void
  error?: string
  /** Called after a secret (the UI password) was replaced, to refetch. */
  onSecretSaved: () => void
  /** Jump to the Watcher Auth tab. */
  onShowWatcherAuth: () => void
}

/** Every key of worktree's config.yaml. */
export function GeneralPanel({ settings, draft, update, error, onSecretSaved, onShowWatcherAuth }: Props) {
  const env = settings.environment
  const certNames = env.cert_names
  const uncovered = certNames
    ? draft.ui.allowed_hosts.filter((h) => !certNames.map((n) => n.toLowerCase()).includes(h.toLowerCase()))
    : []
  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.worktree} />
      {error && <Alert color="red" title="Couldn't save config.yaml">{error}</Alert>}

      <SettingsSection title="Interface">
        <Toggle
          label="Enable cmux features"
          description="Workspace headers, tab controls, Follow cmux focus, cmux notifications and the 📬 unread title prefix."
          checked={draft.cmux_features_enabled}
          disabled={!env.in_cmux}
          onChange={(e) => { const on = e.currentTarget.checked; update((d) => ({ ...d, cmux_features_enabled: on })) }}
          tooltip={env.in_cmux ? undefined : "The worktree UI server is not running inside cmux, so there are no cmux features to turn on or off."}
        />
        <TextInput
          label="Editor"
          description={<>Command used by <Code>worktree open</Code> to open a worktree. <KeyPath path="editor" /></>}
          placeholder="$EDITOR"
          value={draft.editor}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, editor: v })) }}
          ff="monospace"
        />
      </SettingsSection>

      <SettingsSection title="Worktrees">
        <TextInput
          label="Worktrees base directory"
          description={<>Where new worktrees are created. <KeyPath path="worktrees_base" /></>}
          placeholder="~/.worktrees"
          value={draft.worktrees_base}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, worktrees_base: v })) }}
          ff="monospace"
        />
        {env.worktrees_base_env && (
          <Text size="xs" c="yellow">$WORKTREES_BASE is set in the server's environment and overrides this value.</Text>
        )}
      </SettingsSection>

      <SettingsSection title="Jira">
        <TagsInput
          label="Project keys"
          description={<>Prefixes detected in branch names and PR titles. <KeyPath path="jira.projects" /></>}
          placeholder="Add key…"
          value={draft.jira.projects}
          onChange={(v) => update((d) => ({ ...d, jira: { ...d.jira, projects: v } }))}
        />
        <TagsInput
          label="Alias hosts"
          description={<>Old hostnames whose /browse/KEY links still count as Jira issues. <KeyPath path="jira.alias_hosts" /></>}
          placeholder="Add host…"
          value={draft.jira.alias_hosts}
          onChange={(v) => update((d) => ({ ...d, jira: { ...d.jira, alias_hosts: v } }))}
        />
        <Text size="xs" c="dimmed">
          Jira host, email and token are on the <Anchor component="button" size="xs" onClick={onShowWatcherAuth}>Watcher Auth</Anchor> tab.
        </Text>
      </SettingsSection>

      <SettingsSection title="Login">
        <SecretField
          label="UI password"
          description={<>Required to log in from any device. Takes effect immediately; existing logins stay signed in. <KeyPath path="ui.password" /></>}
          isSet={settings.secrets.ui_password}
          placeholder="Type a new password"
          onReplace={async (pw) => { await api.replacePassword(pw); onSecretSaved() }}
        />
      </SettingsSection>

      <SettingsSection title="Remote access" badge={RESTART_BADGE}>
        <NumberInput
          label="HTTPS port"
          description={<><KeyPath path="ui.https_port" /> · default 8476</>}
          min={1}
          max={65535}
          w={160}
          value={draft.ui.https_port}
          onChange={(v) => update((d) => ({ ...d, ui: { ...d.ui, https_port: typeof v === "number" ? v : Number(v) || DEFAULT_HTTPS_PORT } }))}
        />
        <TagsInput
          label="Allowed hosts"
          description={<>Names and IPs other devices use. Also the certificate's names. <KeyPath path="ui.allowed_hosts" /></>}
          placeholder="Add host…"
          value={draft.ui.allowed_hosts}
          onChange={(v) => update((d) => ({ ...d, ui: { ...d.ui, allowed_hosts: v } }))}
        />
        {uncovered.length > 0 && (
          <Alert color="yellow" p="xs">
            The current certificate doesn't cover <b>{uncovered.join(", ")}</b>. Run <Code>worktree setup</Code> to
            reissue it, then reinstall the CA on your phone.
          </Alert>
        )}
        <TextInput
          label="TLS certificate"
          description={<KeyPath path="ui.tls.cert_file" />}
          value={draft.ui.tls.cert_file}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, ui: { ...d.ui, tls: { ...d.ui.tls, cert_file: v } } })) }}
          ff="monospace"
        />
        <TextInput
          label="TLS key"
          description={<KeyPath path="ui.tls.key_file" />}
          value={draft.ui.tls.key_file}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, ui: { ...d.ui, tls: { ...d.ui.tls, key_file: v } } })) }}
          ff="monospace"
        />
      </SettingsSection>
    </Stack>
  )
}
