import { Alert, Code, NumberInput, Stack, TagsInput, TextInput } from "@mantine/core"
import type { Settings, WorktreeSettings } from "../../api/types"
import { api } from "../../api/client"
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
}

/** The ui.* keys of worktree's config.yaml: login and remote access. */
export function UIAccessPanel({ settings, draft, update, error, onSecretSaved }: Props) {
  const certNames = settings.environment.cert_names
  const uncovered = certNames
    ? draft.ui.allowed_hosts.filter((h) => !certNames.map((n) => n.toLowerCase()).includes(h.toLowerCase()))
    : []
  return (
    <Stack gap="lg">
      <PersistedTo path={settings.paths.worktree} />
      {error && <Alert color="red" title="Couldn't save config.yaml">{error}</Alert>}

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
