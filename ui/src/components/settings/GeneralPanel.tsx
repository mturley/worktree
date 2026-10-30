import { Alert, Code, Stack, Text, TextInput } from "@mantine/core"
import type { Settings, WorktreeSettings } from "../../api/types"
import { Toggle } from "../Toggle"
import { KeyPath, PersistedTo, SettingsSection } from "./parts"

interface Props {
  settings: Settings
  draft: WorktreeSettings
  update: (fn: (d: WorktreeSettings) => WorktreeSettings) => void
  error?: string
}

/** worktree's config.yaml, except ui.* (UIAccessPanel) and jira.* (Connected Services → Jira). */
export function GeneralPanel({ settings, draft, update, error }: Props) {
  const env = settings.environment
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
        <Toggle
          label="Scan for listening ports"
          description="Show which ports each worktree's processes are listening on. Runs lsof every 10 seconds while the UI is open."
          checked={draft.port_scan_enabled}
          onChange={(e) => { const on = e.currentTarget.checked; update((d) => ({ ...d, port_scan_enabled: on })) }}
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

      <SettingsSection title="Git">
        <Toggle
          label="Background git fetch"
          description={<>Fetches the remotes a worktree's Code tab compares against, while that tab is open. <KeyPath path="git.background_fetch" /></>}
          checked={draft.git.background_fetch}
          onChange={(e) => { const on = e.currentTarget.checked; update((d) => ({ ...d, git: { ...d.git, background_fetch: on } })) }}
        />
        <TextInput
          label="Fetch interval"
          description={<>How often to fetch, as a duration of at least 1m, like <Code>3m</Code>. <KeyPath path="git.fetch_interval" /></>}
          placeholder="3m"
          value={draft.git.fetch_interval}
          disabled={!draft.git.background_fetch}
          onChange={(e) => { const v = e.currentTarget.value; update((d) => ({ ...d, git: { ...d.git, fetch_interval: v } })) }}
          ff="monospace"
        />
      </SettingsSection>
    </Stack>
  )
}
