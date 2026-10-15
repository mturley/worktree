import { Alert, Code, NumberInput, Stack, TagsInput, Text, TextInput } from "@mantine/core"
import type { Settings, WorktreeSettings } from "../../api/types"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"
import { SecretField } from "./SecretField"
import type { PendingSecrets, SecretKey } from "./useSettingsDraft"

const DEFAULT_HTTPS_PORT = 8476
export const RESTART_BADGE = "Applies after restarting worktree ui"

interface Props {
  settings: Settings
  draft: WorktreeSettings
  update: (fn: (d: WorktreeSettings) => WorktreeSettings) => void
  error?: string
  /** A replaced password waits here for Save. */
  secrets: PendingSecrets
  setSecret: (key: SecretKey, value: string | null) => void
}

/** The ui.* keys of worktree's config.yaml: login and remote access. */
export function UIAccessPanel({ settings, draft, update, error, secrets, setSecret }: Props) {
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
          description={<>Required to log in from any device. Takes effect on Save; existing logins stay signed in. <KeyPath path="ui.password" /></>}
          isSet={settings.secrets.ui_password}
          pending={secrets.ui_password !== undefined}
          onRevert={() => setSecret("ui_password", null)}
          placeholder="Type a new password"
          onReplace={async (pw) => {
            if (!pw.trim()) return { ok: false, kind: "missing", detail: "The password can't be blank" }
            setSecret("ui_password", pw)
          }}
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
        <Text size="xs" c="dimmed">
          <Code>worktree setup</Code> generates the certificate and key and fills in both paths, along with the
          allowed hosts. Change them only to use a certificate of your own.
        </Text>
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
